#!/usr/bin/env node
// `npm run test:sealed` — the hard rule, enforced rather than promised.
//
// Hash data/, briefs/, memos/ and site/, run the whole suite, hash them again, and fail
// if anything moved. A test that writes into the demo's live artifacts is a broken test
// even when it passes.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers/env.js";
import { diffHashes, hashSealedTrees } from "./helpers/treehash.js";

function table(title: string, hashes: Record<string, string>): void {
  console.log(title);
  const width = Math.max(...Object.keys(hashes).map((k) => k.length));
  for (const [tree, hash] of Object.entries(hashes)) {
    console.log(`  ${(tree + "/").padEnd(width + 1)}  ${hash}`);
  }
  console.log("");
}

const TEST_FILES = readdirSync(join(REPO_ROOT, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join("test", f));

const before = hashSealedTrees();
table("sealed trees before:", before);

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2).concat(process.argv.length > 2 ? [] : TEST_FILES)],
  { cwd: REPO_ROOT, stdio: "inherit" },
);

const after = hashSealedTrees();
table("sealed trees after:", after);

const changed = diffHashes(before, after);
if (changed.length > 0) {
  console.error("HARD RULE VIOLATED — the test run mutated live artifacts:");
  for (const line of changed) console.error(`  ${line}`);
  process.exit(1);
}
console.log("sealed: data/, briefs/, memos/ and site/ are byte-identical before and after.");

const status = result.status ?? 1;
if (status !== 0) console.error(`\ntest run exited ${status}`);
process.exit(status);
