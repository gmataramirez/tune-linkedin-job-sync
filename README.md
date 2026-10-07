# Tune Outdoor LinkedIn Job Sync

Retrieves Tune Outdoor’s public LinkedIn job listings and converts them into JSON for use on the careers page.

Retrieval and JSON generation are implemented. Webflow CMS syncing and public JSON hosting are not yet connected.

## How it works

1. GitHub Actions requests Tune Outdoor’s LinkedIn job search page.
2. `scripts/sync-jobs.mjs` parses the page’s structured JSON-LD data.
3. The script filters listings to Tune Outdoor and identifies each job by its LinkedIn Job ID.
4. It generates `output/jobs.json`.
5. GitHub Actions saves the JSON and original HTML as downloadable artifacts.

No LinkedIn login, API credentials, npm dependencies, or Webflow token are required for the current implementation.

## Repository files

| File | Purpose |
| --- | --- |
| `scripts/sync-jobs.mjs` | Extracts job data from the downloaded HTML and generates JSON |
| `.github/workflows/sync-jobs.yml` | Runs retrieval manually or on a schedule |

## Data source

The workflow retrieves:

https://www.linkedin.com/jobs/search/?f_C=95722057

The `f_C` parameter filters the search to Tune Outdoor’s LinkedIn company ID.

## Running the workflow

1. Open the repository’s **Actions** tab.
2. Select **Retrieve Tune jobs**.
3. Click **Run workflow**.
4. Select `main` and run it.
5. Open the completed run to download its artifacts.

The workflow is also scheduled every six hours, at minute 17:

```yaml
schedule:
  - cron: "17 */6 * * *"
```

GitHub may delay scheduled runs. The workflow must exist on the default branch for the schedule to run.

## Artifacts

| Artifact | Contents | Retention |
| --- | --- | --- |
| `tune-jobs` | Generated `jobs.json` | 7 days |
| `linkedin-response` | Original `tune-jobs.html`, useful for troubleshooting | 3 days |

Artifacts are downloads associated with each workflow run. They do not provide a stable public JSON URL, and generated files are not committed back to the repository.

## JSON format

Example output:

```json
{
  "updatedAt": "2026-10-07T03:36:13.882Z",
  "source": "https://www.linkedin.com/jobs/search/?f_C=95722057",
  "count": 1,
  "jobs": [
    {
      "linkedinJobId": "4469046172",
      "title": "Manufacturing Process Engineer",
      "company": "Tune Outdoor",
      "location": "Denver, CO",
      "employmentType": null,
      "url": "https://www.linkedin.com/jobs/view/manufacturing-process-engineer-at-tune-outdoor-4469046172"
    }
  ]
}
```

`updatedAt` records when the JSON was generated, rather than when LinkedIn updated a listing.

`employmentType` is currently `null` because the search response does not provide that field.

## Failure handling

The workflow fails if the request fails or the parser cannot extract valid Tune Outdoor jobs.

An empty result is treated as a failure pending inspection, rather than proof that all positions have closed. On failure, inspect the workflow logs and the `linkedin-response` artifact.

## Current limitations

- Retrieves only the initial search page; pagination is not implemented.
- Depends on LinkedIn’s public HTML and structured data remaining accessible.
- Successful retrieval does not guarantee the results include every open position.
- Does not retrieve full job descriptions or employment types.
- Does not create, update, publish, or remove Webflow CMS items.
- Does not publish JSON to a public URL.
- Does not retrieve Indeed listings.

## Possible next steps

- Connect the generated data to Webflow CMS, matching items by LinkedIn Job ID.
- Preserve custom editorial fields when updating LinkedIn-sourced fields.
- Alternatively, host `jobs.json` and render job cards using Webflow custom code.
- Add pagination and verified handling for closed positions.
