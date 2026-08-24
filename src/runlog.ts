// The run log: one JSON line per agent run, with tokens and dollars (rule 5).
// `status` and `doctor` read it; nothing forks account state into it (F5).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./filelock.js";
import { parseJsonl } from "./jsonl.js";
import type { RunRecord } from "./types.js";

export function appendRun(record: RunRecord, file = "data/runs.jsonl"): void {
  mkdirSync(dirname(file), { recursive: true });
  withFileLock(`${file}.lock`, () => appendFileSync(file, JSON.stringify(record) + "\n"));
}

export function readRuns(file = "data/runs.jsonl"): RunRecord[] {
  if (!existsSync(file)) return [];
  return parseJsonl<RunRecord>(readFileSync(file, "utf8"), file);
}

// The trailing run: walk back from the end while each record is part of the same pass — a
// unit repeats or a gap of more than ten minutes opens, and the cluster is over. Handles
// partial runs (a units-skipped search) that the old "since the last discover" guess did not.
export function lastRunCluster(runs: RunRecord[]): RunRecord[] {
  if (runs.length === 0) return [];
  const GAP_MS = 10 * 60_000;
  const seen = new Set<string>();
  let start = runs.length - 1;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (seen.has(r.agent)) break;
    if (i < runs.length - 1) {
      const next = runs[i + 1]!;
      if (Date.parse(next.started) - (Date.parse(r.started) + r.duration_ms) > GAP_MS) break;
    }
    seen.add(r.agent);
    start = i;
  }
  return runs.slice(start);
}
