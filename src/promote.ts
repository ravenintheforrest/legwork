// Promoting a capture is a human-tier action, and this is the command that performs it.
//
// `--capture-llm` writes live model responses to a quarantined directory that is
// gitignored: a real model call must never become a checked-in fixture as a side effect
// of running the fleet. But a quarantine with no exit is a dead end — the offline demo
// would forever fall back to the evidence template. So promotion exists, it is explicit,
// it prints exactly what it is about to change, and a person types the command.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const CAPTURE_DIR = process.env.LEGWORK_CAPTURE_DIR ?? "data/captures/llm";
const REPLAY_DIR = "fixtures/llm";

export interface PromoteOptions {
  apply?: boolean;
  prune?: boolean;
}

export function runPromote(opts: PromoteOptions = {}): void {
  const captures = list(CAPTURE_DIR);
  const existing = new Set(list(REPLAY_DIR));

  if (captures.length === 0) {
    console.log(`no quarantined captures in ${CAPTURE_DIR}`);
    console.log("capture some first:  LEGWORK_LLM=cli npx tsx src/cli.ts demo --capture-llm");
    return;
  }

  const added = captures.filter((f) => !existing.has(f));
  const changed = captures.filter((f) => existing.has(f) && !sameBytes(join(CAPTURE_DIR, f), join(REPLAY_DIR, f)));
  const identical = captures.length - added.length - changed.length;
  // A replay fixture with no matching capture is stale: the request key it answers can no
  // longer be produced, usually because the prompt or the evidence shape moved.
  const orphans = [...existing].filter((f) => !captures.includes(f));

  console.log(`captures ${captures.length}  ·  new ${added.length}  ·  changed ${changed.length}  ·  identical ${identical}`);
  for (const f of added) console.log(`  + ${f}  ${describe(join(CAPTURE_DIR, f))}`);
  for (const f of changed) console.log(`  ~ ${f}  ${describe(join(CAPTURE_DIR, f))}`);
  if (orphans.length > 0) {
    console.log(`\n${orphans.length} replay fixture(s) no longer answer any request the fleet makes:`);
    for (const f of orphans) console.log(`  ? ${f}`);
    console.log(opts.prune ? "  (--prune: these will be removed)" : "  re-run with --prune to remove them");
  }

  if (!opts.apply) {
    console.log(`\ndry run. Nothing was written. Re-run with --apply to promote into ${REPLAY_DIR}.`);
    return;
  }

  mkdirSync(REPLAY_DIR, { recursive: true });
  for (const f of [...added, ...changed]) copyFileSync(join(CAPTURE_DIR, f), join(REPLAY_DIR, f));
  if (opts.prune) for (const f of orphans) rmSync(join(REPLAY_DIR, f), { force: true });

  console.log(`\npromoted ${added.length + changed.length} fixture(s) into ${REPLAY_DIR}${opts.prune && orphans.length ? `, pruned ${orphans.length}` : ""}.`);
  console.log("verify:  npx tsx src/cli.ts demo   (briefs should read model-replay, not template)");
  console.log("these are now checked-in artifacts — commit them deliberately.");
}

function list(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// One line of provenance per fixture, so a promotion is reviewable rather than a leap.
function describe(file: string): string {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { model?: string; text?: string };
    const words = (d.text ?? "").trim().split(/\s+/).length;
    return `${d.model ?? "unknown model"}, ${words} words`;
  } catch {
    return "(unreadable)";
  }
}
