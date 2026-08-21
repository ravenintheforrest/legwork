// The retirement loop's artifact: a memo that decides an agent's fate from its own
// run history, not from anyone's fondness for it. Tactics expire; agents are tactics.
//
// The memo answers, in order: what we expected (the registry hypothesis), what it cost,
// what it uniquely produced, how far its output traveled, whether removing it changes
// the final briefs, and the verdict. Retiring an agent is `human`-tier by design —
// this command recommends and documents; a person merges the PR that removes it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import type { Account, RunRecord } from "./types.js";

const MEMO_DIR = "memos";

export function runRetire(agent: string): void {
  const registry = loadRegistry();
  const entry = registry.agents[agent];
  if (!entry) throw new Error(`no agent "${agent}" in the registry`);

  const runs = readRuns();
  const agentRuns = runs.filter((r) => r.agent === agent);
  if (agentRuns.length === 0) throw new Error(`no run history for "${agent}" — nothing to judge it by`);

  const accounts = loadAccounts();
  const attribution = attribute(agent, accounts);
  const cost = summarize(agentRuns);
  const pipelineCost = summarize(runs);
  const threshold = retirementThreshold(registry.loops);

  const briefedTotal = accounts.filter((a) => a.stage === "briefed").length;
  const share = briefedTotal === 0 ? 0 : attribution.briefedUnique / briefedTotal;
  const verdict = share < threshold ? "retire" : attribution.unique.length === 0 ? "merge" : "keep";

  const memo = renderMemo({
    agent,
    hypothesis: entry.hypothesis ?? null,
    does: entry.does,
    runs: agentRuns,
    cost,
    pipelineCost,
    attribution,
    briefedTotal,
    share,
    threshold,
    verdict,
  });

  mkdirSync(MEMO_DIR, { recursive: true });
  const file = join(MEMO_DIR, `retire-${agent}.md`);
  writeFileSync(file, memo);
  console.log(memo);
  console.log(`memo written: ${file}`);
  if (verdict === "retire") {
    console.log(`to act on it (human tier): open a PR removing "${agent}" from registry.yaml and the pipeline.`);
  }
}

interface Attribution {
  touched: Account[];       // accounts carrying any evidence from this agent
  unique: Account[];        // accounts that would not exist without it (sole discoverer)
  briefedViaAgent: number;  // touched accounts that reached a brief
  briefedUnique: number;    // unique accounts that reached a brief — the marginal number
  evidenceCount: number;
}

function attribute(agent: string, accounts: Account[]): Attribution {
  const touched = accounts.filter((a) => a.evidence.some((e) => e.agent === agent));
  const discoveryAgents = new Set(["discover", "discover-gitlab"]);
  const unique = discoveryAgents.has(agent)
    ? accounts.filter((a) => {
        const discoverers = new Set(
          a.evidence.filter((e) => discoveryAgents.has(e.agent)).map((e) => e.agent),
        );
        return discoverers.size === 1 && discoverers.has(agent);
      })
    : []; // for non-discovery agents "unique existence" is not the right question
  return {
    touched,
    unique,
    briefedViaAgent: touched.filter((a) => a.stage === "briefed").length,
    briefedUnique: unique.filter((a) => a.stage === "briefed").length,
    evidenceCount: accounts.reduce((n, a) => n + a.evidence.filter((e) => e.agent === agent).length, 0),
  };
}

interface CostSummary {
  runs: number;
  ok: number;
  errors: number;
  durationMs: number;
  costUsd: number;
  outputs: number;
}

function summarize(runs: RunRecord[]): CostSummary {
  return {
    runs: runs.length,
    ok: runs.filter((r) => r.outcome === "ok").length,
    errors: runs.filter((r) => r.outcome !== "ok").length,
    durationMs: runs.reduce((n, r) => n + r.duration_ms, 0),
    costUsd: runs.reduce((n, r) => n + r.cost_usd, 0),
    outputs: runs.reduce((n, r) => n + r.outputs, 0),
  };
}

function retirementThreshold(loops: Record<string, Record<string, unknown>>): number {
  const raw = loops.retirement?.candidate_threshold;
  return typeof raw === "number" ? raw : 0.05;
}

function renderMemo(m: {
  agent: string;
  hypothesis: string | null;
  does: string;
  runs: RunRecord[];
  cost: CostSummary;
  pipelineCost: CostSummary;
  attribution: Attribution;
  briefedTotal: number;
  share: number;
  threshold: number;
  verdict: string;
}): string {
  const liveRuns = m.runs.filter((r) => r.mode === "live").length;
  const timeShare = m.pipelineCost.durationMs === 0 ? 0 : m.cost.durationMs / m.pipelineCost.durationMs;
  const date = m.runs[m.runs.length - 1]!.started.slice(0, 10);
  const lines = [
    `# Retirement memo — \`${m.agent}\``,
    "",
    `date ${date} · verdict: **${m.verdict.toUpperCase()}**`,
    "",
    "## What we expected",
    m.hypothesis ?? `(no hypothesis recorded in the registry — its job: ${m.does})`,
    "",
    "## What it cost",
    `- ${m.cost.runs} runs (${liveRuns} live), ${m.cost.ok} ok, ${m.cost.errors} failed`,
    `- ${(m.cost.durationMs / 1000).toFixed(1)}s total runtime — ${(timeShare * 100).toFixed(0)}% of all pipeline time`,
    `- $${m.cost.costUsd.toFixed(4)} in model spend`,
    "",
    "## What it produced",
    `- ${m.cost.outputs} records emitted across all runs`,
    `- ${n(m.attribution.touched.length, "account")} carry its evidence (${n(m.attribution.evidenceCount, "evidence record")})`,
    `- ${n(m.attribution.unique.length, "account")} exist${m.attribution.unique.length === 1 ? "s" : ""} *only* because of it` +
      (m.attribution.unique.length > 0
        ? `: ${m.attribution.unique.map((a) => a.org).join(", ")}`
        : ""),
    "",
    "## How far its output traveled",
    `- ${m.attribution.briefedViaAgent} of its touched accounts reached a brief`,
    `- **${m.attribution.briefedUnique} briefs would not exist without it** (of ${m.briefedTotal} total)`,
    `- marginal contribution: ${(m.share * 100).toFixed(1)}% vs. retirement threshold ${(m.threshold * 100).toFixed(0)}%`,
    "",
    "## Verdict",
    verdictText(m.verdict, m.agent, m.share, m.threshold),
    "",
    "*Generated by `legwork retire` from data/runs.jsonl and data/accounts.jsonl.*",
    "*Acting on a retirement is human-tier: it happens by PR, not by this command.*",
    "",
  ];
  return lines.join("\n");
}

function n(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function verdictText(verdict: string, agent: string, share: number, threshold: number): string {
  if (verdict === "retire") {
    return (
      `Marginal contribution ${(share * 100).toFixed(1)}% is below the ${(threshold * 100).toFixed(0)}% threshold. ` +
      `\`${agent}\` runs, logs, and behaves — it just does not change what the fleet produces. ` +
      `Recommend removing it from the pipeline and keeping this memo as the record of a hypothesis fairly tested.`
    );
  }
  if (verdict === "merge") {
    return `It contributes evidence but discovers nothing unique. Recommend merging its sources into a neighboring agent.`;
  }
  return `It earns its place: unique accounts reach briefs through it. Keep, and re-run this memo monthly.`;
}
