# Security

"Learn how to protect your API keys" — this repo takes that literally.

- Secrets live in env vars only (`.env`, gitignored; `.env.example` documents every one).
- The only required credential is a fine-grained GitHub PAT with public-repo read scope.
- Adapters never receive credentials for services they don't serve.
- The self-healing loop's autonomy tiers (see `registry.yaml`) hard-exclude credentials: no loop may read, write, or propose changes to secrets.
- Everything the fleet collects is public data. The registry documents excluded sources (Discord, LinkedIn scraping) and why.
