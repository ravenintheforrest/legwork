// Account state (F5): one JSONL file, one record per account, stage carried on the
// record. Agents return only the records they touched; the runner merges.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { withFileLock } from "./filelock.js";
import { parseJsonl } from "./jsonl.js";
import type { Account } from "./types.js";

export function loadAccounts(file = "data/accounts.jsonl"): Account[] {
  if (!existsSync(file)) return [];
  return parseJsonl<Account>(readFileSync(file, "utf8"), file);
}

export function saveAccounts(accounts: Account[], file = "data/accounts.jsonl"): void {
  mkdirSync(dirname(file), { recursive: true });
  const sorted = [...accounts].sort((a, b) => (a.org < b.org ? -1 : a.org > b.org ? 1 : 0));
  const body = sorted.map((a) => JSON.stringify(a)).join("\n") + (sorted.length ? "\n" : "");
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    // Clean up the fixed-name temp used by older releases after a confirmed save.
    try { unlinkSync(`${file}.tmp`); } catch {}
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch {}
  }
}

export function updateAccounts(
  mutate: (accounts: Account[]) => Account[],
  file = "data/accounts.jsonl",
): Account[] {
  return withFileLock(`${file}.lock`, () => {
    const next = mutate(loadAccounts(file));
    saveAccounts(next, file);
    return next;
  });
}

// Upsert by org. An update replaces the record wholesale: a reducer owns its output and
// must carry prior evidence forward itself.
export function mergeAccounts(state: Account[], updates: Account[]): Account[] {
  const byOrg = new Map(state.map((a) => [a.org, a]));
  for (const update of updates) byOrg.set(update.org, update);
  return [...byOrg.values()];
}
