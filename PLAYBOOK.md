# Playbook: add an agent without being an engineer

(The Samantha Wen path. Draft — expands during the build.)

1. Open `registry.yaml`. Copy the smallest agent block (`dedupe`). Rename it.
2. Write one sentence in `does:` — what it finds or produces. Name its `output:`.
3. Ask Claude Code: "read CLAUDE.md and registry.yaml, then implement the <name> agent
   the way the existing ones are implemented."
4. Run `legwork evals`. If your agent has no golden labels yet, add 3 hand-checked
   examples to the pack. Green check = it ships. Red = ask Claude to read the eval diff.
5. It's live. `legwork status` shows it; the retirement loop now measures whether it earns its place.
