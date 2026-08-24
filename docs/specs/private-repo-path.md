# The private-repo path — reaching the companies the ICP is actually made of

**Status:** shipped 2026-08-23 — §1, §2 (owner's call: yes), §3 (discover-issues added as a third source; ATS boards + Remotive inside discover-jobs; resolve by homepage and by name).

## Why
First live run, 90-day window: 57 leads → 10 companies → 2 briefs. Reading `qualify.ts` explains it:
`qualified = eas.json present in a public repo && score ≥ 0.55 && not a person`. The companies
Expo monetizes keep their app repo private, so on the live path they can never pass the gate —
however many job posts name EAS, however big their app is. Public code search finds hobbyists
(24 of the 57 were individuals); the job channel finds companies but they die at *discovered*
because resolution needs a GitHub org. The harness measured all of this correctly; the sources
and the gate were built for the repo-visible world.

## 1. Live App Store signals — shipped
`itunes.apple.com/search` is public and keyless. Strict match (seller site == domain, or seller
name == company after legal suffixes). Rating count → `store_review_volume`; last ship date →
`store_update_cadence` (the API has no release history; the claim says "last shipped on",
not "N releases"). Fixtures unchanged. Effect on the live set: Pinball Map 0.50 → 0.63, briefed.

## 2. Production evidence from the company's own words — needs a decision
Proposal: the gate is **production evidence**, satisfied by either
- `eas.json` in a public repo (as today), or
- a job post **published by the company** that names Expo or EAS (HN "Who is hiring", an
  ATS board post, a public job board). React Native alone is hiring evidence, not production evidence.

Weights (sum stays 1.00; threshold stays 0.55):

| signal | today | proposed | note |
|---|---|---|---|
| production evidence (eas.json **or** Expo/EAS job post) | 0.20 | 0.20 | the gate, either source |
| hiring_signal (RN/Expo hiring, any public job source) | 0.10 | 0.20 | budget evidence |
| rn_version_recency | 0.10 | 0.05 | repo-only |
| ci_config | 0.10 | 0.05 | repo-only |
| team_size_signals | 0.10 | 0.10 | |
| repo_activity | 0.15 | 0.15 | repo-only |
| store_review_volume | 0.10 | 0.10 | now live |
| store_update_cadence | 0.10 | 0.10 | now live |
| regulated_industry | 0.05 | 0.05 | |

Arithmetic, so the trade is visible:
- Job-only company, app with ≥1k ratings shipped ≤30 days: 0.20 + 0.20 + 0.05 + 0.10 = **0.55 → brief**.
- Job-only company, no app found: 0.40 → hold (correct: no scale evidence yet).
- Pinball Map (repo path, no job post): 0.20 + 0.05 + 0.05 + 0.15 + 0.025 + 0.10 = **0.575 → still brief** (was 0.63).
- A repo account scoring exactly 0.55 today from rn + ci (e.g. ReferendumCitoyen) may drop to
  0.45–0.50 → hold. That is the cost: repo-only accounts with no store presence and no hiring
  lose a little; they were the thinnest briefs anyway.

Cost of saying yes: scoring changes, so the replay fixtures (9 briefs) and the evals baseline
must be re-captured (`LEGWORK_LLM=cli legwork demo --capture-llm`, then `legwork promote`,
then `legwork evals --update-baseline`). Roughly an hour, a few dollars of model time.

## 3. `discover-ats` and resolution without GitHub
- **Boards** (Greenhouse / Lever / Ashby): public JSON per company board, keyless. Read only
  boards we have an exact slug for — from a careers link `enrich` found or a job-post link
  — never guessed from a name (slug collisions would put another company's jobs on a
  receipt). Attach RN/Expo postings as evidence: production evidence (if it names Expo/EAS),
  hiring evidence, and "why now" for the brief.
- **Public job APIs** (Remotive, verified keyless): search "react native" / "expo"; accounts
  keyed by domain when the posting carries the company site, else by name. Same reducer
  contract as `discover-jobs`; measured and retirable like `discover-gitlab`.
- **Resolve by homepage**: a domain-keyed account with no GitHub org is resolved by its own
  homepage (title/description `enrich` already reads) so it proceeds to qualify. Today it
  sits at *discovered* forever.
- Fixture mode: no fixture files for the new unit → fixture world unchanged → demo and
  replays untouched until we choose to author a job-sourced sample company.

## Out of scope
Any paid source; LinkedIn; anything behind a login (rule 9).
