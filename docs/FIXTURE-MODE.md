# Fixture mode reference

`npm run dev -- demo` rebuilds the ignored account and brief artifacts from the checked-in fixture set. It makes no network calls, pins the clock, and is expected to produce byte-identical account/brief output on repeat runs. The run log is append-only and therefore grows.

Use `npm run dev -- serve --no-open` afterward to inspect the same files in the local console. Fixture banners identify authored sample evidence. This path demonstrates orchestration, evidence, review, cost, and failure behavior; it does not establish live lead quality.
