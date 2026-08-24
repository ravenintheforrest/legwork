# legwork

**The fleet does the legwork.** Point it at a product, and it finds the companies running
that product in production — from public evidence only — and hands your sales team a brief
where every sentence carries its source.

Here is a real one, from a live run: legwork searched public GitHub for recent `eas.json`
activity, resolved orgs to companies, pulled homepages and App Store listings, and produced
(excerpt):

> **Pinball Map — account brief**
> org github.com/pinballmap · segment A (mobile-first startup) · confidence 0.60
>
> - eas.json in pinballmap/pbm-react ([source](https://github.com/pinballmap/pbm-react/blob/master/eas.json))
> - react-native 0.86.0 in package.json ([source](https://github.com/pinballmap/pbm-react/blob/master/package.json))
>
> *Suggested opener:* I saw the mobile repo builds with EAS… how are you splitting work
> between OTA updates and full store builds?

Every link resolves. If the model writing a brief cites a URL that is not in the account's
collected evidence, the brief is rejected and falls back to a deterministic template, with
the reason recorded. **No source, no sentence.**

legwork is an evidence-first GTM research system for finding companies that use Expo, qualifying them with inspectable rules, and producing source-backed account briefs. The local fleet console is the primary operator surface: it starts runs, shows health and cost, presents evidence, records human review decisions, runs fixture evaluations, and writes retirement memos.

This is a working prototype, not a claim of production-scale accuracy. Its bundled evaluation is a deterministic fixture regression set: 18 examples, currently 1 human-adjudicated and 17 bootstrap-authored. It does not report live precision, conversion lift, or human brief-quality metrics that have not been measured.

## Run it

Requires Node 22.

```bash
npm ci
npm run dev -- demo
npm run dev -- serve --no-open
```

Open the printed loopback URL. The demo is offline and deterministic: it rebuilds account state and briefs from authored source fixtures, replays captured model responses when request keys match, and falls back to an evidence-only template when they do not.

Useful verification commands:

```bash
npm run typecheck
npm test
npm run selftest
npm run evals
npm run dev -- report
```

`report` writes a static, read-only console to `site/index.html`. `serve` adds local controls to the same page and binds only to `127.0.0.1`. Its API requires a per-process token bootstrapped into the page and validates Host, Origin, fetch-site, and JSON content type.

## How it works day to day

A full run moves one account record through a fixed pipeline:

```text
discover ─┬─ GitHub code search
          ├─ public job posts
          └─ GitLab project search
              ↓
resolve → enrich → dedupe → qualify → intent → people → brief
                                                  ↓
                                      confidence gate
                                      ↙             ↘
                                human review       publish locally
```

Each unit is a small reducer over `Account[]`; the runner owns retries, locking, freshness, merge semantics, cost accounting, and run logs.

- `discover`, `discover-jobs`, `discover-gitlab`: collect candidate accounts and public receipts.
- `resolve`: distinguish organizations from individual accounts and establish canonical identity/domain.
- `enrich`: add company homepage and app-store evidence.
- `dedupe`: merge aliases that resolve to the same company.
- `qualify`: calculate an inspectable weighted score; the model does not calculate it.
- `intent`: add public timing signals such as relevant issues or activity.
- `people`: identify top public contributors. By default it retains professional company/website fields, not location or free-text bio.
- `brief`: use a model when configured, otherwise the deterministic template. Model output is accepted only when required sections are ordered, at least three distinct evidence receipts are present, every URL belongs to the account, and every model-authored claim line has a receipt.

Low-confidence briefs enter `briefs/queue/`. A person approves or rejects them in the console. Approval moves the brief and its decision record into `briefs/`; it does not send anything outside the machine. See [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) for the lifecycle and operator model.

## Fixture mode and live mode

| | Fixture/demo | Live |
|---|---|---|
| Sources | Authored files under `fixtures/` | Public HTTPS APIs and company domains |
| Network | None | Yes |
| Clock | Pinned for byte stability | Current time |
| Cache | Fixture reads | Endpoint-specific expiry (roughly 1–24h) |
| Model | Replay fixture or template fallback | API/CLI model or template fallback |
| State freshness | Demo starts clean | Known accounts refresh after 24h; changed source fingerprints invalidate downstream work |
| Claims | Sample evidence, visibly labeled | Current public evidence, subject to source availability |

### Live request policy

Every live request — GitHub, GitLab, HN, company homepages — goes through one policy layer (`src/http.ts`); fixture mode never reaches it, so the demo stays offline, sleep-free, and byte-deterministic.

| Dial | Default | Override |
|---|---|---|
| Concurrent live requests | 3 | `LEGWORK_HTTP_CONCURRENCY` |
| Steady-state rate (token bucket, burst = 1s of rate) | 5/s | `LEGWORK_HTTP_RPS` |
| Attempts per request (first try included) | 4 | — |
| Backoff | 500ms base, ×2, full jitter, 30s max per sleep | — |
| Total wait per request | 60s, then it fails instead of hanging | — |
| Request timeout | 10s | — |

Retries cover 429, 5xx, and network/timeout errors only. `Retry-After` (seconds or HTTP-date) is honored on 429 and 403; a GitHub primary limit (`x-ratelimit-remaining: 0`) waits for `x-ratelimit-reset` — including on the next request to that host after a successful response reported an empty budget. A 403 with a healthy rate budget and no `retry-after` is a permissions/scope wall, not a limit: it fails immediately and says so. A giving-up error names the host, status, attempt count, and total time waited. Per-run counters (requests, retries, rate-limit hits, wait time) print on the unit's line and land in `data/runs.jsonl` as `http` — absent on fixture runs, which make none.

The CLI loads `.env` without overriding already-set environment variables. `GITHUB_TOKEN` is required only when the live `discover` code-search unit runs. `ANTHROPIC_API_KEY` is optional; without it, briefs use the template. Explicit live-output capture writes only to ignored `data/captures/llm/`; promotion into tracked fixtures is a deliberate review step.

## Reliability and safety properties

- One account-state lock prevents pipeline/review writers from clobbering each other.
- Account writes use unique, permission-restricted temp files, `fsync`, and atomic rename.
- Malformed JSONL lines are reported and skipped so healthy records remain operable.
- Cost accounting survives retries. Crossing a configured ceiling records `killed_cost_ceiling`, stops the fleet, prevents later model calls, and leaves no partial brief batch.
- Homepage and receipt requests reject non-HTTPS URLs, re-check redirects, resolve DNS, refuse private/link-local/reserved addresses, apply timeouts, and cap preview bodies.
- Live model output is never persisted implicitly.
- Retirement math is limited to discovery units, where unique-account attribution is meaningful.
- Generated model prose cannot borrow receipts from the deterministic decision section to pass validation.

## Evaluation: what is and is not measured

`npm run evals` scores deterministic fixture behavior against `packs/expo/golden-set.jsonl` and compares it with a checked-in baseline. This is useful for catching code/prompt regressions; it is not an estimate of live GTM performance. CI separately runs source/test typechecking, the full test suite, self-test, fixture evals, demo, and console generation.

A human holdout protocol and brief-quality rubric live in [docs/HUMAN-EVAL.md](docs/HUMAN-EVAL.md). Results should be reported only after blind human adjudication; no unavailable metric is claimed here.

## What changes with first-party data

Public repos, app-store listings, and job posts identify *hypotheses*, not account truth —
public GitHub skews hobbyist, and production mobile apps mostly live in private repos.
That is the honest ceiling of outside-in data, and it is why the qualification gate exists.
Inside a company the same harness points at product telemetry, billing events, and CRM
stages through the adapter layer (`sources` in `registry.yaml`): the discovery inputs
change; the evaluation, review, cost, and retirement architecture is the part that stays.

## Responsible use

legwork uses public evidence to prioritize research, not to make consequential decisions about people. Keep only fields needed for the GTM task, honor deletion/opt-out requests, verify receipts before outreach, and never treat missing public evidence as evidence of absence. Location and free-text profile bio require explicit `LEGWORK_INCLUDE_PERSONAL_PROFILE_FIELDS=true`; the default omits them. See [SECURITY.md](SECURITY.md).

## Repository map

- `registry.yaml`: units, costs, autonomy, loops, and source configuration
- `packs/expo/`: ICP rubric, prompts, regression set, human-eval schema
- `src/agents/`: stateless pipeline units
- `src/runner.ts`: orchestration, freshness, retries, cost termination
- `src/serve.ts`: local console control plane and receipt proxy
- `data/`: ignored mutable state and quarantined captures
- `briefs/`: ignored generated briefs and review queue
- `fixtures/`: reviewed, tracked offline demo inputs
- `test/`: unit and end-to-end coverage

Current limitations: public-source coverage is biased toward companies with visible engineering activity; the App Store adapter is fixture-only in parts of the pipeline; `doctor` and outcome ingestion remain roadmap work; the human holdout is a structure awaiting adjudicated rows.
