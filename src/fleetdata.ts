// Read-only projections of fleet state for callers that are not the terminal (today: the
// MCP server). Every read goes through the canonical loaders in store/runlog/registry —
// there is one state model (F5) and this file must not become a second parser for it.
// Pure functions, no console output: the caller owns presentation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import type { Account, RunRecord, Segment, Stage } from "./types.js";

// An MCP client spawns the server from whatever cwd it happens to have, so repo files
// resolve against this module's location rather than process.cwd(). Holds for both
// `tsx src/fleetdata.ts` and the compiled dist/fleetdata.js — both sit one level down.
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ACCOUNTS_FILE = join(REPO_ROOT, "data/accounts.jsonl");
const RUNS_FILE = join(REPO_ROOT, "data/runs.jsonl");
const REGISTRY_FILE = join(REPO_ROOT, "registry.yaml");
const BRIEFS_DIR = "briefs";
const QUEUE_DIR = "briefs/queue";
const DAY_MS = 86_400_000;

export interface FindingEvidence {
  claim: string;
  url: string;
}

export interface Finding {
  org: string;
  company?: string;
  domain?: string;
  segment?: Segment;
  confidence?: number;
  stage: Stage;
  review_status?: "queued" | "approved" | "rejected";
  top_evidence: FindingEvidence[];
  brief_path?: string;
}

export interface AgentStat {
  agent: string;
  runs: number;
  ok: number;
  error: number;
  killed_cost_ceiling: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  last_outcome: RunRecord["outcome"];
}

export interface QueuedBrief {
  org: string;
  company?: string;
  confidence?: number;
  brief_path?: string;
}

export interface ReviewQueueView {
  confidence_gate: number;
  queued: QueuedBrief[];
}

/** Every account the pipeline has recorded, as stored. */
export function fleetAccounts(): Account[] {
  return loadAccounts(ACCOUNTS_FILE);
}

/**
 * What the fleet found: accounts that reached qualified or briefed, optionally limited to
 * those touched in the last `sinceDays` days, best confidence first.
 */
export function fleetFindings(sinceDays?: number): Finding[] {
  const cutoff = sinceDays === undefined ? undefined : Date.now() - sinceDays * DAY_MS;
  return fleetAccounts()
    .filter((a) => a.stage === "qualified" || a.stage === "briefed")
    .filter((a) => cutoff === undefined || withinWindow(a.updated, cutoff))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || compare(a.org, b.org))
    .map(toFinding);
}

/** Per-agent totals from the run log — the same numbers `legwork status --costs` prints. */
export function agentStats(): AgentStat[] {
  const byAgent = new Map<string, RunRecord[]>();
  for (const run of readRuns(RUNS_FILE)) {
    const seen = byAgent.get(run.agent);
    if (seen) seen.push(run);
    else byAgent.set(run.agent, [run]);
  }

  const rank = registryOrder();
  return [...byAgent.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || compare(a, b))
    .map(([agent, runs]) => {
      const sum = (pick: (r: RunRecord) => number) => runs.reduce((total, r) => total + pick(r), 0);
      const count = (outcome: RunRecord["outcome"]) => runs.filter((r) => r.outcome === outcome).length;
      return {
        agent,
        runs: runs.length,
        ok: count("ok"),
        error: count("error"),
        killed_cost_ceiling: count("killed_cost_ceiling"),
        tokens_in: sum((r) => r.tokens_in),
        tokens_out: sum((r) => r.tokens_out),
        // Trim float noise from summing many small charges; sub-microdollar precision is
        // below what any pricing table gives us anyway.
        cost_usd: Number(sum((r) => r.cost_usd).toFixed(6)),
        last_outcome: runs[runs.length - 1]!.outcome,
      };
    });
}

/** Briefs parked below the confidence gate, plus the gate they fell under. */
export function reviewQueue(): ReviewQueueView {
  const queued = fleetAccounts()
    .filter((a) => a.review?.status === "queued")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || compare(a.org, b.org))
    .map((a) => ({
      org: a.org,
      company: a.company,
      confidence: a.confidence,
      brief_path: briefPath(a.org),
    }));
  return { confidence_gate: confidenceGate(), queued };
}

/**
 * Where one account's brief lives, repo-relative: briefs/ once published, briefs/queue/
 * while it waits on a human. Undefined means no brief has been written.
 */
export function briefPath(org: string): string | undefined {
  for (const dir of [BRIEFS_DIR, QUEUE_DIR]) {
    const relative = join(dir, `${org}.md`);
    if (existsSync(join(REPO_ROOT, relative))) return relative;
  }
  return undefined;
}

/** The brief markdown itself, or undefined if none has been written. */
export function readBrief(org: string): string | undefined {
  const relative = briefPath(org);
  return relative === undefined ? undefined : readFileSync(join(REPO_ROOT, relative), "utf8");
}

// --- internals --------------------------------------------------------------------

function toFinding(account: Account): Finding {
  return {
    org: account.org,
    company: account.company,
    domain: account.domain,
    segment: account.segment,
    confidence: account.confidence,
    stage: account.stage,
    review_status: account.review?.status,
    top_evidence: account.evidence.slice(0, 3).map((e) => ({ claim: e.claim, url: e.url })),
    brief_path: briefPath(account.org),
  };
}

// An unparseable `updated` stays in the window: a malformed timestamp is a bug to see,
// not a reason to hide an account from the operator.
function withinWindow(updated: string, cutoff: number): boolean {
  const at = Date.parse(updated);
  return Number.isNaN(at) || at >= cutoff;
}

// Agent order is registry order (the fleet is config, not code); agents with runs but no
// registry entry — one-off harness runs — sort after, alphabetically.
function registryOrder(): (agent: string) => number {
  const names = Object.keys(loadRegistry(REGISTRY_FILE).agents);
  return (agent) => {
    const index = names.indexOf(agent);
    return index === -1 ? names.length : index;
  };
}

// Same source of truth as the brief agent's gate: loops.review.confidence_gate (rule 8).
function confidenceGate(): number {
  const loops = loadRegistry(REGISTRY_FILE).loops as Record<string, Record<string, unknown>>;
  const raw = loops.review?.confidence_gate;
  return typeof raw === "number" ? raw : 0.8;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
