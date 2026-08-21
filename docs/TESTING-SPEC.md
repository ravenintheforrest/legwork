# Testing loop — build contract

The harness claims to make agents trustworthy. It should be able to prove it about itself.

## Two layers

**1. `node:test` suite** (built in — no new dependencies), run by `npm test`.
**2. `legwork selftest`** — one command that exercises the whole system end to end and
prints a green/red summary. This doubles as a demo beat: the fleet tests itself.

## Hard rule: tests never touch the user's data
`data/`, `briefs/`, `memos/`, and `site/` are live artifacts. A test run that mutates them
destroys demo state. Every test that writes must run against a temp directory
(`node:fs.mkdtempSync(join(tmpdir(), "legwork-test-"))`), cleaned up in a `finally`.
Where a module hardcodes a path, add an optional parameter with today's value as the
default rather than changing behavior. If a module cannot be redirected without a real
refactor, note it in your report and skip that test rather than mutating live state.

## What to cover (unit)
- `registry.ts` — valid load; unknown agent key rejected (strict); missing required field
  gives a useful message; `effective()` merges defaults and per-unit overrides.
- `store.ts` — save/load roundtrip; `mergeAccounts` upsert by org; sorted, stable output;
  the write-then-rename crash safety.
- `costs.ts` — ceiling kill throws `CostCeilingError` at the boundary, not before.
- `llm.ts` — `requestKey` is stable for identical requests and differs when the prompt,
  system, or model changes; `ReplayLLM` hit returns the fixture; a miss throws
  `ReplayMissError`; `RecordingLLM` writes a fixture whose key round-trips.
- `brief.ts` — `validateModelBrief`: accepts a well-formed brief; rejects a missing
  required section; rejects fewer than three receipts; **rejects a URL not present in the
  account's evidence** (the citations gate — this is the most important test in the file);
  the fixture banner is injected in fixture mode only.
- receipt-URL canonicalization — branch and commit-sha refs of the same file collapse;
  a non-GitHub URL is returned untouched; the store's two-claims-one-URL pair survives.
- `evals.ts` — the scorer counts correct/total as expected on a small synthetic golden set;
  a score below baseline is reported as a regression.
- `retire.ts` — marginal-contribution math: an agent whose accounts all reach briefs is
  `keep`; one contributing nothing is `retire`; the threshold comes from the registry.
- `review.ts` — a decision appends to the reviews file and flips the account's review state;
  approving moves the brief out of `queue/`.

## What to cover (integration)
- `legwork demo` twice → `data/accounts.jsonl` and every file in `briefs/` byte-identical
  (run in a temp working copy, not the repo's live data).
- The eval gate: tamper the baseline → the command reports a regression and sets a non-zero
  exit code; restore → clean.
- The citations gate end to end: corrupt one LLM replay fixture's URL → that brief falls
  back to the template and `decision.json` records the reason → restore.
- `serve`: boot on an ephemeral port (`:0`), then exercise every endpoint —
  `/api/state` returns six panels, `/api/run` starts a fixture run and `/api/run/status`
  reports completion, a second run mid-flight is 409, review/retire/evals/notify behave,
  unknown path is 404, malformed JSON is 400. Shut the server down cleanly in a `finally`.

## `legwork selftest`
Runs the fast, non-mutating checks plus the integration ones against a temp copy, and
prints a table: check · result · duration. Non-zero exit if anything fails. Keep it under
~60 seconds so it can run before a demo. It must work offline with no credentials.

## Stretch: `legwork soak [--orgs N]`
Exercise the *non-model* units (`discover` → `resolve` → `enrich` → `qualify`) live against
a much wider discovery window, and report what broke: unhandled shapes, missing fields,
rate-limit behavior, unresolvable orgs, crashes. No brief generation, so it costs nothing
but GitHub API calls. Output a markdown report of failure classes with counts and one
example each. This is how the fleet's real-world edges get found before a demo does.

## Definition of done
`npm test` passes from a clean checkout · no test mutates `data/`, `briefs/`, `memos/`, or
`site/` (verify by hashing those trees before and after the full run) · `legwork selftest`
prints a green summary offline in under a minute · `npx tsc --noEmit` clean · no new
dependencies.
