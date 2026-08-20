# Build log

One entry per working session: date, what happened, why it went that way.

## 2026-08-20 — init
- Name: **legwork** ("the fleet does the legwork"). CLI binary: `legwork`.
- Architecture locked before code: harness owns the loops, agents stay dumb; loops are registry entries with autonomy tiers (fix/propose/human).
- 12-Factor Agents review done. Adopted: stateless-reducer agents (F12), unified account state (F5), errors-compact-into-context for `doctor` (F9), prompts as owned versioned files (F2). Already aligned: small focused agents (F10), harness owns control flow (F8), HITL as tool call (F7).
- Fixtures = authored sample data over real public companies; adapters = the live path. Never shared accounts, only env vars.
- Hosting: GitHub-native (Actions cron + Pages). Cloudflare Workers documented as the production webhook path, not built.
- Research phase artifacts live in the vault hub (fleet-hub-base.html): philosophy from 12 sources, Expo intel, channel map, ICP.
