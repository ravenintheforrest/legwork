// The HITL loop. review.ts hardcodes data/reviews.jsonl and briefs/, so this runs the
// real CLI inside a throwaway working copy with hand-built state — deterministic, and
// independent of how many briefs today's tuning happens to queue.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCli, withWorkingCopy } from "./helpers/env.js";
import { NOW, account, evidence } from "./helpers/fleet.js";
import type { Account } from "../src/types.js";

interface ReviewDecision {
  org: string;
  decision: "approved" | "rejected";
  confidence: number;
  date: string;
}

function seed(dir: string): Account[] {
  const accounts: Account[] = [
    account({
      org: "alpha",
      company: "Alpha",
      stage: "briefed",
      confidence: 0.42,
      evidence: [evidence("uses expo", "https://example.com/alpha")],
      review: { status: "queued", date: NOW },
    }),
    account({
      org: "bravo",
      company: "Bravo",
      stage: "briefed",
      confidence: 0.61,
      evidence: [evidence("uses expo", "https://example.com/bravo")],
      review: { status: "queued", date: NOW },
    }),
    account({ org: "charlie", stage: "qualified", evidence: [] }),
  ];
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(
    join(dir, "data", "accounts.jsonl"),
    accounts.map((a) => JSON.stringify(a)).join("\n") + "\n",
  );
  mkdirSync(join(dir, "briefs", "queue"), { recursive: true });
  for (const org of ["alpha", "bravo"]) {
    writeFileSync(join(dir, "briefs", "queue", `${org}.md`), `# ${org} — account brief\n`);
    writeFileSync(join(dir, "briefs", "queue", `${org}.slack.txt`), `*${org}* queued\n`);
    writeFileSync(join(dir, "briefs", "queue", `${org}.decision.json`), `{"org":"${org}"}\n`);
  }
  return accounts;
}

function accountsIn(dir: string): Map<string, Account> {
  const raw = readFileSync(join(dir, "data", "accounts.jsonl"), "utf8");
  return new Map(
    raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Account)
      .map((a) => [a.org, a]),
  );
}

function reviewsIn(dir: string): ReviewDecision[] {
  const file = join(dir, "data", "reviews.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ReviewDecision);
}

test("approving appends a decision, flips the account, and publishes the brief", async () => {
  await withWorkingCopy((dir) => {
    seed(dir);
    const result = runCli(dir, ["review", "--approve", "alpha"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alpha: approved — brief published/);

    // the brief left the queue
    assert.equal(existsSync(join(dir, "briefs", "queue", "alpha.md")), false);
    assert.equal(existsSync(join(dir, "briefs", "queue", "alpha.slack.txt")), false);
    assert.ok(existsSync(join(dir, "briefs", "alpha.md")));
    assert.ok(existsSync(join(dir, "briefs", "alpha.slack.txt")));

    // the account's review state flipped
    const alpha = accountsIn(dir).get("alpha")!;
    assert.equal(alpha.review?.status, "approved");
    assert.notEqual(alpha.review?.date, NOW, "the decision carries its own timestamp");

    // and the decision is on the append-only ledger
    const reviews = reviewsIn(dir);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.org, "alpha");
    assert.equal(reviews[0]!.decision, "approved");
    assert.equal(reviews[0]!.confidence, 0.42);

    // untouched accounts survive the save
    assert.equal(accountsIn(dir).get("bravo")?.review?.status, "queued");
    assert.ok(accountsIn(dir).has("charlie"));
  });
});

test("rejecting records the decision and leaves the brief out of briefs/", async () => {
  await withWorkingCopy((dir) => {
    seed(dir);
    const result = runCli(dir, ["review", "--reject", "bravo"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bravo: rejected — brief stays out of briefs\//);

    assert.ok(existsSync(join(dir, "briefs", "queue", "bravo.md")), "a rejected brief stays queued on disk");
    assert.equal(existsSync(join(dir, "briefs", "bravo.md")), false);
    assert.equal(accountsIn(dir).get("bravo")?.review?.status, "rejected");
    assert.deepEqual(reviewsIn(dir).map((r) => [r.org, r.decision]), [["bravo", "rejected"]]);
  });
});

test("the ledger is append-only across successive decisions", async () => {
  await withWorkingCopy((dir) => {
    seed(dir);
    assert.equal(runCli(dir, ["review", "--approve", "alpha"]).status, 0);
    assert.equal(runCli(dir, ["review", "--reject", "bravo"]).status, 0);
    assert.deepEqual(
      reviewsIn(dir).map((r) => `${r.org}:${r.decision}`),
      ["alpha:approved", "bravo:rejected"],
    );
    const stats = runCli(dir, ["review", "--stats"]);
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /reviews 2 · approved 1 · acceptance 50% · queued 0/);
  });
});

test("a decision on something that is not queued is refused", async () => {
  await withWorkingCopy((dir) => {
    seed(dir);
    const missing = runCli(dir, ["review", "--approve", "charlie"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no queued brief for "charlie"/);
    assert.deepEqual(reviewsIn(dir), [], "a refused decision records nothing");
    assert.equal(accountsIn(dir).get("charlie")?.review, undefined);
  });
});

test("an empty queue says so instead of hanging on stdin", async () => {
  await withWorkingCopy((dir) => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "accounts.jsonl"), "");
    const result = runCli(dir, ["review"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /review queue is empty/);
  });
});

test("approving without a Slack webhook prints the message instead of posting", async () => {
  await withWorkingCopy((dir) => {
    seed(dir);
    const result = runCli(dir, ["review", "--approve", "alpha"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no SLACK_WEBHOOK_URL/);
    assert.ok(!/posted to Slack/.test(result.stdout));
  });
});
