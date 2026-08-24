# improve(brief): The citations gate rejected 0 of 5 briefs and the one human

## rationale

- The citations gate rejected 0 of 5 briefs and the one human decision was an approve, so there is no failure signal to work from. Every edit below is a clarity edit on wording that is already ambiguous, not a response to a recorded miss.
- All 5 briefs ran in `brief_mode: model`, so the model path is the only path the record exercises. The edits stay inside that path and change no rule about what counts as evidence.
- The receipt rule says "Every sentence stating a fact ends with its receipt" but the `## Who to talk to` block asks for bullets, and the `# {{company}} — account brief` title line is a sentence-shaped line with no fact source. Clarified that the receipt rule applies to bullets as well as sentences, and that the title line and headings carry no receipt. This is the rule the gate enforces, so the clarity is worth having even though the gate has not fired.
- The `No evidence yet.` rule and the "one bullet per signal" instruction did not say what to do when a section is a prose section (Who, Why now, Suggested opener) with no evidence. Stated plainly that the same line applies to any of the six blocks. No new behavior, just removes a gap the current wording leaves open.
- The single approved brief carried confidence 0.70, a middling number, and the prompt already forbids recalculating the score. Left that rule untouched and only made explicit that {{confidence}} is context, not something to restate or characterize in prose. One recorded approval is not enough to justify tuning tone or length.
- Kept all seven placeholders spelled exactly as they appear, kept both section headings in order, kept the HTML comment header, and bumped its version marker to v3 to match the file's own convention.

## operating evidence

What the model was given, verbatim. These are the fleet's own records, not a summary of them.

Human review decisions: 1 recorded.
- acceptance rate 100% (1 approved, 0 rejected)
- average confidence: approved 0.70, rejected n/a
- rejected orgs: none

Brief decision records: 5 briefs written.
- brief_mode: model 5
- citations-gate rejections: 0 of 5

## how to land it

```sh
git switch -c improve/brief
cp memos/improve/brief.prompt.md packs/expo/prompts/brief.md
npx tsx src/cli.ts evals        # the regression gate must stay green
git add packs/expo/prompts/brief.md && git commit -m "improve(brief): The citations gate rejected 0 of 5 briefs and the one human"
git push -u origin improve/brief && gh pr create --fill
```

provider replay · model claude-opus-5 · 2 in / 1721 out tokens · $0.0430

*Drafted by `legwork improve` from data/reviews.jsonl and the briefs' decision records.*
*Autonomy tier `propose`: this command writes two files and nothing else. No branch, no commit,*
*no push, no PR. A human runs the commands above, and the evals gate decides.*
