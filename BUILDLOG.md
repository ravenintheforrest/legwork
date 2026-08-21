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
