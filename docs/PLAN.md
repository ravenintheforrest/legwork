# The plan (restated 2026-08-20)

Deliverable: open-source GTM agent fleet + operating harness, demoed to Brenden Song
(Expo, GTM AI Ops) **Monday 2026-08-24 PM**, terminal-first. The objection being answered
is not "can he build" — it's "has he *operated* 25–30 agents." The harness answers it.

## What it does
Expo's funnel problem from the outside: which anonymous developers are companies running
Expo in production? Public data only (CIIAA clean lane).

    discover → resolve → enrich → qualify → intent → brief
                    ↘ dedupe / quality ↙

## Priority stack (not a calendar)
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
