# Security and responsible use

Secrets may be stored in `.env` (gitignored) or the process environment. Existing process variables win over `.env`. `GITHUB_TOKEN` is scoped to live GitHub code discovery; model credentials are optional and used only by the model provider.

The local console binds to `127.0.0.1`. Every `/api/` request requires a random per-process token and valid loopback Host; cross-origin/cross-site requests and non-JSON writes are rejected. Receipt and homepage fetches require HTTPS, validate every redirect, resolve DNS, reject private/link-local/reserved addresses, apply timeouts, and cap response bodies. GitHub authorization is attached only to GitHub API/raw hosts.

Live model responses are not recorded by default. Explicit capture writes permission-restricted files under ignored `data/captures/llm/`; inspect and redact before manually promoting anything into tracked fixtures.

The system collects public professional evidence, but public does not mean consequence-free. Default people enrichment omits location and free-text bio. Use the opt-in only with a documented purpose and retention period. Honor opt-out/deletion requests by removing generated state and captures, avoid sensitive or protected-class inference, verify receipts before use, and never use legwork as the sole basis for a consequential decision about a person.
