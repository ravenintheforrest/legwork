# For agents working in this repo

Read `CLAUDE.md` for build rules and `registry.yaml` for what the fleet is.
This file exists because Expo writes docs "for you and your agents" — so does legwork.

- To add an agent: one entry in `registry.yaml` + one prompt file in `packs/expo/prompts/`.
  See `PLAYBOOK.md` for the non-technical walkthrough.
- To change an agent's prompt: open a PR (rule 4 in CLAUDE.md). `legwork improve <agent>` drafts one.
- State lives in files: `data/accounts.jsonl`, `data/runs.jsonl`, `briefs/`. No hidden state.
- Never touch: `.env`, anything send-side, the golden set labels (humans own ground truth).
