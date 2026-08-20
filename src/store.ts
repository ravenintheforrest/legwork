// Account state (F5): one JSONL file, one record per account, stage carried on the
// record. Agents return only the records they touched; the runner merges.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Account } from "./types.js";

export function loadAccounts(file = "data/accounts.jsonl"): Account[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Account);
}

export function saveAccounts(accounts: Account[], file = "data/accounts.jsonl"): void {
  mkdirSync(dirname(file), { recursive: true });
  const sorted = [...accounts].sort((a, b) => (a.org < b.org ? -1 : a.org > b.org ? 1 : 0));
  const body = sorted.map((a) => JSON.stringify(a)).join("\n") + (sorted.length ? "\n" : "");
  // Write-then-rename so a crash mid-write cannot truncate the state file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

// Upsert by org. An update replaces the record wholesale: a reducer owns its output and
// must carry prior evidence forward itself.
export function mergeAccounts(state: Account[], updates: Account[]): Account[] {
  const byOrg = new Map(state.map((a) => [a.org, a]));
  for (const update of updates) byOrg.set(update.org, update);
  return [...byOrg.values()];
}
