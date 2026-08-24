# Console redesign — direction B, ported

**Status:** built 2026-08-23. Design source: `design/ReviewB.dc.html`, `design/Overview.dc.html`
(the canvas the owner reviewed). Code: `src/briefview.ts`, `src/reviewhtml.ts`, `src/report.ts`.

## What / why
The first real user test showed the console read as a dev tool: "0.60" in a headline means
nothing to a GTM person, tables everywhere, command names as buttons. The redesign puts the
brief in front of the reader the way an AE would read it, and says where things stand in a
sentence. The CLI stays the engine; the page stays a view onto the same files.

## Scope
- **Review card** = brief column (identity, four numbers, one sentence on who they are,
  "What we found", "Who to talk to", "Suggested opener") + rail (verdict in words with a bar,
  have / couldn't find, Send to the AE / Not a fit / Decide later, "See the scoring →").
  Score math and the full brief are one click down on the card, not gone.
- **Overview** = headline as a notification ("2 briefs waiting for your review." — not "waiting on your call": a queued brief is not a lead), two verbs, four numbers, three start cards, "It also
  starts on its own" + folded trigger list, health as sentences with one action each, fleet
  table folded.
- **Shell** = expo.dev's actual language: black/white, Inter (numbers too), outline cards,
  pill buttons, quiet tabs. Dark by default, toggle persists.
- Served and static keep the same contract: panel ids, `/api/state`, `/api/review`, the
  static staging bar. Every served button is a command on the static page.

## Rules kept
- No source, no sentence: every number and sentence on the card is an evidence claim or the
  model's cited opener. Numbers the evidence doesn't carry are omitted, never estimated.
- "Decide later" writes nothing. A skip that writes state is not a skip.
- No external image fetches from the console (no Clearbit logos): the page must not tell a
  third party which companies are being reviewed. The initial is the logo.
- Verdict words map to what the pipeline does with a score: ≥ gate "Ready to send",
  ≥ threshold "Worth a look", else "Thin"; no qualification record → "Not scored yet".

## Out of scope
- Firmographics (employees, funding, location) — needs an enrichment provider; a decision,
  not a render. The stat row shows what the fleet actually has.
- Any change to scoring, signals, prompts, or the review decision API.
- Slack send-side.
