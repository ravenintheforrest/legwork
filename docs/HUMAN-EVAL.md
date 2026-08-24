# Human evaluation protocol

The checked-in golden set is a fixture regression suite, not a live-quality benchmark. Use this protocol before publishing human-quality claims.

## Holdout construction

- Sample at least 30 accounts from a live run before reading legwork's verdict or brief.
- Remove exact accounts and aliases present in the authored fixture set.
- Assign opaque IDs and preserve source snapshots/receipt dates.
- Have two reviewers independently label inclusion, segment, and brief quality; adjudicate disagreements.
- Keep the holdout file private when it contains non-public annotations. The tracked JSON schema is `packs/expo/human-holdout.schema.json`.

## Brief rubric

Score each dimension 1–5: evidence correctness, citation coverage, usefulness, specificity, and calibration of uncertainty. A factual claim with no supporting receipt is an automatic citation failure. Record reviewer ID, rubric version, blind condition, notes, and adjudicated result.

Report sample size, selection method, disagreement rate, per-dimension distribution, and confidence intervals. Do not combine bootstrap-authored fixtures with human holdout scores or call fixture regression “accuracy.”
