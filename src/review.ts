// The HITL review loop (F7): a human works the queue that the confidence gate filled.
// Decisions are append-only in data/reviews.jsonl; acceptance rate and edit depth are
// the loop's tracked metrics (registry loops.review.tracks) and feed retirement later.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadAccounts, mergeAccounts, updateAccounts } from "./store.js";
import { withFileLock } from "./filelock.js";
import { parseJsonl } from "./jsonl.js";
import type { Account } from "./types.js";

const REVIEWS_FILE = "data/reviews.jsonl";
const BRIEFS_DIR = "briefs";
const QUEUE_DIR = join(BRIEFS_DIR, "queue");

export interface ReviewDecision {
  org: string;
  decision: "approved" | "rejected";
  confidence: number;
  date: string;
}

export async function runReview(opts: {
  approve?: string;
  reject?: string;
  stats?: boolean;
}): Promise<void> {
  if (opts.stats) return printStats();
  const accounts = loadAccounts();
  const queued = accounts.filter((a) => a.review?.status === "queued");

  if (opts.approve || opts.reject) {
    const org = (opts.approve ?? opts.reject)!;
    const account = queued.find((a) => a.org === org);
    if (!account) throw new Error(`no queued brief for "${org}" (see \`legwork review\`)`);
    decide(account, opts.approve ? "approved" : "rejected");
    console.log(`${org}: ${opts.approve ? "approved — brief published" : "rejected — brief stays out of briefs/"}`);
    return;
  }

  if (queued.length === 0) {
    console.log("review queue is empty — every published brief cleared the confidence gate");
    return;
  }

  console.log(`${queued.length} brief(s) queued below the confidence gate`);
  console.log(`keys: [a]pprove · [r]eject · [v]iew full brief · [s]kip · [q]uit\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    outer: for (const account of queued) {
      const summary = join(QUEUE_DIR, `${account.org}.summary.txt`);
      console.log("─".repeat(60));
      console.log(existsSync(summary) ? readFileSync(summary, "utf8").trim() : `${account.org} (no rendered brief found)`);
      for (;;) {
        const answer = (await rl.question("\n[a]pprove / [r]eject / [v]iew / [s]kip / [q]uit > ")).trim().toLowerCase();
        if (answer === "a") { decide(account, "approved"); break; }
        if (answer === "r") { decide(account, "rejected"); break; }
        if (answer === "s") break;
        if (answer === "q") break outer;
        if (answer === "v") {
          const full = join(QUEUE_DIR, `${account.org}.md`);
          console.log("");
          console.log(existsSync(full) ? readFileSync(full, "utf8") : "(no full brief found)");
          continue;
        }
        console.log(`  ? "${answer}" is not a key here — a, r, v, s, or q. Nothing was decided.`);
      }
      console.log("");
    }
  } finally {
    rl.close();
  }
  printStats();
}

function decide(account: Account, decision: "approved" | "rejected"): void {
  withFileLock("data/.review.lock", () => {
    const date = new Date().toISOString();
    const moved: Array<{ from: string; to: string }> = [];
    try {
      if (decision === "approved") {
        for (const ext of [".md", ".summary.txt", ".decision.json"]) {
          const from = join(QUEUE_DIR, `${account.org}${ext}`);
          const to = join(BRIEFS_DIR, `${account.org}${ext}`);
          if (existsSync(from)) {
            renameSync(from, to);
            moved.push({ from, to });
          }
        }
      }
      const updated: Account = { ...account, review: { status: decision, date } };
      updateAccounts((all) => mergeAccounts(all, [updated]));
      mkdirSync("data", { recursive: true });
      const record: ReviewDecision = { org: account.org, decision, confidence: account.confidence ?? 0, date };
      appendFileSync(REVIEWS_FILE, JSON.stringify(record) + "\n");
    } catch (error) {
      for (const move of moved.reverse()) {
        if (existsSync(move.to)) renameSync(move.to, move.from);
      }
      throw error;
    }
  });
}

export function readReviews(): ReviewDecision[] {
  if (!existsSync(REVIEWS_FILE)) return [];
  return parseJsonl<ReviewDecision>(readFileSync(REVIEWS_FILE, "utf8"), REVIEWS_FILE);
}

function printStats(): void {
  const reviews = readReviews();
  const queued = loadAccounts().filter((a) => a.review?.status === "queued").length;
  if (reviews.length === 0) {
    console.log(`no review decisions yet · ${queued} queued`);
    return;
  }
  const approved = reviews.filter((r) => r.decision === "approved");
  const rate = approved.length / reviews.length;
  const avg = (list: ReviewDecision[]) =>
    list.length === 0 ? "-" : (list.reduce((s, r) => s + r.confidence, 0) / list.length).toFixed(2);
  console.log(`reviews ${reviews.length} · approved ${approved.length} · acceptance ${(rate * 100).toFixed(0)}% · queued ${queued}`);
  console.log(`avg confidence — approved ${avg(approved)} · rejected ${avg(reviews.filter((r) => r.decision === "rejected"))}`);
  // A widening gap between those two averages means the gate threshold is roughly right;
  // a narrow one means confidence is not predicting human judgment — retune qualify.
}
