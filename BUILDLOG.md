# Build log

One entry per working session: date, what happened, why it went that way.

## 2026-08-20 — init
- Name: **legwork** ("the fleet does the legwork"). CLI binary: `legwork`.
- Architecture locked before code: harness owns the loops, agents stay dumb; loops are registry entries with autonomy tiers (fix/propose/human).
- 12-Factor Agents review done. Adopted: stateless-reducer agents (F12), unified account state (F5), errors-compact-into-context for `doctor` (F9), prompts as owned versioned files (F2). Already aligned: small focused agents (F10), harness owns control flow (F8), HITL as tool call (F7).
- Fixtures = authored sample data over real public companies; adapters = the live path. Never shared accounts, only env vars.
- Hosting: GitHub-native (Actions cron + Pages). Cloudflare Workers documented as the production webhook path, not built.
- Research phase artifacts live in the vault hub (fleet-hub-base.html): philosophy from 12 sources, Expo intel, channel map, ICP.

## 2026-08-20 — harness core + discover/resolve/qualify/brief + evals (priority stack 1–4)
- Harness first, per rule 1: registry loader (zod, strict on agent entries so typos fail
  loud), sequential runner with retries + per-run cost ceiling kill, JSONL run log with
  tokens and dollars. The runner owns the clock, the meter, and the log — an agent cannot
  forget to bill itself.
- Every external call goes through one fetch layer (`src/gh.ts`) with `fixture` and `live`
  modes; live responses cache in `data/cache/`. Absence of a fixture file expresses a 404,
  so "no eas.json" is authored by not writing a file.
- Fixture cast: authored sample data over real public Expo-using orgs (Partiful, Bounce,
  Goody, incident.io, Brex, Cameo, ZOE, BeatGig, Infinite Red) plus two fictional negatives
  — a person's side project and a stale archived org — so no real company or person carries
  a negative label. `legwork demo` runs the whole pipeline on them: offline, zero
  credentials, byte-identical output run to run (fixture mode pins the clock).
- Evals: golden set rebuilt with 11 `labeled_by: bootstrap` rows over the fixture cast (a
  human hand-verifies later; the expo exclude row keeps its human label). Four metrics
  (discover presence, resolve domain, qualify verdict, qualify segment) against a checked-in
  baseline; any drop exits non-zero. All 1.00 at landing.
- qualify scores exactly the signals in `packs/expo/icp.yaml`; weights and thresholds live
  in `src/agents/qualify.ts` and are the eval contract. Unknown signals score 0 and cite
  nothing — no source, no sentence — rather than guessing.
- brief renders from `account.evidence` only, every claim with its receipt URL, template
  mode deterministic; the model path reads the owned prompt file
  (`packs/expo/prompts/brief.md`, rule 4) behind one LLM interface and slots in when
  ANTHROPIC_API_KEY exists. Slack-shaped variant alongside.
- Built by two parallel implementation agents (code / fixtures) against one written spec;
  scoring cross-checked independently by both before integration, then verified end to end
  (tsc clean, demo determinism diff, eval gate exercised both ways).

## 2026-08-20 — steps 5–6, live mode proven
- HITL review loop: confidence gate (registry `loops.review.confidence_gate: 0.80`) routes
  low-confidence briefs to `briefs/queue/`; `legwork review` (interactive + `--approve/--reject/--stats`)
  logs decisions to `data/reviews.jsonl`. Stats track the approved-vs-rejected confidence gap —
  narrow gap means confidence isn't predicting human judgment.
- Fixture-mode briefs now carry a loud FIXTURE DATA banner (md + slack) so authored evidence
  can never be mistaken for real intelligence on a screen.
- Step-6 agents landed (parallel subagent build, verified independently): enrich (homepage/careers
  via new web fetch layer), dedupe (domain reconciliation, no deletes, no invented evidence),
  intent (EAS/build issues + HN who-is-hiring), discover-gitlab (the retirement candidate).
  Pipeline: discover → discover-gitlab → resolve → enrich → dedupe → qualify → intent → brief.
- Brief regrouped to match spec: signals → company → scale/velocity → why now → opener.
- Evals: six metrics, all 1.00; regression gate holds; demo byte-identical across runs.
- **First live run** (GITHUB_TOKEN): 31 real accounts, 4 briefed, all queued below the gate —
  30-day public-GitHub discovery skews hobbyist, confirming the channel-map thesis that
  production Expo lives in private repos / other channels. Receipts spot-checked: all 200.
- Refine list: evidence-level dedupe in briefs (same eas.json cited at branch + sha URL).

## 2026-08-20 (evening) — council verdict on final scope
- 5-advisor council + anonymized peer review run on the Codex feedback + scope question.
- Verdict: (a) wire real LLM calls fused with (g) honest agent-vs-unit reframe = the one
  integrity item, first; (b) retirement memo = highest-leverage differentiator; (h) README
  concrete-first + two rehearsals = deliverable, not polish; MCP = README stub, build only
  if Sunday is boring-stable; CUT status report, doctor, synthetic outcomes to next-steps.
- New from peer review: cache-replay demo mode (authentic + unbreakable), regression gate
  must be recalibrated against model output, show the gate catching something as the climax.

## 2026-08-21 (late night) — integrity item complete, retire shipped, README rewritten
- LLM providers: SDK / claude-cli (subscription-powered) / replay + recording. 9 fable-tier
  fixture briefs captured; demo replays them byte-identical, offline.
- Citations gate proven by tamper test: uncited URL -> rejected, template fallback, reason
  recorded in decision.json. Provider failures now loud on stderr.
- `legwork retire` ships Codex's memo format; discover-gitlab verdict: RETIRE (0 of 9
  briefs depended on it). Acting on it stays human-tier, by PR.
- README rewritten concrete-first (Pinball Map excerpt before any architecture).
- Second live run (90d window, model briefs on): 32 real accounts, 5 model-written briefs
  over real evidence, all receipts resolve 200, all passed the citations gate, all queued
  below the 0.80 confidence gate — real content for the review-queue demo beat.
- Remaining before Monday: rehearsal script + two dress runs; MCP stub only if stable.

## 2026-08-21 — coding scope closed: improve, MCP, receipt dedupe (three parallel builds)
- `legwork improve <agent>`: reads the fleet's own operating record (review decisions,
  citations-gate rejections — compact, capped, deterministically sorted so the replay
  fixture key is stable), asks the model for a prompt revision via the same provider
  stack as brief, and writes a PR-shaped memo + proposed file to memos/improve/. A
  structural gate rejects revisions that drop placeholders or sections — rejected means
  nothing written. No git/gh execution: `propose` tier lands by human push, and every
  call (including rejected ones) logs tokens + $ to the run log.
- MCP server (src/mcp.ts + src/fleetdata.ts): five read-only tools over the same flat
  files the CLI reads — fleet_findings / fleet_status / account_show / brief_read /
  review_queue. Register: `claude mcp add legwork -- npx tsx src/mcp.ts` (never
  `npm run mcp` as the client command — npm's banner corrupts the stdio protocol).
  Paths resolve against the repo root, so clients can spawn it from anywhere. Proven
  read-only by hashing data/ + briefs/ before and after a full client session.
- Brief receipt dedupe (the live-run refine item): the dedupe key canonicalizes GitHub
  blob/tree URLs, so the same eas.json cited at a branch ref and a commit-sha ref
  renders once; the store's two-claims-one-URL pair still renders twice.
- Determinism hardened: replay-provider latency_ms pinned to 0, so decision.json is now
  byte-identical across demo runs too (was the last source of jitter). registry.yaml
  agent order aligned with the actual pipeline (dedupe before qualify).
- doctor / report / outcome ingestion stay cut per the council verdict — README roadmap.
- Still to capture in the test phase: one live `legwork improve brief --capture-llm`
  response, so demo-mode improve replays like the briefs do.
- Built by three parallel implementation agents against one written spec, verified
  end to end afterward: tsc clean, evals 7/7 at 1.00, demo byte-identical including
  decision records, improve's refusal/replay-miss/gate paths exercised, MCP smoke
  client run against demo data. Coding scope is closed; next phase is refine/test.

## 2026-08-21 (day) — coding scope closed; practitioner feedback enacted; repo public
- Practitioner review (Jake Heenehan, built Cyrus AI): "get personal on the good leads" →
  `people` unit (top contributors + public profiles → Who to talk to; opener addressed to
  a named person about something they shipped). Live result: "Fabian, you have 163 commits
  to DodoraApp/DodoStream…" with receipts. "Web app, then say you can connect to Slack" →
  `legwork report` fleet console (static, CI-deployed to GitHub Pages) + Slack webhook
  adapter (`notify`, and on approve). `review --html` for browser-side judging.
- Cloud session delivered `improve` (fleet PRs itself, propose tier, structural gate),
  the MCP server (5 read-only tools, smoke-tested), receipt dedupe, replay latency pin.
  Merged via isolated worktree; two small conflicts resolved (registry order, roadmap).
- Routing: brief on Opus; frontier model reserved. Fixtures re-captured on Opus (9 cast),
  replay byte-deterministic; live run re-done (32 accounts, 5 briefs with people).
- Repo flipped PUBLIC; non-public-data references scrubbed; Pages enabled — console live at
  https://ravenintheforrest.github.io/legwork/ . CI gate green on every push.
- `improve brief` captured once on Opus; replays offline (memos/improve/).
- Coding scope closed. Next: refine/test — rehearsal script + two dress runs.

## 2026-08-21 (afternoon) — the operator desk, the brain, the drawer, and a test suite
Five parallel Opus workstreams on disjoint files, each verified here before landing.

- **`legwork serve`** — the local operator desk. node:http, no deps, 127.0.0.1 only.
  Same functions the CLI calls, behind buttons: run the fleet with a streaming log,
  approve/reject from the queue, retire a unit, re-run evals, send to Slack. Two landmines
  found and guarded: `runEvals` sets `process.exitCode` on regression (snapshot/restore so
  a regression reports without poisoning the process), and `runPipeline` calls
  `process.exit(1)` on a missing GITHUB_TOKEN in live mode (now a 400). Output capture uses
  AsyncLocalStorage so a concurrent request cannot leak into a run's log.
- **Served-mode console** — the same renderer; static output stays byte-identical, verified
  on frozen copies because concurrent runs contaminated the naive diff.
- **Receipt drawer** — receipts open a right-hand preview instead of a tab
  (ravenhoward.org interaction). Server-side fetch behind a strict host allowlist with
  manual redirect-hop checking; refuses 127.0.0.1, 169.254.169.254, credentials-in-URL,
  and github.com@evil.example.com. Static copy degrades to metadata, zero requests on load.
- **"How it runs" brain panel** — the fleet's config rendered from the real files, with a
  "to change this" path per section. Derives deterministic-vs-model by reading each unit's
  source for `ctx.llm`; detects loop dials by type, not name; two-way drift detection
  between icp.yaml, the registry, and WEIGHTS. **Caught a real bug on first run**: an
  unquoted comma in a YAML flow mapping had silently truncated segment D's ICP tell to
  "one org" and made the rest a junk key. Fixed; swept both configs for the same class.
- **`discover-jobs`** — HN who-is-hiring channel; a salary attached to Expo/RN is budget and
  production evidence in one public signal. New `hiring_signal` at 0.10, funded by trimming
  `eas_json_present` 0.30 → 0.20 (it is already the hard gate, so it was double-counted).
  All nine eval metrics held at 1.00.
- **Tests** — 73 node:test tests, no framework dependency, plus `legwork selftest`
  (15 checks, offline, 1.8s) and `legwork soak`. The suite hashes data/, briefs/, memos/,
  site/ before and after and fails if a byte moved. The citations-gate test drives the real
  agent with a fabricated URL and asserts both rejection and that the URL never ships.
- **Structural finding:** `requestKey` hashes the *filled* prompt, and the brief prompt
  interpolates `qualification_json` — so any scoring change invalidates every LLM replay
  fixture at once. Correct behavior (a replay that no longer matches config would be a
  lie), but it means: **change scoring or prompts → re-capture fixtures.** Done here on Opus.
- Routing: brief on Opus, frontier reserved.

## 2026-08-22 — shared HTTP policy layer (rate limits, backoff, concurrency, budget)
- **The gap:** the fleet had no rate-limit handling at all — no 429/403 detection, no
  `Retry-After`, no backoff, no pacing. The only retry was `MAX_RETRIES = 2` at the *unit*
  level in the runner, which on a rate limit re-runs the whole unit into the same wall.
  It survived only because everything is sequential and the response cache absorbs repeats;
  a wider `--since` or one more unit would have made a live run fail confusingly.
- **`src/http.ts` is the one door.** `gh.ts`, `web.ts` (and therefore `gitlab.ts` and the
  HN client) all go through it. Deliberately one layer, not one copy per client: the
  concurrency cap and token bucket are meaningless if each client owns its own.
- Rate-limit awareness is GitHub-shaped where it matters: `Retry-After` (seconds or
  HTTP-date) on 429 and 403, `x-ratelimit-remaining: 0` + `x-ratelimit-reset` for the
  primary limit, 403 + `retry-after` for the secondary one. A spent budget seen on a
  *successful* response gates the next request to that host until reset, rather than
  spending an attempt to learn what the headers already said.
- **A permissions 403 is not a rate limit.** No `retry-after`, rate budget still healthy →
  fail immediately with "retrying will not help". Retrying a scope problem burns the clock
  and hides the real fix.
- Bounded by construction: 4 attempts, 500ms base, ×2, full jitter, 30s per sleep, and a
  60s total-wait ceiling per request — a `Retry-After: 900` fails fast instead of hanging
  a run for 15 minutes. Retries cover 429, 5xx, and network/timeout only; a 404 is an
  answer, not a failure.
- Defaults: 3 concurrent (`LEGWORK_HTTP_CONCURRENCY`), 5 rps burst 5 (`LEGWORK_HTTP_RPS`).
  Mostly future-proofing — nothing fans out yet — but the caps are real, not aspirational.
- Budget counters (requests, retries, rate-limit hits, wait ms) print on the unit's line
  and land in the run record as `http`. **Omitted when zero**, so fixture runs write the
  exact same bytes they always did and `legwork demo` stays byte-identical.
- Fixture mode never reaches the layer — the clients answer from authored files before a
  request exists. Tested twice over: an exploding-fetch/exploding-sleep client injected
  into all four fixture clients, and a shared-budget delta of zero through the production
  wiring.
- Tests: `test/http.test.ts` (15) on a stub fetch and a fake clock (`test/helpers/clock.ts`),
  so the suite stays offline and finishes in ~180ms. 103 tests sealed, 15 self-checks,
  demo byte-identical across two runs.

## 2026-08-23 (early AM) — first real user test, and what it found
- The owner ran the shakedown checklist. Five items broke; all five fixed:
  - **Root cause behind three of them:** fixture and live accounts shared one state file, so
    a live run inherited the 13-account fixture cast — authored repos, invented maintainers —
    and wrote their briefs beside real ones. Every fixture receipt 404'd; the drawer degraded
    to a bare link; D1/F2 looked broken. Accounts now carry `mode`; entering a mode evicts the
    other's records and deletes their briefs by account name. Verified: 15/15 live receipts 200.
  - Brain panel rewritten for a non-engineer with a sticky TOC; log pane labeled.
- `legwork promote` — the missing exit from Codex's capture quarantine (dry-run default).
- `legwork triggers` — 15 discovered from the repo; four registry schedules honestly marked
  "declared but nothing runs them". Toolbar buttons now say what they do and how long.
- Scheduled live runs: Monday 09:00 ET, opens a PR with a digest; `legwork digest` verb.
- HTTP policy layer (`src/http.ts`): Retry-After, GitHub rate headers read preemptively,
  full-jitter backoff, token bucket 3/5rps, permissions-403 told from rate-limit-403,
  per-run counters in the run record. 103 tests. Demo still deterministic, 0.55s.
- Understand-Anything installed as a Claude Code plugin (user scope) — run `/understand`
  inside `claude` in the repo; `.ua/` not yet gitignored.
- Console redesign explored on a design canvas: direction B (brief as the AE sees it +
  judgment rail) preferred; rebuilt on expo.dev's actual language (pure black, sans numerals,
  outline cards, pill buttons) after the owner correctly called the first pass "vibe coded".
  Verdict in words ("Worth a look") instead of "0.60"; have/don't-have list; Decide later.
  Company profile (logo, employees, funding) wanted — needs an enrichment provider.
- Demo strategy shifted by the owner: live data generated before the call, console-led,
  terminal as the answer to "how do I run it", not the spine. Offline mode is for tests.
- Open: Slack send-side (removed by Codex; restore behind --send?), ATS discovery
  (Greenhouse/Lever/Ashby), port design B into report.ts/reviewhtml.ts, firmographics source.

## 2026-08-23 — console redesign ported: direction B is now what `legwork serve` renders
- The redesign lived only on the design canvas (`design/*.dc.html`); `report.ts` and
  `reviewhtml.ts` still rendered the terminal-flavoured console. Ported in full.
- New `src/briefview.ts`: the account as a person reads it, derived from the record and its
  brief — identity, up to four numbers (parsed from our own claim templates; absent when the
  evidence doesn't carry them, never estimated or fetched), "what we found" as sentences,
  who to talk to, the model's opener as cited runs, a verdict in words ("Ready to send" /
  "Worth a look" / "Thin" — the three bands the pipeline itself acts on), and have /
  couldn't-find from the signals. A missing qualification is "Not scored yet", not a low score.
- Review card (`reviewhtml.ts`): brief column + judgment rail; numbered receipts, one number
  per source per card, every mark opens the drawer; "Send to the AE" / "Not a fit" /
  "Decide later" (records nothing, folds the card, stays in the queue); "See the scoring" and
  "Read the full brief" one click down. Served posts to `/api/review`; static stages as before.
- Overview (`report.ts`): one sentence ("Two companies are waiting on your call."), two
  verbs, four numbers (found / briefs / "2 in 3 you kept" / spent), three start cards that
  are the old toolbar buttons (static copy shows the commands), "It also starts on its own"
  with the trigger list folded under it, and health as sentences with one action each —
  failed last run → run log; a unit with ≥5 runs and zero output → "Read the case to drop
  it" (retire button / memo / command); declared-but-unrun schedules → "Which ones".
  Fleet table and triggers table kept, folded. Panel ids and the `/api/state` contract unchanged.
- Shell: pure black (default) / white, Inter for numbers too, outline cards, pill buttons,
  quiet text tabs, tiny uppercase used once. Existing tokens kept so the brain and trigger
  panels restyle without edits. No Clearbit logos: an external image fetch from the console
  would tell a third party which companies you're reviewing — the initial is enough.
- `undefined/` (Understand-Anything scratch that escaped into the repo root) removed and
  ignored. `.claude/launch.json` added so the desk previews on :4318 (4317 was in use).
- Tests: `test/briefview.test.ts` (4) — 107 sealed, 15 self-checks. Verified in the browser:
  served + static, dark + light, 1280 and 700 wide; fold/reopen, scoring, tab jumps.
- Still open: firmographics (employees, funding, location) need an enrichment source;
  Slack `--send`; ATS discovery; a fresh live dataset before the call.

## 2026-08-23 (late) — the private-repo path, the brain, the guide; first live run read honestly
- First live run: 57 leads → 10 companies → 2 briefs. Read `qualify.ts`: the gate was
  `eas.json in a public repo`, and the store lookup had no live adapter. The ICP keeps the
  app repo private, so the fleet could only brief the repo-visible world. Owner's call:
  no paid sources; change the scoring; "would rather get it working and have lots of leads".
- **Live App Store adapter** (`src/appstore.ts`): Apple's public Search API, strict match on
  seller site or exact seller name; cadence is "last shipped on", never "N releases" (the
  API has no history). Pinball Map 0.50 → 0.63 → briefed the same hour.
- **Scoring** (`docs/specs/private-repo-path.md` §2, now shipped): the gate is
  `production_evidence` — eas.json in a repo, **or** a job post the company published naming
  Expo/EAS, **or** an engineer who lists the company opening an issue on Expo's trackers.
  `hiring_signal` 0.10 → 0.20 out of `rn_version_recency` and `ci_config`. The rounded score
  decides (0.55 is 0.55). Evals: 13/13 verdicts, no regressions; baseline unchanged.
- **discover-issues** (new unit): expo/expo + expo/eas-cli issue authors who list a company
  on their public profile; company field only, never location or bio; first-party skipped.
- **discover-jobs**: HN + Remotive's public search API + a company's own Greenhouse/Lever/
  Ashby board when we hold its exact URL (slugs never guessed). Claims say which of Expo /
  EAS / React Native the post names. `src/jobs.ts` (keyless, cached, tolerant parsers),
  `src/agents/naming.ts` (shared name/domain helpers).
- **resolve without GitHub**: a domain-keyed account resolves by its own homepage; a
  name-keyed one by an org of exactly the same name (legal suffix stripped). Job- and
  issue-sourced companies stop dying at *discovered*.
- **The brain** (`packs/expo/brain/`): company, customer, offer, voice, three personas
  (head of mobile, VP eng, staff RN engineer). Filled into the brief prompt's system block
  (v3) between `<<brain>>` markers with the guard that it is never a fact about the account;
  the opener picks a persona. Rendered whole on "How it runs → What the fleet believes".
- **How it runs** now opens with "How to explain it in five minutes": ten beats — say /
  show / lives in — generated from the same config the page reads (unit count, threshold,
  gate, queue). The rehearsed terminal version stays `docs/DEMO-SCRIPT.md`.
- Console: org location on the card (GitHub org profile, orgs only); "companies found"
  counts companies; a funnel line says where the rest went; wordmark + nav row; the receipt
  drawer persists and swaps; headline is a notification ("2 briefs waiting for your review.").
- Ideas parked in `docs/IDEAS.md`: the Gemini GTM list triaged, nine researched lead sources
  ranked (store-first, Expo issue tracker, TheirStack, Libraries.io, conferences…), the
  watch-unit-without-LinkedIn, personas, the four files. No transcripts in the repo.
- Tests: 117 sealed (appstore, briefview, discover-sources), 15 self-checks, demo
  deterministic. Replay fixtures re-captured through the Claude CLI after the prompt change.
- Later the same night: first live run with the new sources read honestly — 28 companies
  (was 10; 13 from Expo's issue tracker, 6 from job boards) but five with production evidence
  and a store app held at 0.43–0.50. Threshold 0.55 → 0.50 and publish gate 0.80 → 0.70,
  both recorded in DECISIONS.md; evals still 13/13. Prompt v3.1 after the citations gate
  rightly rejected a model "Addressed to … persona" meta line: the persona is used silently.
  Replay fixtures re-captured via the Claude CLI (9 model briefs, ~$0.28 a pass).
- Bugs found by the live run and fixed: `intent` searched `org:<domain>` for homepage-resolved
  accounts (GitHub 422 stopped the run before `brief`); `grnh.se` and link shorteners joined
  the shared-host list; a shared host is never a homepage.
- Final live run of the night (90d): 81 leads → 28 companies → 4 briefs, all queued for review:
  Pinball Map 0.58, TinyCld 0.55 (code search), Bilt Rewards 0.50 (Expo issue tracker), Cogram
  0.50 (job board). Next under the bar: Odin 0.48, DualEntry 0.45, Weee 0.43, Telzio 0.43 — all
  with production evidence, short on store or team signals. The console wakes up on this data.
- Citations gate: a sentence that names an absence ("The evidence does not list a title")
  may stand without a receipt; claims and foreign `[source]` URLs still may not. 118 tests.

## 2026-08-23 (morning) — the console for a reader; web search through the CLI
- Wordmark goes Home. "How it runs" opens with "What this is and how it works", written for
  the person being shown it (ten plain steps: look / file), de-slopped. Receipt marks are
  source glyphs (Apple, GitHub, HN, GitLab, Play, job board, globe), inline SVG. The drawer
  shifts the page left instead of covering it.
- discover-jobs gained a web-search feed: `claude -p --allowedTools WebSearch` finds
  postings across Greenhouse/Lever/Ashby and careers pages; the fleet re-fetches every URL
  (or checks the board's own JSON) and keeps only pages that exist and name the stack. Rides
  LEGWORK_LLM=cli. First live pass: 4 verified postings → 4 new companies (MoonPay 0.70
  briefed and published; Marqeta, 3Pillar, Straight Arrow held), $0.02.
- Citations gate: more absence phrasings ("The evidence contains no …") pass without a
  receipt. `intent` only cites HN hiring posts inside the run's window. 119 tests.

## 2026-08-23 (afternoon) — console v3; the live world becomes a saveable thing
- Console rebuilt around four screens, one job each: **Inbox** (queue list beside one
  account view, keyboard j/k/a/r/l, one line on what the last search changed), **Accounts**
  (every lead, filterable, the same account view, the funnel underneath), **Search** (one
  form — sources, window, CLI briefs, refresh — with a preflight that reads the machine,
  and the last search's facts; the sample replay warns before evicting live data),
  **System** (health, run log, answer key, memos, what starts a run, then the brain pages).
  The three start cards and seven tabs are gone; /v2 keeps the old console.
- Server: /api/preflight; /api/run takes { skip[], refresh, cli }; run summary on status;
  LEGWORK_LLM=cli is set for the duration of a cli-briefs run and restored after.
- `legwork save [name]` / `legwork restore <name>` / `legwork save --list`: the live world
  (accounts, briefs, ledgers) as named local snapshots; restore banks the current world
  first, merges the review ledger, and never rewinds the run log. The runner now banks
  anything it is about to evict into data/backups/ before clearing it. snapshots/ gitignored.
- Also this morning, from the owner's read: wordmark→Home; the guide rewritten for the
  reader; source glyphs on receipts; the drawer makes room; funnel block; Accounts table;
  LIVE badge; scheduled-run workflow fixed (secrets in a step if:); `legwork run --refresh`;
  MoonPay re-briefed by the model; the web-search feed's first pass (4 verified postings,
  MoonPay 0.70 published). 120 tests. Live world saved as snapshot "demo-day".

## 2026-08-23 (night) — the console earns trust: every control tested, three real bugs out
- Company names open the company's own site in the side panel (the receipt proxy already
  allowlists account domains). Approve is honest ("records the decision and publishes the
  brief; nothing sends itself"); the handoff row is Copy brief (Markdown), Copy summary,
  and a real Send to Slack when SLACK_WEBHOOK_URL is set — one press per brief, audited to
  data/sends.jsonl, refused for any host but hooks.slack.com. Accounts gained Export CSV
  and bulk Copy briefs over the current filter. System folds to headings; the contents
  list opens the fold it links to.
- A testbed clone took the full sweep: every tab, key (j/k/a/r/l), filter, fold, drawer,
  form, run, retire, refresh, and /v2. Three real bugs found and fixed:
  1) an unescaped newline in an emitted string killed the console's entire main script
     tag silently — every button dead while the page looked fine. A regression test now
     parses every inline script of both builds (test/console.test.ts).
  2) refreshing panels after a run erased the transcript and status chip; they survive now.
  3) the "last search" summary guessed the run cluster from the last `discover` record and
     read a sources-filtered run as "27 units"; runlog.lastRunCluster walks the actual pass.
- Clipboard buttons need a real user gesture, so they were verified to bind and not throw;
  press them once by hand. 122 tests, 15 self-checks.
- Tinkering moved into the console, without a second source of truth: the brain files get
  an Edit/Save right on System (writes the same .md the repo holds; path pinned to the
  pack's brain/, markdown only, capped), and "The dials" turns the two numbers that decide
  what you see — the qualification bar (now pack config: icp.yaml thresholds.qualify_at,
  read by qualify at run time) and the publish line (registry.yaml). Every Save is one
  validated file write, visible in git diff. Rejections tested: gate 0.99 refused, path
  traversal refused, non-markdown refused.
