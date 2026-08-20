// Evals: the fleet's regression gate. Runs the read-only agents over fixtures entirely
// in memory — it never touches data/ — and scores them against the hand-labeled golden
// set. A score below baseline fails the command (and therefore CI).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS } from "./agents/index.js";
import { StoreSignals } from "./appstore.js";
import { CostMeter } from "./costs.js";
import { GitHubClient } from "./gh.js";
import { loadRegistry } from "./registry.js";
import { mergeAccounts } from "./store.js";
import { FIXTURE_NOW } from "./runner.js";
import type { Account, RunContext } from "./types.js";

interface GoldenRow {
  org: string;
  verdict: "qualified" | "unqualified" | "exclude";
  segment?: string;
  domain?: string;
  why?: string;
  labeled_by?: string;
  date?: string;
}

interface Metric {
  key: string;      // baseline key
  label: string;    // agent.metric, as printed
  correct: number;
  total: number;
}

export interface EvalOptions {
  updateBaseline?: boolean;
  registryPath?: string;
  goldenPath?: string;
  baselinePath?: string;
}

export async function runEvals(opts: EvalOptions = {}): Promise<void> {
  const registry = loadRegistry(opts.registryPath ?? "registry.yaml");
  const goldenPath = opts.goldenPath ?? join(registry.pack, "golden-set.jsonl");
  const baselinePath = opts.baselinePath ?? join(registry.pack, "evals-baseline.json");

  const golden = readGolden(goldenPath);
  const { discovered, state } = await scoreFixtures(registry.pack);
  const metrics = score(golden, discovered, state);
  const scores = Object.fromEntries(metrics.map((m) => [m.key, ratio(m)]));

  if (!existsSync(baselinePath) || opts.updateBaseline) {
    const note = existsSync(baselinePath) ? "baseline updated" : "no baseline found — wrote one";
    writeBaseline(baselinePath, scores);
    printTable(metrics, scores);
    console.log(`${note}: ${baselinePath}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
  printTable(metrics, baseline);

  const regressions = metrics.filter((m) => ratio(m) + 1e-9 < (baseline[m.key] ?? 0));
  if (regressions.length === 0) {
    console.log("no regressions");
    return;
  }
  for (const m of regressions) {
    console.log(
      `REGRESSION: ${m.label} ${ratio(m).toFixed(2)} < baseline ${(baseline[m.key] ?? 0).toFixed(2)}`,
    );
  }
  process.exitCode = 1;
}

// The pipeline, minus brief (which writes files): discover -> resolve -> qualify.
async function scoreFixtures(pack: string): Promise<{ discovered: Account[]; state: Account[] }> {
  const ctx: RunContext = {
    pack,
    mode: "fixture",
    now: () => FIXTURE_NOW,
    sinceDays: 0,
    gh: new GitHubClient({ mode: "fixture" }),
    store: new StoreSignals({ mode: "fixture" }),
    llm: null,
    costs: new CostMeter(Number.POSITIVE_INFINITY),
  };

  const discovered = await AGENTS.discover!.run([], ctx);
  let state = mergeAccounts([], discovered);
  state = mergeAccounts(state, await AGENTS.resolve!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.qualify!.run(state, ctx));
  return { discovered, state };
}

function score(golden: GoldenRow[], discovered: Account[], state: Account[]): Metric[] {
  const found = new Set(discovered.map((a) => a.org));
  const byOrg = new Map(state.map((a) => [a.org, a]));

  const metrics: Metric[] = [
    { key: "discover", label: "discover.presence", correct: 0, total: 0 },
    { key: "resolve_domain", label: "resolve.domain", correct: 0, total: 0 },
    { key: "qualify_verdict", label: "qualify.verdict", correct: 0, total: 0 },
    { key: "qualify_segment", label: "qualify.segment", correct: 0, total: 0 },
  ];
  const [presence, domain, verdict, segment] = metrics as [Metric, Metric, Metric, Metric];

  for (const row of golden) {
    const account = byOrg.get(row.org);

    presence.total += 1;
    const shouldBeFound = row.verdict !== "exclude";
    if (found.has(row.org) === shouldBeFound) presence.correct += 1;

    if (row.domain) {
      domain.total += 1;
      if (account?.domain === row.domain) domain.correct += 1;
    }

    if (row.verdict === "qualified" || row.verdict === "unqualified") {
      verdict.total += 1;
      const isQualified = account?.stage === "qualified";
      if (isQualified === (row.verdict === "qualified")) verdict.correct += 1;
    }

    if (row.segment) {
      segment.total += 1;
      if (account?.segment === row.segment) segment.correct += 1;
    }
  }

  return metrics;
}

function readGolden(file: string): GoldenRow[] {
  if (!existsSync(file)) throw new Error(`no golden set at ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as GoldenRow);
}

function writeBaseline(file: string, scores: Record<string, number>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(scores, null, 2) + "\n");
}

function ratio(m: Metric): number {
  return m.total === 0 ? 1 : m.correct / m.total;
}

function printTable(metrics: Metric[], baseline: Record<string, number>): void {
  const rows = metrics.map((m) => {
    const base = baseline[m.key] ?? 0;
    const delta = ratio(m) - base;
    return [
      m.label,
      `${m.correct}/${m.total}`,
      ratio(m).toFixed(2),
      base.toFixed(2),
      `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
    ];
  });
  const header = ["metric", "score", "ratio", "baseline", "delta"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");

  console.log(line(header));
  for (const row of rows) console.log(line(row));
  console.log("");
}
