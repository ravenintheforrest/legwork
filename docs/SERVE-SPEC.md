# `legwork serve` — the local cockpit (build contract)

One localhost process so the console can *act*, not just show. Same functions the CLI
calls; a second client, not a second control plane.

Framing that must survive: **GitHub Pages = public read-only window · `legwork serve` =
local operator desk · CLI = always works identically (the fallback) · Slack = delivery.**
Autonomy tiers unchanged: nothing auto-mutates, every action is an explicit human click,
`human`-tier items (retire) still end in a PR.

## Shared contract (both workstreams build to this — do not deviate)

Server: plain `node:http`, **no new dependencies**, binds `127.0.0.1` only, default port
`4317` (`--port` to override). Serves the console at `/` and JSON at `/api/*`.
All responses `application/json` except `/`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/` | — | console HTML rendered with `served: true` |
| GET | `/api/state` | — | `{ ok: true, html: { overview, queue, briefs, evals, memos, runs } }` — the six panel innerHTMLs, freshly rendered, for in-place refresh without a page reload |
| POST | `/api/run` | `{ mode: "fixture" \| "live", sinceDays?: number }` | `{ ok: true }` immediately; run proceeds in background. `409 { ok:false, error }` if a run is already active |
| GET | `/api/run/status` | — | `{ running: boolean, lines: string[], startedAt: string \| null, error?: string }` — `lines` is cumulative stdout/stderr of the active or last run |
| POST | `/api/review` | `{ org: string, decision: "approve" \| "reject" }` | `{ ok: true }` or `4xx { ok:false, error }` |
| POST | `/api/retire` | `{ agent: string }` | `{ ok: true, memo: string }` (memo markdown) |
| POST | `/api/evals` | — | `{ ok: true, output: string, regressions: boolean }` — must not exit the process on regression |
| POST | `/api/notify` | `{ org: string }` | `{ ok: true, result: "posted" \| "printed" }` |

Errors: never crash the server; catch, log to stderr, respond `{ ok:false, error }` with a
sane status. Unknown path → 404 JSON.

## Workstream A — server (`src/serve.ts`, `src/cli.ts`)

- `startServer(opts: { port?: number; open?: boolean }): Promise<void>`.
- Reuse existing exports; do not reimplement logic: `runPipeline` (runner), `runReview`
  (review), `runRetire` (retire), `runEvals` (evals), `notifyBrief` (notify),
  `renderConsole` (report — Workstream B provides it; until then import and let tsc guide).
- Run capture: while `/api/run` is active, capture what the pipeline prints. Monkey-patching
  `console.log`/`console.error` for the duration is acceptable **only if** restored in a
  `finally`; a cleaner approach is welcome. Append each line to the active run's `lines`.
- Only one run at a time (409 otherwise). Live mode passes `mode:"live"`, fixture passes
  `mode:"fixture"`; `sinceDays` defaults to 7.
- `runEvals` currently sets a non-zero exit code / may throw on regression — call it so a
  regression is *reported*, never fatal to the server. Capture its printed table as `output`.
- CLI verb: `legwork serve [--port <n>] [--no-open]`, opens the browser by default.
- Print on start: the URL, "read-only pages build unaffected", and Ctrl-C to stop.

## Workstream B — client (`src/report.ts`, `src/reviewhtml.ts`)

- Split rendering from writing: **`renderConsole(opts?: { served?: boolean }): string`**
  returns the full HTML; `writeConsole()` = `renderConsole({served:false})` written to
  `site/index.html` (byte-identical to today's static output when `served` is false —
  the Pages artifact must not change).
- Also export the six panel bodies individually so `/api/state` can return them:
  **`renderPanels(): { overview, queue, briefs, evals, memos, runs }`** (strings, no wrapper).
- Served mode (`served: true`) adds, inside the existing tabbed shell:
  - A **toolbar** under the tabs: `Run demo` · `Run live (90d)` · `Re-run evals` ·
    `Refresh` — plus a live status chip (idle / running / failed) and a `<pre>` log pane
    that polls `GET /api/run/status` every 700ms while running, then refreshes panels.
  - Review card buttons **POST `/api/review`** and update the card in place (verdict chip,
    fade the card out of the queue) instead of staging to localStorage. The command bar is
    **hidden** in served mode (keep it for static mode — that is the Pages fallback).
  - A `Retire` button on the fleet table row for any unit (POST `/api/retire`), showing the
    returned memo in a `<details>` below the table.
  - A `Send to Slack` button on each published brief (POST `/api/notify`).
  - A small banner at top: `local operator desk — actions run on your machine` so nobody
    confuses it with the public Pages copy.
- Static mode must keep working exactly as now (staging + copy command bar, no toolbar,
  no fetch calls). Guard every fetch behind the served flag.
- Keep the expo.dev visual system: Inter, mono only for numbers/code, light+dark toggle,
  pill tabs, 12px radii. No new fonts, no new colors beyond the existing tokens.

## Definition of done (both)

`npx tsc --noEmit` clean · `npx tsx src/cli.ts report` still writes the byte-identical
static console (compare against the committed one before your change) · `legwork serve`
boots, console loads, demo run streams lines and refreshes panels, a review decision
records to `data/reviews.jsonl` and survives reload, evals returns its table, retire
returns a memo · CLI verbs all still behave identically · no new npm dependencies.
