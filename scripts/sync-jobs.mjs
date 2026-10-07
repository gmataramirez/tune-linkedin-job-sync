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
}

main().catch((error) => {
  console.error(`Job retrieval failed: ${error.message}`);
  process.exitCode = 1;
});
