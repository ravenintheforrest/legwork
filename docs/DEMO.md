# Demo script — Expo show-and-tell (Mon 2026-08-24 PM, ~10 min + Q&A)

Rehearse this twice, verbatim, against a frozen build. Every command below has been run
and produces the stated output. If anything diverges on the day, the fallback is in the
right-hand column — never improvise a fix live.

## Pre-flight (the morning of)
- [ ] `git pull && npm install && npx tsc --noEmit` — clean.
- [ ] `claude -p "ok"` works (CLI auth fresh) — only needed for the optional live beat.
- [ ] `GITHUB_TOKEN` exported (`export GITHUB_TOKEN=$(gh auth token)`).
- [ ] Terminal: large font, dark theme, `cd ~/dev/legwork`, `clear`.
- [ ] Browser tabs ready: repo README · `https://ravenintheforrest.github.io/legwork/` · `briefs/queue/DodoraApp.md` rendered.
- [ ] Run the whole sequence once, then `git status` is clean, then **touch nothing**.

## The spine (in order)

| # | Say | Type | Expect | If it breaks |
|---|---|---|---|---|
| 0 | "Expo already proved agentic PQA works — you built it. The harder problem is operating a growing portfolio. That's what this is." | — | — | — |
| 1 | "The fleet, offline, deterministic — same bytes every run." | `npx tsx src/cli.ts demo` | 8 units tick ✓, 13 accounts, 9 briefs, $0.36 replayed | It can't — it's fixtures. If node dies: `npm install`. |
| 2 | "A brief. Every sentence has a receipt; a model wrote it, over evidence it was handed, nothing else." | open `briefs/partiful.md` | Who / signals / **Who to talk to** / why now / opener, each with `[source]` | Open any other `briefs/*.md`. |
| 3 | "Now the real world, not fixtures." | open `briefs/queue/DodoraApp.md` in the browser, click a receipt | Fabian, 163 commits; links resolve 200 | Show Pinball Map instead; both verified. |
| 4 | "Operating view: what each unit costs, whether it failed, last run." | `npx tsx src/cli.ts status --costs` | table, 9 units, $ per unit | — |
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

## Answers to keep loaded
- **"Why a GTM engineer if everyone here ships?"** Owning the portfolio is a job precisely because building stopped being one: evals, cost, review, retirement, autonomy tiers. Your hiring post says "own and grow the portfolio" — that's an operator's verb.
- **"Isn't this just lead scoring?"** The score is deterministic, explained, and in a file; the model never recalculates it. Reasons about the account, gates on confidence, never thresholds alone.
- **"Public GitHub finds hobbyists."** Yes — on purpose it says so. That's the honest ceiling of outside-in data, and the reason your telemetry matters. The machine distinguishes a thin channel from a broken machine; that's the point.
- **"What would you do first here?"** Point the adapters at signups + EAS usage events; reuse the gate, the evals, the retirement loop. Week one is the golden set with your AE's judgment in it.
- **Vercel numbers if pressed on HITL:** 10 SDRs → 1 QA only after conversion held flat; 6 weeks; ~$1K/yr.
- **Speak his dialect:** silent fails, bounded blast radius, reasons-not-thresholds, builder-not-CRM-admin, v0 ships.

## What not to do
- Don't pitch PQA as an idea — he built it. Pitch the operating layer his posts never mention.
- Don't live-code. Don't fix anything live. Don't say "lead scoring."
- Don't open with Vendr. The terminal is the opener; the career is the footnote.
