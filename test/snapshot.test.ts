import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRestore, runSave } from "../src/snapshot.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "legwork-snap-"));
  const paths = { dataDir: join(root, "data"), briefsDir: join(root, "briefs"), snapshotsDir: join(root, "snapshots") };
  mkdirSync(join(paths.briefsDir, "queue"), { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(join(paths.dataDir, "accounts.jsonl"), [
    JSON.stringify({ org: "moonpay", kind: "org", stage: "briefed", mode: "live", review: { status: "approved", date: "2026-08-23" }, evidence: [], updated: "x" }),
    JSON.stringify({ org: "cogram", kind: "org", stage: "briefed", mode: "live", review: { status: "queued", date: "2026-08-23" }, evidence: [], updated: "x" }),
  ].join("\n") + "\n");
  writeFileSync(join(paths.dataDir, "reviews.jsonl"), JSON.stringify({ org: "moonpay", decision: "approved", confidence: 0.7, date: "1" }) + "\n");
  writeFileSync(join(paths.dataDir, "runs.jsonl"), "{}\n");
  writeFileSync(join(paths.briefsDir, "moonpay.md"), "# MoonPay — account brief\n");
  writeFileSync(join(paths.briefsDir, "queue", "cogram.md"), "# Cogram — account brief\n");
  return paths;
}

test("snapshot: save → destroy → restore brings back accounts and briefs; the review ledger merges, the run log stays", () => {
  const paths = world();
  runSave("demo-day", paths);
  assert.ok(existsSync(join(paths.snapshotsDir, "demo-day", "accounts.jsonl")));
  assert.ok(existsSync(join(paths.snapshotsDir, "demo-day", "briefs", "queue", "cogram.md")));
  assert.throws(() => runSave("demo-day", paths), /already exists/);
  assert.throws(() => runSave("../evil", paths), /letters, digits/);

  // the demo tramples the world; a decision is made in the fixture world meanwhile
  writeFileSync(join(paths.dataDir, "accounts.jsonl"), JSON.stringify({ org: "beatgig", mode: "fixture", stage: "briefed", evidence: [], updated: "x" }) + "\n");
  writeFileSync(join(paths.briefsDir, "moonpay.md"), "TRAMPLED");
  writeFileSync(join(paths.dataDir, "reviews.jsonl"),
    JSON.stringify({ org: "moonpay", decision: "approved", confidence: 0.7, date: "1" }) + "\n" +
    JSON.stringify({ org: "beatgig", decision: "rejected", confidence: 0.6, date: "2" }) + "\n");
  writeFileSync(join(paths.dataDir, "runs.jsonl"), "{}\n{}\n");

  runRestore("demo-day", paths);
  const accounts = readFileSync(join(paths.dataDir, "accounts.jsonl"), "utf8");
  assert.ok(accounts.includes("moonpay") && accounts.includes("cogram") && !accounts.includes("beatgig"));
  assert.equal(readFileSync(join(paths.briefsDir, "moonpay.md"), "utf8"), "# MoonPay — account brief\n");
  const reviews = readFileSync(join(paths.dataDir, "reviews.jsonl"), "utf8").trim().split("\n");
  assert.equal(reviews.length, 2, "the ledger keeps the decision made after the snapshot");
  assert.equal(readFileSync(join(paths.dataDir, "runs.jsonl"), "utf8"), "{}\n{}\n", "the run log does not go back in time");
  // the pre-restore world is banked, trampled brief included
  const bankRoot = join(paths.dataDir, "backups");
  assert.ok(existsSync(bankRoot));
  assert.throws(() => runRestore("never-saved", paths), /no snapshot/);
});
