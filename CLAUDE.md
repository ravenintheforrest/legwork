# legwork — build rules

A GTM agent fleet plus the harness that operates it: evals, self-healing, retirement,
briefs with receipts. Built for the Expo GTM Engineer show-and-tell (Mon 2026-08-24),
designed to outlive it. Full research + plan: `docs/PLAN.md`.

## The one-sentence thesis
Everyone can build agents now; the differentiated work is **operating** them.
The harness is the product. Agents are cattle; the registry is the ranch.

## Non-negotiable build rules
1. **Harness before agents; cut agents before cutting the harness.** A 4-agent fleet with
   real evals beats a 7-agent fleet without them.
2. **Agents are stateless reducers** (12-Factor F12): `run(input, ctx) -> records`. No hidden
   memory. The brain (`packs/*/brain/`) is explicit input. All state lives in files.
3. **One state model** (F5): an account record carries its pipeline stage
   (discovered → resolved → qualified → briefed); the run log references accounts, never forks state.
4. **Prompts are owned, versioned files** (F2) in `packs/expo/prompts/`. `legwork improve`
   changes them only via PR. Never inline prompts in code.
5. **Cost-per-right-answer**: free/cached sources before paid, cheap models before frontier
   (routing lives in registry.yaml), every run logs tokens + $ to the run log (JSONL).
6. **Receipts**: every claim in a brief links its evidence URL. No source, no sentence.
7. **Errors compact into context** (F9): `legwork doctor` feeds the failing run's log excerpt,
   not the whole transcript.
8. **Autonomy tiers are config** (registry `autonomy_tiers`), never vibes: fix / propose / human.
   Nothing send-side or credential-touching is ever below `human`.
9. **Public data only.** No private data sources, no customer lists, nothing scraped from
   behind a login. Excluded sources (Discord, LinkedIn scraping) stay excluded and documented.
10. **No slop in anything user-facing**: no bento grids, gradient-blob heroes, sparkle icons,
    "It's not X, it's Y", fake numbers, or em-dash-studded AI prose. Terminal-monochrome report.

## Working style
- TypeScript strict, Node LTS, flat files (JSONL/markdown) over databases.
- Boring, readable code; comments only for non-obvious constraints.
- Every session appends a BUILDLOG.md entry: date, what, why.
- Demo insurance: `legwork demo` (seeded, deterministic) must always work offline.

## Commands (target surface)
`legwork run [--since 7d] [--agent x]` · `legwork status [--costs]` · `legwork evals`
· `legwork review` · `legwork show <account>` · `legwork doctor <run>` · `legwork improve <agent>`
· `legwork retire <agent>` · `legwork report` · `legwork demo`
