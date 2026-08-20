#!/usr/bin/env node
// The operator surface. Every verb here maps to a loop or a state read — no hidden flows (F8).
import { Command } from "commander";

const program = new Command()
  .name("legwork")
  .description("A GTM agent fleet with an operating harness. The fleet does the legwork.");

const todo = (verb: string) => () => {
  console.log(`legwork ${verb}: not implemented yet — see docs/PLAN.md priority stack`);
};

program.command("run").description("run the fleet (or one agent) over the pipeline")
  .option("--since <window>", "only consider activity in this window", "7d")
  .option("--agent <name>", "run a single agent")
  .action(todo("run"));
program.command("status").description("run history, per-agent health").option("--costs", "show $ per agent").action(todo("status"));
program.command("evals").description("score every agent against the golden set").action(todo("evals"));
program.command("review").description("approve/reject queued briefs (HITL loop)").action(todo("review"));
program.command("show").description("everything known about one account").argument("<account>").action(todo("show"));
program.command("doctor").description("diagnose a failing run (self-heal loop)").argument("[run]").action(todo("doctor"));
program.command("improve").description("draft a prompt/rubric revision as a PR").argument("<agent>").action(todo("improve"));
program.command("retire").description("generate a retirement post-mortem").argument("<agent>").action(todo("retire"));
program.command("report").description("generate the static status report").action(todo("report"));
program.command("demo").description("seeded deterministic run — offline-safe").action(todo("demo"));

program.parse();
