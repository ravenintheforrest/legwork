# The plan (restated 2026-08-20)

Deliverable: open-source GTM agent fleet + operating harness, demoed to Brenden Song
(Expo, GTM AI Ops) **Monday 2026-08-24 PM**, terminal-first. The objection being answered
is not "can he build" — it's "has he *operated* 25–30 agents." The harness answers it.

## What it does
Expo's funnel problem from the outside: which anonymous developers are companies running
Expo in production? Public data only.

    discover → resolve → enrich → qualify → intent → brief
                    ↘ dedupe / quality ↙

## Priority stack — REVISED by council verdict 2026-08-20 (supersedes list below)

1. **(a)+(g) as one integrity item — Thu night/Fri.** Wire real Claude calls into `brief`
   (+ ambiguity escalation in qualify where cheap) AND reframe docs honestly: deterministic
   units vs reasoning agents. Zero-LLM-calls is a fatal discovery risk with this reviewer.
   Get ONE real model-written brief generated tonight.
2. **Cache-replay demo mode (new, from council):** record real LLM outputs into the cache;
   demo mode replays them — the demo becomes simultaneously authentic AND unbreakable.
   Recalibrate the golden set/regression gate against model output so the gate gates something.
   Budget prompt iteration for brief QUALITY, not just plumbing — a mediocre model brief is
   worse than a good template one.
3. **(b) `legwork retire` — Sat AM.** Memo from real run data (gitlab: 20 candidates, 0 briefed,
   cost share, unique contribution, keep/modify/merge/retire verdict). The council's consensus
   sleeper: nobody demos killing an agent.
4. **(h) as a build item, across days.** README rewritten concrete-first (a real company, its
   evidence, its brief — before any architecture vocabulary). Two full dress rehearsals.
   Rehearse the failure paths. Recorded-run fallback as insurance.
5. **(e) MCP — README stub now, build ONLY if Sunday noon is boring-stable.** One line:
   "aiden-mcp taught me X; legwork's functions are MCP-shaped by design." Captures the
   callback at 5% of the risk.
6. **Demo climax (new):** show the gate CATCHING something live — the tampered-baseline
   regression exit or a queued low-confidence brief — the harness proving it operates.
**Amendment 2026-08-21 (practitioner feedback, Jake Heenehan / Cyrus AI):** "get as personal
as possible on the good leads" → `people` unit + Who-to-talk-to section (built). "Web app,
then say you can connect to Slack — CLI is not enough" → static fleet console (`legwork
report`, deployed by CI) + Slack webhook adapter (built). This reverses the council's cut of
the status UI on the strength of a comparable-product builder's read plus the first real
reviewer's experience; kept cheap and window-not-cockpit so rehearsal time survives.
CUT to README next-steps (10 min of writing, not 7h of building): (c) status report,
(d) doctor self-heal, (f) synthetic outcome metrics. (d)/(f) are the interviewer's own
territory; imitation invites losing comparisons.

## Original priority stack (superseded, kept for history)
1. **Harness core**: registry loader, runner (concurrency/retry/cache), JSONL run log w/ cost.
2. **discover + resolve** on GitHub; accounts.jsonl state model.
3. **Evals**: golden set (bootstrap from Expo showcase + hand-verify), regression gate.
4. **qualify + brief** (receipts! every claim links evidence) + Slack-shaped output.
5. **HITL review loop** (`legwork review`, acceptance rate per agent).
6. **enrich, intent, dedupe**; discover-gitlab (the designed retirement candidate).
7. **doctor** (self-heal, autonomy tiers) · **improve** (fleet PRs itself) · outcome loop file adapter.
8. **report** (static HTML, zero slop) + GitHub Actions cron + Pages.
9. Flourishes by remaining hours: cost receipts → retirement ceremony → CI red-✗ → ops-brief
   agent → HubSpot adapter → Expo status app (dessert).

## Demo script (~10 min)
1. `legwork run --since 7d` live in terminal. 2. Open a brief; click a receipt.
3. `legwork status --costs`. 4. `legwork evals` → show discover-gitlab failing → `legwork retire` → post-mortem.
5. `legwork improve brief` → the fleet opens a PR on itself. 6. MCP: "what did the fleet find this week?"
7. Close: same harness pointed inside-out at EAS telemetry + Stripe events = the job in the req.

## Answers to keep loaded
- "Why a GTM engineer if everyone ships?" → Owning the portfolio is a job precisely because
  building stopped being one. Evals, cost, retirement, autonomy tiers — that's the role.
- Speak his dialect: silent fails, bounded blast radius, reasons-not-thresholds,
  builder-not-CRM-admin, v0 ships. Never say "lead scoring."
- Vercel numbers if pressed on HITL: 10 SDRs → 1 QA only after conversion held flat; 6 weeks; ~$1K/yr.

## Constraints
Public data only · README is read before the call · repo private until flipped public
(one click) · `legwork demo` must be deterministic and offline-safe.

Research corpus + full context: vault → `05) maker/career/2026 job search/Applications/Expo - GTM Engineer/fleet-hub-base.html`
