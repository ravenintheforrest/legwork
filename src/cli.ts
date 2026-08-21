#!/usr/bin/env node
// The operator surface. Every verb here maps to a loop or a state read — no hidden flows (F8).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { PIPELINE } from "./agents/index.js";
import { runEvals } from "./evals.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import { runPipeline, type RunSummary } from "./runner.js";
import { runReview } from "./review.js";
import { runRetire } from "./retire.js";
import { writeReviewPage } from "./reviewhtml.js";
import { writeConsole } from "./report.js";
import { notifyBrief } from "./notify.js";
import { spawn } from "node:child_process";
import type { Account, RunRecord } from "./types.js";

const ACCOUNTS_FILE = "data/accounts.jsonl";
const BRIEFS_DIR = "briefs";

const program = new Command()
  .name("legwork")
  .description("A GTM agent fleet with an operating harness. The fleet does the legwork.");

const todo = (verb: string) => () => {
  console.log(`legwork ${verb}: not implemented yet — see docs/PLAN.md priority stack`);
};

program.command("run").description("run the fleet (or one agent) over the pipeline")
  .option("--since <window>", "only consider activity in this window", "7d")
  .option("--agent <name>", "run a single agent")
  .option("--fixture", "run against recorded fixtures instead of the live APIs")
  .action(async (options: { since: string; agent?: string; fixture?: boolean }) => {
    await runPipeline({
      mode: options.fixture ? "fixture" : "live",
      agent: options.agent,
      sinceDays: parseSince(options.since),
    });
  });

program.command("demo").description("seeded deterministic run — offline-safe")
  .option("--capture-llm", "call the live model once and record replay fixtures for demo mode")
  .action(async (options: { captureLlm?: boolean }) => {
  console.log("legwork demo: the whole pipeline over recorded fixtures in fixtures/.");
  console.log("No credentials, no network, same output every time.");
  console.log("");

  // The demo owns its world: accounts and briefs are rebuilt from scratch. The run log
  // is a log — it keeps growing.
  rmSync(ACCOUNTS_FILE, { force: true });
  rmSync(BRIEFS_DIR, { recursive: true, force: true });

  const summary = await runPipeline({ mode: "fixture", sinceDays: 7, captureLlm: options.captureLlm === true });
  console.log("");
  printDemoSummary(summary);
});

program.command("evals").description("score every agent against the golden set")
  .option("--update-baseline", "accept the current scores as the new baseline")
  .action(async (options: { updateBaseline?: boolean }) => {
    await runEvals({ updateBaseline: options.updateBaseline === true });
  });

program.command("status").description("run history, per-agent health")
  .option("--costs", "show $ per agent")
  .action((options: { costs?: boolean }) => {
    printStatus(readRuns(), options.costs === true);
  });

program.command("show").description("everything known about one account").argument("<account>")
  .action((account: string) => {
    printAccount(account, loadAccounts(ACCOUNTS_FILE));
  });

program.command("review").description("approve/reject queued briefs (HITL loop)")
  .option("--approve <org>", "approve one queued brief (non-interactive)")
  .option("--reject <org>", "reject one queued brief (non-interactive)")
  .option("--stats", "acceptance rate and queue depth")
  .option("--html", "generate briefs/review.html — judge in the browser, record via CLI")
  .action(async (options: { approve?: string; reject?: string; stats?: boolean; html?: boolean }) => {
    if (options.html) {
      const file = writeReviewPage();
      console.log(`review page written: ${file}`);
      console.log("open it, stage decisions, then paste the command it builds for you.");
      return;
    }
    await runReview(options);
  });
program.command("doctor").description("diagnose a failing run (self-heal loop)").argument("[run]").action(todo("doctor"));
program.command("improve").description("draft a prompt/rubric revision as a PR").argument("<agent>").action(todo("improve"));
program.command("retire").description("retirement memo for one agent, from its run history").argument("<agent>")
  .action((agent: string) => {
    runRetire(agent);
  });
program.command("report").description("generate the static fleet console (site/index.html)")
  .option("--open", "open it in the browser after generating")
  .action((options: { open?: boolean }) => {
    const file = writeConsole();
    console.log(`console written: ${file}`);
    if (options.open) spawn("open", [file], { stdio: "ignore", detached: true }).unref();
  });

program.command("notify").description("post a published brief's Slack-shaped form to SLACK_WEBHOOK_URL")
  .argument("<org>")
  .action(async (org: string) => {
    const result = await notifyBrief(org);
    if (result === "missing") throw new Error(`no published brief for "${org}" (is it still in the review queue?)`);
    console.log(result === "posted" ? `${org}: posted to Slack` : `${org}: printed (set SLACK_WEBHOOK_URL to post)`);
  });

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`legwork: ${message.replace(/\s+/g, " ").trim()}`);
  process.exitCode = 1;
});

// --- output -----------------------------------------------------------------------

function printDemoSummary(summary: RunSummary): void {
  const stages = tally(summary.accounts.map((a) => a.stage));
  const segments = tally(summary.accounts.flatMap((a) => (a.segment ? [a.segment] : [])));
  const briefs = summary.agents.find((a) => a.agent === "brief")?.outputs ?? 0;
  const cost = summary.agents.reduce((sum, a) => sum + a.cost_usd, 0);

  const rows: [string, string][] = [
    ["accounts", String(summary.accounts.length)],
    ["by stage", stages.length ? stages.map(([k, n]) => `${k} ${n}`).join(" · ") : "none"],
    ["segments", segments.length ? segments.map(([k, n]) => `${k} ${n}`).join(" · ") : "none"],
    ["briefs", `${briefs} written to ${BRIEFS_DIR}/`],
    ["cost", `$${cost.toFixed(4)} (fixture mode: offline; model briefs replayed from fixtures)`],
  ];
  for (const [label, value] of rows) console.log(`${label.padEnd(10)} ${value}`);
}

function printStatus(runs: RunRecord[], withCosts: boolean): void {
  if (runs.length === 0) {
    console.log("no runs yet — try `legwork demo`");
    return;
  }

  const agents = [...new Set(runs.map((r) => r.agent))].sort(byPipelineOrder);
  const header = ["agent", "runs", "ok", "err", "killed", "last", "in", "out"];
  if (withCosts) header.push("tokens in", "tokens out", "$");

  const rows = agents.map((agent) => {
    const mine = runs.filter((r) => r.agent === agent);
    const sum = (pick: (r: RunRecord) => number) => mine.reduce((total, r) => total + pick(r), 0);
    const row = [
      agent,
      String(mine.length),
      String(mine.filter((r) => r.outcome === "ok").length),
      String(mine.filter((r) => r.outcome === "error").length),
      String(mine.filter((r) => r.outcome === "killed_cost_ceiling").length),
      mine[mine.length - 1]!.outcome,
      String(sum((r) => r.inputs)),
      String(sum((r) => r.outputs)),
    ];
    if (withCosts) {
      row.push(
        String(sum((r) => r.tokens_in)),
        String(sum((r) => r.tokens_out)),
        `$${sum((r) => r.cost_usd).toFixed(4)}`,
      );
    }
    return row;
  });

  printTable(header, rows);

  const failed = runs.filter((r) => r.outcome !== "ok").slice(-3);
  if (failed.length > 0) {
    console.log("");
    console.log("recent failures");
    for (const run of failed) console.log(`  ${run.id} ${run.outcome} · ${run.error ?? ""}`);
  }
}

function printAccount(query: string, accounts: Account[]): void {
  const needle = query.toLowerCase();
  const account =
    accounts.find((a) => a.org === query) ??
    accounts.find((a) => a.org.toLowerCase() === needle || a.domain?.toLowerCase() === needle);
  if (!account) {
    console.log(`no account "${query}" in ${ACCOUNTS_FILE} — try \`legwork demo\` or \`legwork run\``);
    return;
  }

  const facts = [`stage ${account.stage}`];
  if (account.segment) facts.push(`segment ${account.segment}`);
  if (account.confidence !== undefined) facts.push(`confidence ${account.confidence.toFixed(2)}`);
  if (account.domain) facts.push(`domain ${account.domain}`);
  if (account.kind) facts.push(`kind ${account.kind}`);

  console.log(`${account.org}${account.company ? ` — ${account.company}` : ""}`);
  console.log(facts.join(" · "));
  if (account.repos?.length) console.log(`repos ${account.repos.join(", ")}`);
  console.log(`updated ${account.updated}`);

  console.log("");
  console.log(`evidence (${account.evidence.length})`);
  for (const e of account.evidence) {
    console.log(`  ${e.claim}  [${e.agent}]`);
    console.log(`    ${e.url}`);
  }

  const brief = join(BRIEFS_DIR, `${account.org}.md`);
  if (existsSync(brief)) {
    console.log("");
    console.log(`brief ${brief}`);
  }
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

// --- helpers ----------------------------------------------------------------------

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function byPipelineOrder(a: string, b: string): number {
  const rank = (name: string) => {
    const index = PIPELINE.indexOf(name);
    return index === -1 ? PIPELINE.length : index;
  };
  return rank(a) - rank(b) || (a < b ? -1 : 1);
}

function parseSince(window: string): number {
  const match = /^(\d+)d$/.exec(window.trim());
  return match ? Number(match[1]) : 7;
}
