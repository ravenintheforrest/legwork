# Console-first system walkthrough

legwork separates the control plane from delivery systems. The console is where an operator runs and judges the fleet; generated briefs are local artifacts. A later CRM, email, scheduled brief, or messaging adapter would consume approved artifacts through an explicit human-tier action. Those adapters are not the control plane, and this repository does not implicitly send on approval.

## A normal operating cycle

1. Open `legwork serve`. The browser receives a per-process request token and renders current files.
2. Start a fixture or live run. The runner takes the account-state lock and records each unit's inputs, outputs, duration, tokens, dollars, mode, and outcome.
3. Discovery refreshes public sources. A source fingerprint change resets derived fields; a full live run also refreshes accounts whose last completed refresh is at least 24 hours old.
4. Deterministic units resolve, enrich, deduplicate, and score. Every score contribution points to evidence or says that evidence was not observed.
5. The brief unit prepares the whole batch before writing. A model may synthesize only source-backed claim lines. Invalid output falls back to the deterministic template.
6. High-confidence briefs publish locally. Lower-confidence briefs wait in the console queue beside score math, assumptions, and receipts.
7. A human approves or rejects. The decision is appended to the review ledger; approval moves all three artifacts (`.md`, `.summary.txt`, `.decision.json`) together. Nothing is sent externally.
8. The operator watches acceptance patterns, cost, regression scores, failures, and discovery-unit marginal contribution in the console.

## Evidence and judgment boundaries

Source adapters may record only observed public claims and their original URLs. Qualification is deterministic weighted code. The model arranges supplied evidence but cannot invent receipts or recompute the score. Human judgment remains mandatory for queued briefs, retirement, credentials, deletion, and any future send-side integration.

Fixture mode is an executable story about architecture, not proof of market accuracy. Live mode exercises public sources and freshness behavior, but results still require review because public data is incomplete and can be stale or ambiguous.

## Why the console is the control plane

The console calls the same functions as the CLI and reads the same file-backed state. It is intentionally local: actions are explicit, inspectable, and protected from cross-origin requests. A CRM can own pipeline stages, email can own final delivery, scheduled jobs can initiate approved runs, and a messaging tool can surface approved briefs. Those are edge adapters. Health, evidence, cost, policy, review, and retirement remain centralized in legwork so operational truth does not fragment across interfaces.
