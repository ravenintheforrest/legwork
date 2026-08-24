// Saved sessions of live results. A live dataset with real, human-approved leads is the
// most valuable thing this repo produces and the easiest to destroy — one `legwork demo`
// evicts it. So: `legwork save` copies the current world into snapshots/<name>/,
// `legwork restore <name>` puts it back, and the runner banks anything it is about to
// evict into data/backups/ on its own (see runner.ts). Everything here is local and
// gitignored: live accounts and briefs never become checked-in artifacts.
//
// What restore touches, and what it deliberately does not:
//   - accounts.jsonl and briefs/ are restored wholesale — they are the world.
//   - reviews.jsonl is merged, never overwritten: it is an append-only ledger, and a
//     decision made after the snapshot must not vanish because an older world came back.
//   - runs.jsonl is saved for the record but never restored: the log does not go back in time.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotPaths {
  dataDir?: string;
  briefsDir?: string;
  snapshotsDir?: string;
}

interface Resolved {
  data: string;
  briefs: string;
  snapshots: string;
}

function resolve(paths: SnapshotPaths): Resolved {
  return {
    data: paths.dataDir ?? "data",
    briefs: paths.briefsDir ?? "briefs",
    snapshots: paths.snapshotsDir ?? "snapshots",
  };
}

export function runSave(name?: string, paths: SnapshotPaths = {}): string {
  const p = resolve(paths);
  const accounts = join(p.data, "accounts.jsonl");
  if (!existsSync(accounts)) throw new Error(`nothing to save — no ${accounts}`);
  const label = (name ?? "").trim() || defaultName(accounts);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    throw new Error(`snapshot names are letters, digits, dot, dash, underscore (got "${label}")`);
  }
  const dir = join(p.snapshots, label);
  if (existsSync(dir)) throw new Error(`snapshot "${label}" already exists — pick another name or remove ${dir}`);
  mkdirSync(dir, { recursive: true });

  cpSync(accounts, join(dir, "accounts.jsonl"));
  for (const ledger of ["reviews.jsonl", "runs.jsonl"]) {
    const src = join(p.data, ledger);
    if (existsSync(src)) cpSync(src, join(dir, ledger));
  }
  if (existsSync(p.briefs)) cpSync(p.briefs, join(dir, "briefs"), { recursive: true });

  const counts = describeWorld(join(dir, "accounts.jsonl"));
  console.log(`saved snapshot "${label}" → ${dir}`);
  console.log(`  ${counts}`);
  console.log(`restore it later:  legwork restore ${label}`);
  return dir;
}

export function runRestore(name: string, paths: SnapshotPaths = {}): void {
  const p = resolve(paths);
  const dir = join(p.snapshots, name);
  const savedAccounts = join(dir, "accounts.jsonl");
  if (!existsSync(savedAccounts)) throw new Error(`no snapshot "${name}" — see: legwork save --list`);

  // Bank the current world first: a restore must never be the thing that loses data.
  const current = join(p.data, "accounts.jsonl");
  if (existsSync(current)) {
    const bank = join(p.data, "backups", `before-restore-${stamp()}`);
    mkdirSync(bank, { recursive: true });
    cpSync(current, join(bank, "accounts.jsonl"));
    if (existsSync(p.briefs)) cpSync(p.briefs, join(bank, "briefs"), { recursive: true });
    console.log(`current world banked → ${bank}`);
  }

  mkdirSync(p.data, { recursive: true });
  cpSync(savedAccounts, current);
  rmSync(p.briefs, { recursive: true, force: true });
  if (existsSync(join(dir, "briefs"))) cpSync(join(dir, "briefs"), p.briefs, { recursive: true });
  else mkdirSync(p.briefs, { recursive: true });

  // The review ledger is append-only: union, current first, snapshot lines it lacks after.
  const savedReviews = join(dir, "reviews.jsonl");
  if (existsSync(savedReviews)) {
    const currentReviews = join(p.data, "reviews.jsonl");
    const have = existsSync(currentReviews) ? readFileSync(currentReviews, "utf8").split("\n").filter(Boolean) : [];
    const seen = new Set(have);
    const missing = readFileSync(savedReviews, "utf8").split("\n").filter((l) => l && !seen.has(l));
    if (missing.length > 0) writeFileSync(currentReviews, [...have, ...missing].join("\n") + "\n");
    console.log(`review ledger: kept ${have.length} current decision(s), recovered ${missing.length} from the snapshot`);
  }

  console.log(`restored snapshot "${name}"`);
  console.log(`  ${describeWorld(current)}`);
  console.log("runs.jsonl was not touched — the log does not go back in time.");
}

export function runListSnapshots(paths: SnapshotPaths = {}): void {
  const p = resolve(paths);
  if (!existsSync(p.snapshots)) {
    console.log("no snapshots yet — save one:  legwork save demo-day");
    return;
  }
  const names = readdirSync(p.snapshots).filter((n) => existsSync(join(p.snapshots, n, "accounts.jsonl"))).sort();
  if (names.length === 0) {
    console.log("no snapshots yet — save one:  legwork save demo-day");
    return;
  }
  for (const n of names) {
    const at = statSync(join(p.snapshots, n, "accounts.jsonl")).mtime.toISOString().slice(0, 16).replace("T", " ");
    console.log(`${n.padEnd(28)} ${at}  ${describeWorld(join(p.snapshots, n, "accounts.jsonl"))}`);
  }
}

function describeWorld(accountsFile: string): string {
  const lines = readFileSync(accountsFile, "utf8").split("\n").filter(Boolean);
  let companies = 0, briefed = 0, approved = 0, queued = 0;
  let mode: string | null = null;
  for (const line of lines) {
    try {
      const a = JSON.parse(line) as { kind?: string; stage?: string; mode?: string; review?: { status?: string } };
      mode ??= a.mode ?? null;
      if (a.kind === "org") companies++;
      if (a.stage === "briefed") briefed++;
      if (a.review?.status === "approved") approved++;
      if (a.review?.status === "queued") queued++;
    } catch { /* a corrupt line is the caller's problem, not the lister's */ }
  }
  return `${lines.length} lead(s) · ${companies} companies · ${briefed} brief(s) (${approved} approved, ${queued} queued)${mode ? ` · ${mode}` : ""}`;
}

function defaultName(accountsFile: string): string {
  let mode = "world";
  try {
    const first = readFileSync(accountsFile, "utf8").split("\n").find(Boolean);
    mode = first ? ((JSON.parse(first) as { mode?: string }).mode ?? "world") : "world";
  } catch { /* keep the fallback */ }
  return `${mode}-${stamp()}`;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}
