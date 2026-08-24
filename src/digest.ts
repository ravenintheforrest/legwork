// The scheduled run's artifact: a markdown digest of the most recent fleet pass, written
// to a committed path so it survives a CI job whose data/ and briefs/ are gitignored.
//
// Two honesty rules drive every number here:
//   1. Nothing is invented. Every figure comes from data/runs.jsonl, data/accounts.jsonl,
//      data/reviews.jsonl, or the review queue on the account records themselves.
//   2. A thin result is reported as a thin result. If discovery resolved mostly individual
//      user accounts, or nothing reached a brief, the digest says the count and stops.
//
// The run log has no pass id — each line is one unit — so passes are reconstructed by
// grouping consecutive records (same mode, no repeated unit, no long gap). That is the
// same shape the runner writes them in.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadRegistry } from "./registry.js";
import { readReviews } from "./review.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import type { Account, Evidence, RunRecord } from "./types.js";

const DEFAULT_DIR = "digests";
const PASS_GAP_MS = 10 * 60_000; // a gap this long between units means a different pass
const TOP_QUEUED = 5;
const MARKER = "legwork-digest";

export interface DigestOptions {
  /** Where to write. Defaults to digests/<run date>.md. */
  out?: string;
}

export interface DigestResult {
  file: string;
  /** One line, suitable as a Slack message body. */
  summary: string;
}

interface Pass {
  records: RunRecord[];
  mode: "live" | "fixture" | "unknown";
  startedMs: number;
  endedMs: number;
}

interface Marker {
  mode?: string;
  run_started?: string;
  accounts?: number;
}

export function writeDigest(opts: DigestOptions = {}): DigestResult {
  const runs = readRuns();
  const accounts = loadAccounts();
  const passes = groupPasses(runs);
  const pass = passes[passes.length - 1];

  const date = (pass ? new Date(pass.startedMs) : new Date()).toISOString().slice(0, 10);
  const file = opts.out ?? join(DEFAULT_DIR, `${date}.md`);

  const body = pass
    ? renderDigest(pass, passes, accounts, date, file)
    : renderEmpty(date);

  mkdirSync(dirname(file) === "" ? "." : dirname(file), { recursive: true });
  writeFileSync(file, body.markdown);
  return { file, summary: body.summary };
}

// --- pass reconstruction ------------------------------------------------------------

/** Consecutive run records grouped into fleet passes, oldest first. Exported for tests. */
export function groupPasses(runs: RunRecord[]): Pass[] {
  const passes: Pass[] = [];
  for (const record of runs) {
    const startedMs = Date.parse(record.started);
    const at = Number.isNaN(startedMs) ? 0 : startedMs;
    const mode = record.mode ?? "unknown";
    const current = passes[passes.length - 1];
    const sameRun =
      current !== undefined &&
      current.mode === mode &&
      !current.records.some((r) => r.agent === record.agent) &&
      at - current.endedMs <= PASS_GAP_MS;
    if (sameRun && current) {
      current.records.push(record);
      current.endedMs = Math.max(current.endedMs, at + record.duration_ms);
    } else {
      passes.push({ records: [record], mode, startedMs: at, endedMs: at + record.duration_ms });
    }
  }
  return passes;
}

// --- rendering ----------------------------------------------------------------------

function renderEmpty(date: string): { markdown: string; summary: string } {
  const markdown = [
    `# legwork digest — ${date}`,
    "",
    "No runs are recorded in `data/runs.jsonl`. Nothing ran, so there is nothing to report.",
    "",
    marker({ mode: "none", run_started: "", accounts: 0 }),
    "",
  ].join("\n");
  return { markdown, summary: `legwork ${date}: no runs recorded — the fleet did not run.` };
}

function renderDigest(
  pass: Pass,
  passes: Pass[],
  accounts: Account[],
  date: string,
  file: string,
): { markdown: string; summary: string } {
  const records = pass.records;
  const wallMs = Math.max(0, pass.endedMs - pass.startedMs);
  const cost = records.reduce((sum, r) => sum + r.cost_usd, 0);
  const tokensIn = records.reduce((sum, r) => sum + r.tokens_in, 0);
  const tokensOut = records.reduce((sum, r) => sum + r.tokens_out, 0);
  const failures = records.filter((r) => r.outcome !== "ok");
  const okCount = records.length - failures.length;

  const gate = confidenceGate();
  const queued = accounts
    .filter((a) => a.review?.status === "queued")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || compare(a.org, b.org));

  const previous = previousSameMode(passes, pass) ?? null;
  const previousDigest = previous ? null : priorDigestMarker(file, pass.mode);

  const lines: string[] = [];
  lines.push(`# legwork digest — ${date}`);
  lines.push("");
  lines.push(
    `**${pass.mode} run** · started ${new Date(pass.startedMs).toISOString()} · ` +
      `${records.length} unit(s), ${okCount} ok · wall ${formatDuration(wallMs)} · ${money(cost)}`,
  );
  lines.push("");

  // --- what ran ---
  lines.push("## What ran");
  lines.push("");
  lines.push("| unit | in | out | outcome | tokens in/out | cost |");
  lines.push("| --- | ---: | ---: | --- | ---: | ---: |");
  for (const r of records) {
    lines.push(
      `| ${r.agent} | ${r.inputs} | ${r.outputs} | ${r.outcome} | ${r.tokens_in}/${r.tokens_out} | ${money(r.cost_usd)} |`,
    );
  }
  lines.push("");
  const missing = expectedUnits().filter((name) => !records.some((r) => r.agent === name));
  if (missing.length > 0) {
    lines.push(`Units in the registry that did not run in this pass: ${missing.join(", ")}.`);
    lines.push("");
  }

  // --- model spend ---
  // Fixture mode never calls a provider: its tokens come from the replay fixtures and its
  // dollars are the registry price of those tokens, not a bill. Saying otherwise would be
  // the exact kind of dressed-up number this digest exists to avoid.
  const hasKey = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
  lines.push("## Model calls");
  lines.push("");
  if (pass.mode === "fixture") {
    lines.push(
      `Fixture mode: ${tokensIn} tokens in and ${tokensOut} out were replayed from ` +
        `\`fixtures/llm\`, and ${money(cost)} is the registry price of those tokens, not a charge. ` +
        `No provider was called.`,
    );
  } else if (tokensOut === 0) {
    lines.push(
      "No model tokens were recorded in this pass, so nothing was billed. Any brief written " +
        "here is the deterministic evidence template, not model prose.",
    );
    lines.push("");
    lines.push(
      hasKey
        ? "`ANTHROPIC_API_KEY` was set, so the model was available and simply was not used — " +
            "either no account reached the `brief` unit, or every brief fell back."
        : "`ANTHROPIC_API_KEY` was not set in the environment that wrote this digest. The " +
            "`brief` unit had no model available and used the evidence-only template. Template " +
            "briefs carry real receipts; they do not carry model-written prose.",
    );
  } else {
    lines.push(`${tokensIn} tokens in, ${tokensOut} tokens out, ${money(cost)} across the pass.`);
  }
  lines.push("");

  // --- accounts ---
  lines.push("## Accounts");
  lines.push("");
  lines.push(`${accounts.length} account record(s) in state now.`);
  lines.push("");
  const stages = tally(accounts.map((a) => a.stage));
  lines.push(`- by stage: ${stages.length ? stages.map(([k, n]) => `${k} ${n}`).join(" · ") : "none"}`);
  const segments = tally(accounts.flatMap((a) => (a.segment ? [a.segment] : [])));
  lines.push(`- by segment: ${segments.length ? segments.map(([k, n]) => `${k} ${n}`).join(" · ") : "none recorded"}`);
  const actions = tally(accounts.flatMap((a) => (a.qualification ? [a.qualification.action] : [])));
  lines.push(
    `- qualification action: ${actions.length ? actions.map(([k, n]) => `${k} ${n}`).join(" · ") : "none scored"}`,
  );
  lines.push("");

  const currentSize = accounts.length;
  if (previous) {
    const before = passEndSize(previous);
    lines.push(
      `Previous ${pass.mode} run in this log entered its final unit with ${before} account ` +
        `record(s); state now holds ${currentSize} (net ${signed(currentSize - before)}).`,
    );
  } else if (previousDigest && typeof previousDigest.accounts === "number") {
    lines.push(
      `No previous ${pass.mode} run survives in this run log (\`data/\` is gitignored, so CI ` +
        `starts empty). The last committed ${pass.mode} digest — ${previousDigest.run_started ?? "date unknown"} — ` +
        `recorded ${previousDigest.accounts} account record(s); this run holds ${currentSize} ` +
        `(net ${signed(currentSize - previousDigest.accounts)}).`,
    );
  } else {
    lines.push(
      `No previous ${pass.mode} run is available to compare against — neither in this run log ` +
        `nor in a committed digest. Every account above is new as far as this digest can tell; ` +
        `that is a missing baseline, not a discovery result.`,
    );
  }
  lines.push("");

  // --- honest read on thinness ---
  const thin = thinNotes(accounts, records);
  if (thin.length > 0) {
    lines.push("### What that is worth");
    lines.push("");
    for (const note of thin) lines.push(`- ${note}`);
    lines.push("");
  }

  // --- review queue ---
  lines.push("## Queued for a human");
  lines.push("");
  if (queued.length === 0) {
    lines.push(`Nothing is queued. No brief fell below the ${gate.toFixed(2)} confidence gate.`);
  } else {
    lines.push(
      `${queued.length} brief(s) sit below the ${gate.toFixed(2)} confidence gate and need a ` +
        `decision (\`legwork review\`, or the console). Approval publishes locally; it sends nothing.`,
    );
    lines.push("");
    for (const account of queued.slice(0, TOP_QUEUED)) {
      const receipt = strongestReceipt(account);
      const name = account.company ? `${account.org} (${account.company})` : account.org;
      const confidence = account.confidence === undefined ? "no confidence recorded" : account.confidence.toFixed(2);
      lines.push(`- **${name}** — confidence ${confidence}`);
      lines.push(
        receipt
          ? `  - strongest receipt: ${receipt.claim} — <${receipt.url}>`
          : "  - no evidence recorded on this account",
      );
    }
    if (queued.length > TOP_QUEUED) {
      lines.push("");
      lines.push(`${queued.length - TOP_QUEUED} more queued brief(s) are not listed here.`);
    }
  }
  lines.push("");

  const reviews = readReviews();
  if (reviews.length > 0) {
    const approved = reviews.filter((r) => r.decision === "approved").length;
    lines.push(
      `Review history to date: ${reviews.length} decision(s), ${approved} approved ` +
        `(${((approved / reviews.length) * 100).toFixed(0)}% acceptance).`,
    );
    lines.push("");
  }

  // --- failures ---
  lines.push("## Failures");
  lines.push("");
  if (failures.length === 0) {
    lines.push("No unit failed and no unit hit its cost ceiling.");
  } else {
    for (const r of failures) {
      lines.push(`- **${r.agent}** — ${r.outcome}${r.error ? `: ${r.error}` : ""}`);
    }
    lines.push("");
    lines.push(
      "The runner stops the pass at the first non-ok unit, so any unit listed as missing " +
        "above did not get a turn.",
    );
  }
  lines.push("");
  lines.push(marker({ mode: pass.mode, run_started: new Date(pass.startedMs).toISOString(), accounts: currentSize }));
  lines.push("");

  const summary =
    `legwork ${pass.mode} run ${date}: ${okCount}/${records.length} units ok · ` +
    `${accounts.length} accounts · ${accounts.filter((a) => a.stage === "briefed").length} briefed · ` +
    `${queued.length} queued for review · ${money(cost)} · ${formatDuration(wallMs)}` +
    (failures.length > 0 ? ` · FAILED: ${failures.map((r) => r.agent).join(", ")}` : "");

  return { markdown: lines.join("\n"), summary };
}

// --- pieces ---------------------------------------------------------------------------

/**
 * The receipt behind the highest-weighted signal that actually observed something, which
 * is what a human wants to see first. Falls back to the first recorded receipt.
 */
export function strongestReceipt(account: Account): { claim: string; url: string } | undefined {
  const signals = (account.qualification?.signals ?? [])
    .filter((s) => typeof s.evidence_url === "string" && s.evidence_url !== "")
    .sort((a, b) => b.contribution - a.contribution);
  for (const signal of signals) {
    const url = signal.evidence_url!;
    const match: Evidence | undefined = account.evidence.find((e) => e.url === url);
    return { claim: match?.claim ?? signal.name, url };
  }
  const first = account.evidence[0];
  return first ? { claim: first.claim, url: first.url } : undefined;
}

/** Plain-language notes about a thin result. Empty when there is nothing to caveat. */
function thinNotes(accounts: Account[], records: RunRecord[]): string[] {
  const notes: string[] = [];
  const discovery = records.filter((r) => r.agent.startsWith("discover"));
  const discovered = discovery.reduce((sum, r) => sum + r.outputs, 0);
  if (discovery.length > 0 && discovered === 0) {
    notes.push(
      `Discovery returned 0 records across ${discovery.length} unit(s) this pass. That is an ` +
        `empty window, not a filtered one.`,
    );
  }

  const users = accounts.filter((a) => a.kind === "user").length;
  if (users > 0) {
    notes.push(
      `${users} of ${accounts.length} account record(s) resolved to an individual GitHub user, ` +
        `not an organization. Those never qualify — public code search skews hobbyist.`,
    );
  }

  const briefed = accounts.filter((a) => a.stage === "briefed").length;
  if (briefed === 0 && accounts.length > 0) {
    notes.push(`No account reached a brief. ${accounts.length} record(s) are parked earlier in the pipeline.`);
  }

  const noDomain = accounts.filter((a) => !a.domain).length;
  if (accounts.length > 0 && noDomain === accounts.length) {
    notes.push("No account carries a resolved domain, so none of these is a usable sales target yet.");
  }
  return notes;
}

function previousSameMode(passes: Pass[], current: Pass): Pass | undefined {
  const index = passes.indexOf(current);
  for (let i = index - 1; i >= 0; i--) {
    const candidate = passes[i]!;
    if (candidate.mode === current.mode) return candidate;
  }
  return undefined;
}

/** Account records entering the pass's final unit — the closest the log gets to a state size. */
function passEndSize(pass: Pass): number {
  const last = pass.records[pass.records.length - 1]!;
  return last.inputs;
}

/** The newest committed digest for this mode, other than the one being written. */
function priorDigestMarker(file: string, mode: string): Marker | undefined {
  const dir = dirname(file) === "" ? "." : dirname(file);
  if (!existsSync(dir)) return undefined;
  const found: Marker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (path === file) continue;
    const parsed = readMarker(path);
    if (parsed && parsed.mode === mode) found.push(parsed);
  }
  return found.sort((a, b) => (a.run_started ?? "").localeCompare(b.run_started ?? "")).pop();
}

function readMarker(path: string): Marker | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const match = new RegExp(`<!--\\s*${MARKER}\\s*(\\{.*?\\})\\s*-->`).exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!) as Marker;
  } catch {
    return undefined;
  }
}

function marker(data: Marker): string {
  return `<!-- ${MARKER} ${JSON.stringify(data)} -->`;
}

function confidenceGate(): number {
  try {
    const loops = loadRegistry().loops as Record<string, Record<string, unknown>>;
    const raw = loops.review?.confidence_gate;
    return typeof raw === "number" ? raw : 0.8;
  } catch {
    return 0.8;
  }
}

function expectedUnits(): string[] {
  try {
    // ops-brief is a scheduled reporting entry, not a pipeline unit the runner executes.
    return Object.keys(loadRegistry().agents).filter((name) => name !== "ops-brief");
  } catch {
    return [];
  }
}

// --- formatting -------------------------------------------------------------------------

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
