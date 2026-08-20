# legwork

**The fleet does the legwork.** A GTM agent fleet — and the harness that operates it:
evals against a hand-labeled golden set, self-healing with bounded autonomy, retirement
decisions made from data, and account briefs where every claim carries its receipt.

Built to answer one question with public data only: *which of the thousands of anonymous
developers using a product are companies running it in production, worth a human's time?*
The included pack answers it for [Expo](https://expo.dev).

    discover → resolve → enrich → qualify → intent → brief
                    ↘ dedupe / quality ↙

## Why a harness
Anyone can ship an agent now. The work that compounds is operating a portfolio of them:
knowing what each costs, whether it still earns its place, what it may do unattended, and
how it gets better. legwork treats that as the product:

- **Evals** — every agent scored against a golden set; regressions fail CI.
- **Loops** — self-heal (`legwork doctor`), review (`legwork review`), improve
  (`legwork improve` — the fleet proposes PRs to its own prompts), retire (`legwork retire`).
- **Receipts** — briefs cite evidence URLs for every sentence; full run transcripts linkable.
- **Cost** — per-run token + dollar accounting; cheap models routed to cheap work.

An agent is one registry entry (see `registry.yaml`); a non-engineer can add one (see `PLAYBOOK.md`).
Design lineage: [12-Factor Agents](https://github.com/humanlayer/12-factor-agents).

*Status: scaffold — build in progress. See `BUILDLOG.md`.*
