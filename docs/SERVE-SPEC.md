# Local console boundary

`legwork serve` is the product-facing control plane over the same functions and files as the CLI. It binds to `127.0.0.1`; the generated Pages console remains read-only.

Endpoints support state refresh, run/run status, review, retirement, fixture evals, and allowlisted receipt previews. All `/api/` requests require the random token embedded in the served page. The server validates loopback Host, same-origin requests when Origin is present, fetch-site, and `application/json` for writes.

Receipt preview is not an open proxy. Initial URLs must be allowlisted HTTPS receipts; every redirect is checked, DNS answers must be public, response size/concurrency/time are bounded, and GitHub credentials are attached only to GitHub API/raw hosts. Approval publishes local artifacts only and has no send-side behavior.
