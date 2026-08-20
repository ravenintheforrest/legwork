# Build log

One entry per working session: date, what happened, why it went that way.

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

## 2026-08-20 — init
- Name: **legwork** ("the fleet does the legwork"). CLI binary: `legwork`.
- Architecture locked before code: harness owns the loops, agents stay dumb; loops are registry entries with autonomy tiers (fix/propose/human).
- 12-Factor Agents review done. Adopted: stateless-reducer agents (F12), unified account state (F5), errors-compact-into-context for `doctor` (F9), prompts as owned versioned files (F2). Already aligned: small focused agents (F10), harness owns control flow (F8), HITL as tool call (F7).
- Fixtures = authored sample data over real public companies; adapters = the live path. Never shared accounts, only env vars.
- Hosting: GitHub-native (Actions cron + Pages). Cloudflare Workers documented as the production webhook path, not built.
- Research phase artifacts live in the vault hub (fleet-hub-base.html): philosophy from 12 sources, Expo intel, channel map, ICP.
