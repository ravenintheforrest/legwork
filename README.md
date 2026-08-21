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
npx tsx src/cli.ts demo       # full pipeline over recorded fixtures, offline, deterministic
npx tsx src/cli.ts serve      # the operator desk on localhost — run, review, retire, evals
npx tsx src/cli.ts selftest   # 15 end-to-end checks, offline, ~2s
npm test                      # 73 tests; proves it never touched your data
```

Everything the desk does is also a verb: `status --costs`, `show <account>`,
`review --stats`, `evals`, `retire <unit>`, `improve <unit>`, `report`, `notify <org>`.

Demo mode replays **real captured model output** from fixtures — authentic and
byte-identical on every run. Live mode needs a `GITHUB_TOKEN`; model briefs need an
`ANTHROPIC_API_KEY`, or set `LEGWORK_LLM=cli` to run on a Claude subscription via the
`claude` CLI instead of per-token billing.

## The pipeline — deterministic where possible, a model only where judgment lives

    discover → resolve → enrich → dedupe → qualify → intent → people → brief
         (deterministic source adapters and entity logic)               (reasoning)

`people` is the "get personal" unit: top contributors to the account's Expo repo and their
public profiles, so the brief gains a **Who to talk to** section and the opener addresses a
named person about something they actually shipped — never an invented detail.

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
- **The fleet PRs itself** — `legwork improve brief` reads the fleet's own operating
  record (human review decisions, citations-gate rejections), has the model draft a
  prompt revision, and writes a PR-shaped memo plus the proposed file. A structural gate
  rejects any revision that drops a placeholder or a section — rejected means nothing
  written, never silently repaired. It runs no git command: `propose` tier means a human
  lands the PR and the evals gate decides.

## Ask the fleet (MCP)

The harness verbs double as MCP tools — `fleet_findings`, `fleet_status`, `account_show`,
`brief_read`, `review_queue` — served read-only over stdio:

```bash
claude mcp add legwork -- npx tsx src/mcp.ts
```

Then ask Claude "what did the fleet find this week?" and it answers from
`data/accounts.jsonl` with the receipts attached.

## Surfaces — terminal operates, browser shows, Slack delivers

- **CLI** is the operator's cockpit and always works: runs, reviews, retirements.
- **`legwork serve`** is the local operator desk — the same functions behind buttons, on
  `127.0.0.1` only. Run the fleet and watch the log stream, approve or reject from the
  queue, retire a unit, re-run evals. A second client, not a second control plane.
- **The console** (`legwork report`) is that same page rendered static — the public,
  read-only copy CI publishes to Pages on every push. Unit health with silent fails made
  loud (a red dot is a unit whose last run did not finish), spend, eval baseline, review
  queue, published briefs, retirement memos, run log, and **how it runs**.
- **Receipts open in a drawer, not a tab.** Click any `[source]` and the source previews
  in place: a GitHub receipt shows the actual `eas.json`, a profile shows the real bio, an
  App Store link shows ratings and last release. Served mode fetches through a strict host
  allowlist (never an open proxy); the static copy degrades to metadata and makes zero
  network requests on load.
- **Slack** is the consumer surface: a brief that clears the gate or gets approved posts
  its short form to an incoming webhook (`legwork notify`, or automatically on approve).
  Without a webhook it prints what it would have sent — never a silent no-op.

### "How it runs" — config as the control surface
The console's last tab renders the fleet's own configuration: every unit with its resolved
model, cost ceiling, and autonomy tier (and whether it is deterministic code or calls a
model — derived from the source, not a hand-kept list); the autonomy tiers as three
columns; the loops and their tuning dials; the ICP signals as weighted bars that shout if
they stop summing to 1.00; the prompts with their version hashes; the golden set's
composition. Every section ends with the exact file and path to change it. On its first
run it caught a real bug: an unquoted comma had silently truncated an ICP segment
description in the YAML.

Decisions staged in the browser become one CLI command you paste. That keeps one control
plane, and it keeps the answer to "what is the system allowed to do on its own?" in a file
you can read (`autonomy_tiers` in `registry.yaml`) rather than in a UI you have to trust.

## What changes with first-party data

Public repos, app-store listings, and job posts identify *hypotheses*, not account truth —
public GitHub skews hobbyist, and production mobile apps mostly live in private repos.
That is the honest ceiling of outside-in data. Inside a company, the same harness points
at product telemetry, billing events, and CRM stages through the adapter layer
(`sources` in `registry.yaml`): the discovery inputs change; the evaluation, review,
cost, and retirement architecture is the part that stays.

## Tests

`npm test` runs 73 tests on `node:test` with no test framework installed. They hash
`data/`, `briefs/`, `memos/`, and `site/` before and after the run and fail if a single
byte moved — a test suite that eats your demo state is worse than none. The most important
one drives the real brief agent with a fabricated URL and asserts the citations gate
rejects it *and* that the URL never appears in any published brief. `legwork selftest` is
the fast subset: 15 checks, offline, no credentials, under two seconds.

## Roadmap

- `legwork doctor` — bounded self-diagnosis from a failed run's compact error (propose-only)
- Outcome ingestion — HubSpot stage adapter joining briefs to pipeline results
- Deeper person research via Exa / Parallel as an adapter behind the same evidence contract

## Repo map

`registry.yaml` — the fleet as config · `packs/expo/` — ICP, prompts, golden set ·
`src/` — harness + units · `fixtures/` — recorded responses for the offline demo ·
`memos/` — retirement memos · `PLAYBOOK.md` — add a unit without being an engineer ·
`SECURITY.md` — how keys are handled · `BUILDLOG.md` — every session, dated, with reasons.

Design lineage: [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) —
small focused agents, owned prompts, unified state, humans contacted through the same
structured channel as everything else.
