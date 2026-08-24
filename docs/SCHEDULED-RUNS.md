# Scheduled runs

A fleet you have to remember to start is a tool. `.github/workflows/scheduled-run.yml`
is what makes this one a fleet.

## What runs, and when

| | |
|---|---|
| Workflow | `.github/workflows/scheduled-run.yml` |
| Schedule | Mondays, `0 13 * * 1` (13:00 UTC = 09:00 America/New_York in EDT, 08:00 in EST) |
| Manual | `workflow_dispatch` with `since_days` (default `30`) and `mode` (`live` \| `fixture`, default `live`) |
| Command | `legwork run --since <since_days>d` — the whole pipeline, all ten units |
| Concurrency | group `scheduled-run`, queued not cancelled: two passes never overlap |
| Timeout | 45 minutes |

Weekly rather than daily because the underlying public signals — `eas.json` pushes, HN
hiring threads, React Native version bumps — do not move faster than that, and a daily
pass would hand a human the same review queue five times. Monday because the output ends
in a queue somebody has to work.

This is **not** `fleet.yml`. That workflow is the CI gate: fixtures only, never a live
source, and its verdict is a statement about the code. Scheduled live work lives here so
a flaky GitHub search can never turn the gate red.

## What it costs

- **GitHub Actions**: one job per week, minutes only. Free on a public repo.
- **Model spend**: `$0.00` as this repo is configured today, because `ANTHROPIC_API_KEY`
  is not set. See the secrets table below.
- **Ceiling if a key is added**: the registry caps each unit per run — `$0.50` by default,
  `$2.00` for `brief` (`registry.yaml` → `defaults.cost_ceiling_usd`, `agents.brief`).
  Crossing a ceiling records `killed_cost_ceiling`, stops the pass, and shows up in the
  digest's failures section.
- **What has actually been measured**: nothing live. No scheduled live run has completed
  yet, so there is no observed weekly dollar figure to quote and none is quoted here.

## What it produces

One markdown digest per run, written by `src/digest.ts` to `digests/YYYY-MM-DD.md`, and:

1. **The job summary** — the digest, verbatim, plus a line stating which model path ran.
2. **A pull request** carrying the digest and nothing else. `data/` and `briefs/` are
   gitignored, so the digest is the only thing that survives the runner.
3. **A Slack message**, one line, only if `SLACK_WEBHOOK_URL` is set.

The digest reports: what ran and what each unit produced, wall time and dollar cost,
account totals by stage and segment, how state changed since the previous run of the same
mode, what is queued for a human with the strongest receipt behind each, and any unit that
failed or hit its cost ceiling. Where a result is thin it says so — how many accounts
resolved to individual GitHub users rather than organizations, whether anything reached a
brief at all — rather than dressing the count up.

Because `data/runs.jsonl` is gitignored, CI starts from an empty run log every week. The
digest falls back to the last committed digest for the run-to-run comparison, reading a
`<!-- legwork-digest {...} -->` marker at the bottom of each file. When neither a prior
run nor a prior digest exists, it says the baseline is missing instead of implying that
every account is a new discovery.

## What a human must do with it

The digest is `human` tier (`registry.yaml` → `autonomy_tiers.human`). Nothing
auto-merges, and nothing in this workflow sends anything outside GitHub.

1. Read the PR. Merge it if the digest is the record you want kept; close it if the run
   was junk. Either way, decide — an unmerged digest is a lost week of history.
2. Work the review queue it names: `legwork review`, or `legwork serve` and the console.
   Approval publishes a brief locally. It still sends nothing.
3. If a unit failed or was killed by its ceiling, that is the week's actual finding. Fix
   it before the next Monday, or the digest will say the same thing again.

## Secrets: which one unlocks what

| Secret | Set? | Effect if absent |
|---|---|---|
| `GITHUB_TOKEN` | Built in, always present | n/a. Used for the fleet's public reads (code search, orgs, contributors) and to push the digest branch and open the PR. |
| `ANTHROPIC_API_KEY` | **Not set in this repo** | The full pipeline still runs. `makeLLM` returns `null`, `brief` receives `llm: null`, and it writes the deterministic evidence-only template: zero tokens, zero dollars, no model prose. Briefs are still written, accounts still hit the confidence gate, and the review queue still fills. The digest and the job summary both say which path ran. |
| `SLACK_WEBHOOK_URL` | Not set | The Slack step is skipped silently. It never fails the job. |

The workflow requests exactly two permissions: `contents: write` to push the digest
branch and `pull-requests: write` to open the PR.

## Repository settings this depends on

- **Settings → Actions → General → Workflow permissions**: "Allow GitHub Actions to create
  and approve pull requests" must be enabled, or `gh pr create` is rejected.
- A PR opened with the built-in `GITHUB_TOKEN` does **not** trigger other workflows, so
  `fleet.yml` will not run on the digest PR. That is fine — the digest is data, not code —
  but do not rely on the gate to check it.
- GitHub delays scheduled workflows under load, worst at the top of the hour. If Monday's
  run consistently drifts more than about twenty minutes, move the cron to `7 13 * * 1`.
  Do not add retries: a late pass is fine, a doubled pass is not.

## Running the digest by hand

`writeDigest()` in `src/digest.ts` reads `data/runs.jsonl`, `data/accounts.jsonl`,
`data/reviews.jsonl`, and the review queue on the account records. It takes an optional
`out` path and returns `{ file, summary }`:

```bash
npx tsx -e "import { writeDigest } from './src/digest.ts'; console.log(writeDigest({ out: '/tmp/digest.md' }).summary)"
```

Point `out` somewhere outside the repo when experimenting. `digests/` is committed.
