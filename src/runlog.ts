// The run log: one JSON line per agent run, with tokens and dollars (rule 5).
// `status` and `doctor` read it; nothing forks account state into it (F5).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "./types.js";

export function appendRun(record: RunRecord, file = "data/runs.jsonl"): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n");
}

export function readRuns(file = "data/runs.jsonl"): RunRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunRecord);
}
