# legwork

**The fleet does the legwork.** Point it at a product, and it finds the companies running
that product in production — from public evidence only — and hands your sales team a brief
where every sentence carries its source.

Here is a real one. On its first live run, legwork searched public GitHub for recent
`eas.json` activity, resolved orgs to companies, pulled their homepages and App Store
listings, and produced this (excerpt):

> **Pinball Map — account brief**
> org github.com/pinballmap · segment A (mobile-first startup) · confidence 0.60
>
> - eas.json in pinballmap/pbm-react ([source](https://github.com/pinballmap/pbm-react/blob/master/eas.json))
> - react-native 0.86.0 in package.json ([source](https://github.com/pinballmap/pbm-react/blob/master/package.json))
> - Homepage: "the Pinball Map website and free mobile app will help you find places to play pinball" ([source](https://pinballmap.com/))
>
> *Suggested opener:* I saw the mobile repo builds with EAS… how are you splitting work
> between OTA updates and full store builds?

Every link resolves. If the model writing the brief cites a URL that is not in the
account's collected evidence, the brief is rejected and falls back to a deterministic
template — with the rejection reason recorded. **No source, no sentence.**

The included pack targets [Expo](https://expo.dev); pointing the fleet at another product
means writing a new pack (`packs/`), not new code.

## Try it (no credentials)

```bash
npm install
npx tsx src/cli.ts demo          # full pipeline over recorded fixtures, offline, deterministic
npx tsx src/cli.ts status --costs
npx tsx src/cli.ts show partiful
npx tsx src/cli.ts review        # work the human-review queue
npx tsx src/cli.ts evals         # score every unit against the hand-labeled golden set
```

Demo mode replays **real captured model output** from fixtures — authentic and
byte-identical on every run. Live mode needs a `GITHUB_TOKEN`; model briefs need an
`ANTHROPIC_API_KEY`, or set `LEGWORK_LLM=cli` to run on a Claude subscription via the
`claude` CLI instead of per-token billing.

## The pipeline — deterministic where possible, a model only where judgment lives

    discover → resolve → enrich → dedupe → qualify → intent → brief
         (deterministic source adapters and entity logic)      (reasoning)

Most of these units are ordinary, inspectable software: API calls, caching, validation,
entity resolution, rubric scoring. Calling everything an "agent" would be a vanity metric.
The model appears exactly where the workflow needs judgment — writing the brief's
synthesis and opener — and even there it may only arrange facts the evidence already
contains. The qualification **score belongs to deterministic code**: every decision ships
with its full math (signal × weight = contribution, each with its evidence URL) in a
`.decision.json` beside the brief, and the model is explicitly forbidden from
recalculating it.

## The operating harness — why this exists

Anyone can ship an agent now. The work that compounds is operating a portfolio of them.
legwork treats that as the product:

- **Evals as a regression gate** — every unit scored against a hand-labeled golden set;
  a PR that degrades a score fails. Losing the explanation contract also fails.
- **Human review as config** — briefs below the registry's confidence gate queue for a
  person (`legwork review`); acceptance rate and the approved-vs-rejected confidence gap
  are tracked, because a narrow gap means confidence isn't predicting human judgment.
- **Cost per answer** — every run logs tokens, dollars, duration; cheap models route to
  cheap work (`registry.yaml` sets per-unit models and cost ceilings that kill a run).
- **Evidence-based retirement** — `legwork retire <unit>` writes a memo from run history:
  the original hypothesis, what it cost, what only it produced, how far its output
  traveled, and a verdict. First subject: `discover-gitlab`, hypothesis fairly tested,
  0 of 9 briefs depended on it — **verdict: retire** ([the memo](memos/retire-discover-gitlab.md)).
  Acting on a retirement is human-tier: it happens by PR, not by the command.
- **Bounded autonomy as visible config** — `autonomy_tiers` in `registry.yaml` spells out
  what runs unattended (`fix`), what may only be proposed (`propose` — lands as a PR),
  and what always needs a person (`human`: anything send-side, credentials, retirement).
- **Loud failure** — a unit that can't reach its model or fixture says so on stderr and
  records why in the decision record. Silent degradation is the failure mode this whole
  design is against.

## What changes with first-party data

Public repos, app-store listings, and job posts identify *hypotheses*, not account truth —
public GitHub skews hobbyist, and production mobile apps mostly live in private repos.
That is the honest ceiling of outside-in data. Inside a company, the same harness points
at product telemetry, billing events, and CRM stages through the adapter layer
(`sources` in `registry.yaml`): the discovery inputs change; the evaluation, review,
cost, and retirement architecture is the part that stays.

## Roadmap

- `legwork doctor` — bounded self-diagnosis from a failed run's compact error (propose-only)
- Outcome ingestion — HubSpot stage adapter joining briefs to pipeline results
- Static status report rendered from `data/runs.jsonl`
- MCP server — legwork's functions are MCP-shaped by design (thin wrapper over the CLI verbs)

## Repo map

`registry.yaml` — the fleet as config · `packs/expo/` — ICP, prompts, golden set ·
`src/` — harness + units · `fixtures/` — recorded responses for the offline demo ·
`memos/` — retirement memos · `PLAYBOOK.md` — add a unit without being an engineer ·
`SECURITY.md` — how keys are handled · `BUILDLOG.md` — every session, dated, with reasons.

Design lineage: [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) —
small focused agents, owned prompts, unified state, humans contacted through the same
structured channel as everything else.
