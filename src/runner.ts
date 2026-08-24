// The runner owns everything an agent must not forget: the clock, the cost meter,
// retries, state merge, freshness, and the run log (F8).

import { existsSync, readdirSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, PIPELINE } from "./agents/index.js";
import { StoreSignals } from "./appstore.js";
import { CostCeilingError, CostMeter } from "./costs.js";
import { withFileLockAsync } from "./filelock.js";
import { invalidateDerived, markFullyRefreshed, needsRefresh } from "./freshness.js";
import { GitHubClient, type FetchMode } from "./gh.js";
import { formatHttpUsage, httpBudget, httpUsageSince } from "./http.js";
import { makeLLM, type LLM } from "./llm.js";
import { effective, loadRegistry } from "./registry.js";
import { appendRun } from "./runlog.js";
import { loadAccounts, mergeAccounts, saveAccounts } from "./store.js";
import type { HttpUsage } from "./http.js";
import type { Account, AgentDef, RunContext, RunRecord } from "./types.js";

const BRIEFS_DIR = "briefs";

export const FIXTURE_NOW = "2026-08-20T12:00:00.000Z";
const MAX_RETRIES = 2;

export interface RunOptions {
  mode: FetchMode;
  agent?: string;
  sinceDays: number;
  registryPath?: string;
  dataDir?: string;
  captureLlm?: boolean;
  refreshKnown?: boolean; // deterministic integration hook; live full runs refresh after 24h
  /** Pipeline units to leave out of this run (source selection from the console). The
   *  remaining units still run in pipeline order; freshness stamping is unaffected. */
  skipAgents?: string[];
  llm?: LLM | null;       // dependency injection for integration tests
  agents?: Record<string, AgentDef>;
}

export interface AgentRunSummary {
  agent: string;
  http?: HttpUsage;
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
  const dataDir = opts.dataDir ?? "data";
  return withFileLockAsync(join(dataDir, "accounts.jsonl.lock"), () => runLocked(opts, dataDir));
}

async function runLocked(opts: RunOptions, dataDir: string): Promise<RunSummary> {
  const registry = loadRegistry(opts.registryPath ?? "registry.yaml");
  const accountsFile = join(dataDir, "accounts.jsonl");
  const runsFile = join(dataDir, "runs.jsonl");
  const definitions = opts.agents ?? AGENTS;
  const skip = new Set(opts.skipAgents ?? []);
  const names = opts.agent ? [opts.agent] : PIPELINE.filter((n) => !skip.has(n));

  for (const name of names) {
    if (!definitions[name]) {
      throw new Error(`no agent "${name}" — known agents: ${Object.keys(definitions).join(", ")}`);
    }
  }
  if (opts.mode === "live" && names.includes("discover") && !process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required by the discover agent; other public-data agents can run without it");
  }

  const gh = new GitHubClient({
    mode: opts.mode,
    token: process.env.GITHUB_TOKEN,
    cacheDir: join(dataDir, "cache"),
  });
  const store = new StoreSignals({ mode: opts.mode, cacheDir: join(dataDir, "cache") });
  const llm = opts.llm !== undefined ? opts.llm : makeLLM(opts.mode, opts.captureLlm === true);
  const now = opts.mode === "fixture" ? () => FIXTURE_NOW : () => new Date().toISOString();

  let state = loadAccounts(accountsFile);
  // A fixture account carries authored receipts that do not resolve; a live account carries
  // real ones. Sharing one state file let fixture records survive into live runs, so live
  // briefs sat beside fixture briefs and clicking a receipt 404'd. Modes are exclusive now:
  // entering one evicts the other, and says so.
  // Unstamped records predate this field (or were built by a caller that doesn't set it):
  // adopt them into the running mode rather than evicting them. Only an explicit, different
  // stamp counts as foreign.
  const foreign = state.filter((a) => a.mode !== undefined && a.mode !== opts.mode);
  if (foreign.length > 0) {
    state = state.filter((a) => a.mode === undefined || a.mode === opts.mode);
    const evicted = new Set(foreign.map((a) => a.org));
    // Bank before clearing. Live accounts carry human decisions; nothing here may be the
    // only copy's last moment. data/backups/ is local and gitignored, like everything live.
    const bank = join(dataDir, "backups", `evicted-${foreign[0]!.mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
    mkdirSync(join(bank, "briefs", "queue"), { recursive: true });
    writeFileSync(join(bank, "accounts.jsonl"), foreign.map((a) => JSON.stringify(a)).join("\n") + "\n");
    for (const dir of [BRIEFS_DIR, join(BRIEFS_DIR, "queue")]) {
      if (!existsSync(dir)) continue;
      // Match on the account name, not a list of extensions — the brief agent has renamed
      // its sidecars before, and a missed extension leaves an unclickable brief behind.
      for (const file of readdirSync(dir)) {
        const org = file.split(".")[0]!;
        if (!evicted.has(org)) continue;
        const from = join(dir, file);
        cpSync(from, join(bank, dir === BRIEFS_DIR ? "briefs" : join("briefs", "queue"), file));
        rmSync(from, { force: true });
      }
    }
    console.log(
      `  cleared ${foreign.length} ${foreign[0]!.mode}-mode account(s) and their briefs — a run owns its world (banked → ${bank})`,
    );
  }
  const fullFleet = opts.agent === undefined;
  const refreshAt = now();
  if (fullFleet && (opts.mode === "live" || opts.refreshKnown === true)) {
    state = state.map((account) =>
      opts.refreshKnown === true || needsRefresh(account, refreshAt) ? invalidateDerived(account, refreshAt) : account,
    );
  }

  const summaries: AgentRunSummary[] = [];
  for (const name of names) {
    const agent = definitions[name]!;
    const config = effective(registry, name);
    const started = new Date();
    const inputs = state.length;
    const httpBefore = httpBudget();
    const costs = new CostMeter(config.costCeilingUsd);
    let outputs: Account[] = [];
    let outcome: RunRecord["outcome"] = "error";
    let error: string | undefined;

    for (let attempt = 0; ; attempt++) {
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
      state = mergeAccounts(state, outputs.map((a) => ({ ...a, mode: opts.mode })));
      saveAccounts(state, accountsFile);
    } else {
      outputs = [];
    }

    // Live-only: fixture runs never touch the policy layer, so this stays absent and the
    // demo's run records keep the shape they have always had.
    const http = httpUsageSince(httpBefore, httpBudget());

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
      ...(http ? { http } : {}),
      outcome,
      ...(error ? { error } : {}),
    };
    appendRun(record, runsFile);

    const summary: AgentRunSummary = {
      agent: name,
      ...(http ? { http } : {}),
      inputs,
      outputs: outputs.length,
      tokens_in: record.tokens_in,
      tokens_out: record.tokens_out,
      cost_usd: record.cost_usd,
      outcome,
      ...(error ? { error } : {}),
    };
    summaries.push(summary);
    printAgentLine(summary);
    if (outcome !== "ok") break;
  }

  if (fullFleet && summaries.length === names.length && summaries.every((item) => item.outcome === "ok")) {
    const completedAt = now();
    state = state.map((account) => markFullyRefreshed(account, completedAt));
    saveAccounts(state, accountsFile);
  }
  return { agents: summaries, accounts: state };
}

function printAgentLine(summary: AgentRunSummary): void {
  const mark = summary.outcome === "ok" ? "✓" : "✗";
  const cost = `$${summary.cost_usd.toFixed(4)}`;
  const tail = summary.outcome === "ok" ? "" : ` · ${summary.outcome} · ${summary.error ?? ""}`;
  const http = summary.http ? ` · ${formatHttpUsage(summary.http)}` : "";
  console.log(`  ${mark} ${summary.agent} ${summary.inputs} in → ${summary.outputs} out · ${cost}${http}${tail}`);
}

function compact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
