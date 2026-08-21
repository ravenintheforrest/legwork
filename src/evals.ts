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
  // "lead" is a company a discovery channel is expected to surface but that the
  // pipeline cannot score yet — no public GitHub org, so no qualification decision to
  // grade. Presence is the only claim the golden set can honestly make about it.
  verdict: "qualified" | "unqualified" | "exclude" | "lead";
  // Which discovery channel is expected to find the row. Absent means the code-search
  // channel (`discover`), which is where every row before discover-jobs came from.
  source?: "code" | "jobs";
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
  const { discovered, fromJobs, state } = await scoreFixtures(registry.pack);
  const metrics = score(golden, discovered, fromJobs, state);
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

// The pipeline, minus brief (which writes files):
// discover -> discover-jobs -> discover-gitlab -> resolve -> enrich -> dedupe ->
// qualify -> people.
async function scoreFixtures(
  pack: string,
): Promise<{ discovered: Account[]; fromJobs: Account[]; state: Account[] }> {
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
  const fromJobs = await AGENTS["discover-jobs"]!.run(state, ctx);
  state = mergeAccounts(state, fromJobs);
  state = mergeAccounts(state, await AGENTS["discover-gitlab"]!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.resolve!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.enrich!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.dedupe!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.qualify!.run(state, ctx));
  state = mergeAccounts(state, await AGENTS.people!.run(state, ctx));
  return { discovered, fromJobs, state };
}

function score(
  golden: GoldenRow[],
  discovered: Account[],
  fromJobs: Account[],
  state: Account[],
): Metric[] {
  const found = new Set(discovered.map((a) => a.org));
  const foundByJobs = new Set(fromJobs.map((a) => a.org));
  const byOrg = new Map(state.map((a) => [a.org, a]));

  const metrics: Metric[] = [
    { key: "discover", label: "discover.presence", correct: 0, total: 0 },
    { key: "discover_jobs", label: "discover_jobs.presence", correct: 0, total: 0 },
    { key: "resolve_domain", label: "resolve.domain", correct: 0, total: 0 },
    { key: "enrich_presence", label: "enrich.presence", correct: 0, total: 0 },
    { key: "qualify_verdict", label: "qualify.verdict", correct: 0, total: 0 },
    { key: "qualify_segment", label: "qualify.segment", correct: 0, total: 0 },
    { key: "qualify_explanation", label: "qualify.explanation", correct: 0, total: 0 },
    { key: "dedupe_domains", label: "dedupe.domains", correct: 0, total: 0 },
    { key: "people_presence", label: "people.presence", correct: 0, total: 0 },
  ];
  const [presence, jobs, domain, enriched, verdict, segment, explanation, deduped, people] =
    metrics as [Metric, Metric, Metric, Metric, Metric, Metric, Metric, Metric, Metric];

  for (const row of golden) {
    const account = byOrg.get(row.org);

    // Each discovery channel is graded on its own beat: code search is not asked to
    // find a company whose only public trace is a job post, and the jobs channel is
    // wrong if it invents an account for anyone it was not told about.
    if (row.source !== "jobs") {
      presence.total += 1;
      const shouldBeFound = row.verdict !== "exclude";
      if (found.has(row.org) === shouldBeFound) presence.correct += 1;
    }

    jobs.total += 1;
    if (foundByJobs.has(row.org) === (row.source === "jobs")) jobs.correct += 1;

    if (row.domain) {
      domain.total += 1;
      if (account?.domain === row.domain) domain.correct += 1;

      // A labeled domain means a reachable homepage: enrich must have receipts for it.
      enriched.total += 1;
      if (account?.evidence.some((e) => e.agent === "enrich")) enriched.correct += 1;
    }

    if (row.verdict === "qualified" || row.verdict === "unqualified") {
      verdict.total += 1;
      const isQualified = account?.stage === "qualified";
      if (isQualified === (row.verdict === "qualified")) verdict.correct += 1;

      explanation.total += 1;
      const decision = account?.qualification;
      const contribution = decision?.signals.reduce((sum, signal) => sum + signal.contribution, 0) ?? NaN;
      const expectedAction = row.verdict === "qualified" ? "brief" : account?.kind === "user" ? "exclude" : "hold";
      if (
        decision &&
        decision.action === expectedAction &&
        decision.qualified === (row.verdict === "qualified") &&
        Math.abs(contribution - decision.score) <= 0.011
      ) {
        explanation.correct += 1;
      }
    }

    // A qualified account is a good lead: people must have found someone to talk to.
    if (row.verdict === "qualified") {
      people.total += 1;
      if (account?.evidence.some((e) => e.agent === "people")) people.correct += 1;
    }

    if (row.segment) {
      segment.total += 1;
      if (account?.segment === row.segment) segment.correct += 1;
    }
  }

  // dedupe: after the pipeline, every domain in state belongs to exactly one account.
  const holders = new Map<string, number>();
  for (const account of state) {
    if (account.domain) holders.set(account.domain, (holders.get(account.domain) ?? 0) + 1);
  }
  for (const count of holders.values()) {
    deduped.total += 1;
    if (count === 1) deduped.correct += 1;
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
