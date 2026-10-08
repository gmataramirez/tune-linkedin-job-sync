import { readFile, mkdir, writeFile, rename } from "node:fs/promises";

const SOURCE = "https://www.linkedin.com/jobs/search/?f_C=95722057";

function* walk(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* walk(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}

function extractJobs(html) {
  const jobs = new Map();
  const scripts = html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  );

  for (const [, attributes, content] of scripts) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(attributes)) {
      continue;
    }

    const document = JSON.parse(content);

    for (const node of walk(document)) {
      const types = [node["@type"]].flat();
      if (!types.includes("ItemList")) continue;

      for (const listing of node.itemListElement ?? []) {
        const company = listing.disambiguatingDescription?.trim();
        if (company?.toLowerCase() !== "tune outdoor") continue;

        const url = new URL(listing.url);

        if (
          url.protocol !== "https:" ||
          !["linkedin.com", "www.linkedin.com"].includes(url.hostname)
        ) {
          throw new Error("Unexpected job URL");
        }

        const match = url.pathname.match(
          /^\/jobs\/view\/[^/]*?(\d+)\/?$/
        );

        if (!match) {
          throw new Error(`Cannot extract LinkedIn job ID: ${listing.url}`);
        }

        const linkedinJobId = match[1];
        const title = listing.name?.trim();
        const location = listing.description?.trim();

        if (!title || !location) {
          throw new Error(`Missing title or location for ${linkedinJobId}`);
        }

        jobs.set(linkedinJobId, {
          linkedinJobId,
          title,
          company,
          location,
          employmentType: null,
          url: `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`,
        });
      }
    }
  }

  if (!jobs.size) {
    throw new Error(
      "No Tune jobs found. Inspect the HTML before treating this as an empty listing."
    );
  }

  return [...jobs.values()].sort((a, b) =>
    a.linkedinJobId.localeCompare(b.linkedinJobId)
  );
}

async function syncToWebflow(jobs) {
  const token = process.env.WEBFLOW_API_TOKEN;
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;

  if (!token || !collectionId) {
    throw new Error(
      "Missing WEBFLOW_API_TOKEN or WEBFLOW_COLLECTION_ID."
    );
  }

  const base = `/collections/${encodeURIComponent(collectionId)}`;

  async function request(path, method = "GET", body) {
    const response = await fetch(`https://api.webflow.com/v2${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Webflow ${method} failed (${response.status}): ${text}`
      );
    }

    return text ? JSON.parse(text) : null;
  }

  // Resolve the actual API slugs from the collection's field names.
  const collection = await request(base);

  function fieldSlug(displayName, expectedType) {
    const field = collection.fields.find(
      (field) =>
        field.displayName.toLowerCase() === displayName.toLowerCase()
    );

    if (!field || field.type !== expectedType) {
      throw new Error(
        `Expected a ${expectedType} field named "${displayName}". ` +
        `Available fields: ${collection.fields
          .map((field) => `${field.displayName} (${field.type})`)
          .join(", ")}`
      );
    }

    return field.slug;
  }

  const fields = {
    position: fieldSlug("Position", "PlainText"),
    location: fieldSlug("Location", "PlainText"),
    url: fieldSlug("Job URL", "Link"),
    linkedinId: fieldSlug("LinkedIn Job ID", "PlainText"),
  };

  // Retrieve every existing CMS item, including additional pages.
  const items = [];
  let offset = 0;

  while (true) {
    const page = await request(
      `${base}/items?limit=100&offset=${offset}`
    );

    items.push(...page.items);
    offset += page.items.length;

    if (offset >= page.pagination.total) break;

    if (!page.items.length) {
      throw new Error("Webflow returned an incomplete item listing.");
    }
  }

  const existingJobs = new Map();

  for (const item of items) {
    const id = String(
      item.fieldData[fields.linkedinId] ?? ""
    ).trim();

    if (!id) continue;

    if (existingJobs.has(id)) {
      throw new Error(
        `Multiple CMS items have LinkedIn Job ID ${id}. ` +
        "Resolve the duplicate before syncing."
      );
    }

    existingJobs.set(id, item);
  }

  for (const job of jobs) {
    let item = existingJobs.get(job.linkedinJobId);

    const fieldData = {
      [fields.position]: job.title,
      [fields.location]: job.location,
      [fields.url]: job.url,
      [fields.linkedinId]: job.linkedinJobId,
    };

    // Leave intentionally archived or drafted existing jobs alone.
    if (item && (item.isArchived || item.isDraft)) {
      console.log(`Skipped draft/archived job: ${job.title}`);
      continue;
    }

    if (!item) {
      const titleSlug = job.title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 100);

      item = await request(`${base}/items`, "POST", {
        isArchived: false,
        isDraft: false,
        fieldData: {
          name: `${job.title} ${job.linkedinJobId}`,
          slug: `${titleSlug || "job"}-${job.linkedinJobId}`,
          ...fieldData,
        },
      });

      existingJobs.set(job.linkedinJobId, item);
      console.log(`Created: ${job.title}`);
    } else {
      const changed = Object.entries(fieldData).some(
        ([key, value]) => item.fieldData[key] !== value
      );

      if (changed) {
        item = await request(`${base}/items/${item.id}`, "PATCH", {
          fieldData,
        });

        console.log(`Updated: ${job.title}`);
      } else {
        console.log(`Unchanged: ${job.title}`);
      }
    }

    // Also recover items whose previous publishing attempt failed.
    const needsPublishing =
      !item.lastPublished ||
      Date.parse(item.lastUpdated) > Date.parse(item.lastPublished);

    if (needsPublishing) {
      await request(`${base}/items/publish`, "POST", {
        itemIds: [item.id],
      });

      console.log(`Published: ${job.title}`);
    }
  }

  console.log("Webflow job sync complete.");
}

async function main() {
  const html = await readFile("tune-jobs.html", "utf8");
  const jobs = extractJobs(html);

  const output = {
    updatedAt: new Date().toISOString(),
    source: SOURCE,
    count: jobs.length,
    jobs,
  };

  await mkdir("output", { recursive: true });
  await writeFile(
    "output/jobs.json.tmp",
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8"
  );
  await rename("output/jobs.json.tmp", "output/jobs.json");

  console.log(`Generated jobs.json with ${jobs.length} job(s)`);

  for (const job of jobs) {
    console.log(`${job.linkedinJobId}: ${job.title} — ${job.location}`);
  }

  await syncToWebflow(jobs);
}

main().catch((error) => {
  console.error(`Job retrieval failed: ${error.message}`);
  process.exitCode = 1;
});
