# Demo script — run of show (~10 min + Q&A)

Rehearse this twice, verbatim, against a frozen build. Every command below has been run
and produces the stated output. If anything diverges on the day, the fallback is in the
right-hand column — never improvise a fix live.

## Pre-flight (the morning of)
- [ ] `npm run dev -- run --since 90d` so the console is on fresh live data; then `npm run dev -- serve` → **How it runs → How to explain it in five minutes** is this script as a page, with the live numbers filled in.
- [ ] `git pull && npm install && npx tsc --noEmit` — clean.
- [ ] `claude -p "ok"` works (CLI auth fresh) — only needed for the optional live beat.
- [ ] `GITHUB_TOKEN` exported (`export GITHUB_TOKEN=$(gh auth token)`).
- [ ] Terminal: large font, dark theme, `cd ~/dev/legwork`, `clear`.
- [ ] Browser tabs ready: repo README · `https://ravenintheforrest.github.io/legwork/` · `briefs/queue/DodoraApp.md` rendered.
- [ ] Run the whole sequence once, then `git status` is clean, then **touch nothing**.

## The spine (in order)

The console version of this spine lives on **How it runs → How to explain it in five minutes** (ten beats: say / show / lives in). Same order; it reads the live config, so its unit count and gate are always current.

| # | Say | Type | Expect | If it breaks |
|---|---|---|---|---|
| 0 | "Everyone can build agents now; the harder problem is operating a growing portfolio. That's what this is." | — | — | — |
| 1 | "The fleet, offline, deterministic — same bytes every run." | `npx tsx src/cli.ts demo` | 11 units tick ✓, 17 accounts, 9 briefs (7 published, 2 queued), $0.28 replayed | It can't — it's fixtures. If node dies: `npm install`. |
| 2 | "A brief. Every sentence has a receipt; a model wrote it, over evidence it was handed, nothing else." | open `briefs/partiful.md` | Who / signals / **Who to talk to** / why now / opener, each with `[source]` | Open any other `briefs/*.md`. |
| 3 | "Now the real world, not fixtures." | open `briefs/queue/DodoraApp.md` in the browser, click a receipt | Fabian, 163 commits; links resolve 200 | Show Pinball Map instead; both verified. |
| 4 | "Operating view: what each unit costs, whether it failed, last run." | `npx tsx src/cli.ts status --costs` | table, 11 units, $ per unit | — |
| 5 | "Trust is a gate, not a vibe — low confidence queues for a human. The gate also rejects a model brief that cites anything outside its evidence." | `npx tsx src/cli.ts review --stats` | acceptance %, queue depth | — |
| 6 | **The climax.** "Watch the harness catch a bad output." | tamper a fixture URL → `demo` → `cat briefs/partiful.decision.json` → restore (see below) | `brief_mode: template`, `reject_reason: uncited URL not in evidence` | Skip if short on time; say it, show the code in `validateModelBrief`. |
| 7 | "Evals are CI. A PR that makes a unit worse fails the build." | `npx tsx src/cli.ts evals` | 9 metrics at 1.00, `no regressions` | Show the green check on the last commit instead. |
| 8 | "Nobody demos killing an agent. This one was a fair hypothesis, tested, and it earned retirement." | `npx tsx src/cli.ts retire discover-gitlab` | memo: 0 of 9 briefs depended on it, **RETIRE**, human-tier to act | `cat memos/retire-discover-gitlab.md`. |
| 9 | "The fleet proposes changes to itself — as a PR. I merge like any contributor." | `npx tsx src/cli.ts improve brief --fixture` | diff of prompt revision, memo with landing commands | `cat memos/improve/brief.md`. |
| 10 | "And Claude can ask it questions." (only if time) | `claude mcp add legwork -- npx tsx src/mcp.ts` then ask "what did the fleet find this week?" | answer from accounts with receipts | Say it's there; show `src/mcp.ts` tool list. |
| 11 | "The console and Slack — because the operator lives in the terminal, but the AE lives in Slack and the CRO wants a window." | open the Pages URL | fleet health dots, queue, memos | local `site/index.html`. |
| 12 | Close: "Public data powered this. Point the same harness at EAS telemetry, Stripe, HubSpot, and the discovery inputs change — the evaluation, review, cost, and retirement architecture is what stays. Building agents is easy now. Operating a portfolio you can trust is the job." | — | — | — |

## The tamper beat, exactly
```bash
f=$(grep -l "Partiful" fixtures/llm/*.json | head -1); cp "$f" /tmp/fx.json
sed -i '' 's#https://github.com/partiful/mobile/blob/main/eas.json#https://evil.example.com/x#' "$f"
npx tsx src/cli.ts demo >/dev/null && python3 -c "import json;d=json.load(open('briefs/partiful.decision.json'));print(d['brief_mode'], '|', d['llm']['reject_reason'])"
cp /tmp/fx.json "$f"; npx tsx src/cli.ts demo >/dev/null   # restore; back to model-replay
```
