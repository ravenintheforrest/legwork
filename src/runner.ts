// The runner owns everything an agent must not forget: the clock, the cost meter,
// retries, state merge, and the run log (F8).

import { join } from "node:path";
import { AGENTS, PIPELINE } from "./agents/index.js";
import { StoreSignals } from "./appstore.js";
import { CostCeilingError, CostMeter } from "./costs.js";
import { GitHubClient, type FetchMode } from "./gh.js";
import { makeLLM } from "./llm.js";
import { effective, loadRegistry } from "./registry.js";
import { appendRun } from "./runlog.js";
import { loadAccounts, mergeAccounts, saveAccounts } from "./store.js";
import type { Account, RunContext, RunRecord } from "./types.js";

// Fixture mode pins the clock so `legwork demo` is byte-identical run to run.
export const FIXTURE_NOW = "2026-08-20T12:00:00.000Z";

const MAX_RETRIES = 2;

export interface RunOptions {
  mode: FetchMode;
  agent?: string;
  sinceDays: number;
  registryPath?: string;
  dataDir?: string;
  captureLlm?: boolean;   // fixture-mode only: call the live model and record replay fixtures
}

export interface AgentRunSummary {
  agent: string;
  inputs: number;
  outputs: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  outcome: RunRecord["outcome"];
  error?: string;
}

export interface RunSummary {
  agents: AgentRunSummary[];
  accounts: Account[];
}

export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  const registry = loadRegistry(opts.registryPath ?? "registry.yaml");
  const dataDir = opts.dataDir ?? "data";
  const accountsFile = join(dataDir, "accounts.jsonl");
  const runsFile = join(dataDir, "runs.jsonl");

  if (opts.mode === "live" && !process.env.GITHUB_TOKEN) {
    console.error("legwork run: GITHUB_TOKEN is not set — set it in .env, or run `legwork demo` (offline fixtures).");
    process.exit(1);
  }

  const names = opts.agent ? [opts.agent] : PIPELINE;
  for (const name of names) {
    if (!AGENTS[name]) {
      throw new Error(`no agent "${name}" — known agents: ${Object.keys(AGENTS).join(", ")}`);
    }
  }

  const gh = new GitHubClient({
    mode: opts.mode,
    token: process.env.GITHUB_TOKEN,
    cacheDir: join(dataDir, "cache"),
  });
  const store = new StoreSignals({ mode: opts.mode });
  // Fixture mode replays captured model responses: the demo shows authentic model
  // output and still runs offline and deterministically. --capture-llm records them.
  const llm = makeLLM(opts.mode, opts.captureLlm === true);
  const now = opts.mode === "fixture" ? () => FIXTURE_NOW : () => new Date().toISOString();

  let state = loadAccounts(accountsFile);
  const summaries: AgentRunSummary[] = [];

  for (const name of names) {
    const agent = AGENTS[name]!;
    const config = effective(registry, name);
    const started = new Date();
    const inputs = state.length;

    let costs = new CostMeter(config.costCeilingUsd);
    let outputs: Account[] = [];
    let outcome: RunRecord["outcome"] = "error";
    let error: string | undefined;

    for (let attempt = 0; ; attempt++) {
      costs = new CostMeter(config.costCeilingUsd); // fresh meter per attempt
      const ctx: RunContext = {
        pack: registry.pack,
        mode: opts.mode,
        now,
        sinceDays: opts.sinceDays,
        gh,
        store,
        llm,
        costs,
      };
      try {
        outputs = await agent.run(state, ctx);
        outcome = "ok";
        error = undefined;
        break;
      } catch (err) {
        error = compact(err);
        // A cost kill is a decision, not a fault: never retry into the ceiling.
        if (err instanceof CostCeilingError) {
          outcome = "killed_cost_ceiling";
          break;
        }
        if (attempt >= MAX_RETRIES) {
          outcome = "error";
          break;
        }
        if (opts.mode === "live") await sleep(500 * 2 ** attempt);
      }
    }

    if (outcome === "ok") {
      state = mergeAccounts(state, outputs);
      saveAccounts(state, accountsFile);
    } else {
      outputs = [];
    }

    const record: RunRecord = {
      id: `r-${Date.now().toString(36)}-${name}`,
      agent: name,
      started: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
      inputs,
      outputs: outputs.length,
      tokens_in: costs.tokensIn,
      tokens_out: costs.tokensOut,
      cost_usd: Number(costs.costUsd.toFixed(6)),
      mode: opts.mode,
      outcome,
      ...(error ? { error } : {}),
    };
    appendRun(record, runsFile);

    summaries.push({
      agent: name,
      inputs,
      outputs: outputs.length,
      tokens_in: record.tokens_in,
      tokens_out: record.tokens_out,
      cost_usd: record.cost_usd,
      outcome,
      ...(error ? { error } : {}),
    });
    printAgentLine(summaries[summaries.length - 1]!);
  }

  return { agents: summaries, accounts: state };
}

function printAgentLine(summary: AgentRunSummary): void {
  const mark = summary.outcome === "ok" ? "✓" : "✗";
  const cost = `$${summary.cost_usd.toFixed(4)}`;
  const tail = summary.outcome === "ok" ? "" : ` · ${summary.outcome} · ${summary.error ?? ""}`;
  console.log(`  ${mark} ${summary.agent} ${summary.inputs} in → ${summary.outputs} out · ${cost}${tail}`);
}

// One line, bounded: this is what `doctor` reads back into context (F9).
function compact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
