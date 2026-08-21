// The improvement loop's artifact (registry loops.improve, autonomy tier `propose`).
//
// `legwork improve <agent>` reads the fleet's own operating record — the human review
// decisions and the citations-gate outcomes recorded next to each brief — asks the model
// for a revised prompt file, and writes the revision plus a PR-shaped memo to disk.
//
// It never runs git commit, git branch, git push, or gh. The one child process it spawns
// is `git diff --no-index`, which only reads two files, to render the proposed change.
// A human running the commands in the memo IS the propose tier working as designed.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CostCeilingError, CostMeter } from "./costs.js";
import { makeLLM, ReplayMissError } from "./llm.js";
import { effective, loadRegistry, type Registry } from "./registry.js";
import { readReviews, type ReviewDecision } from "./review.js";
import { appendRun } from "./runlog.js";
import type { RunRecord } from "./types.js";

const MEMO_DIR = join("memos", "improve");
const BRIEFS_DIR = "briefs";
const QUEUE_DIR = join(BRIEFS_DIR, "queue");
const MAX_LIST = 5;
const MAX_TOKENS = 4000;

const NO_EVIDENCE = "No operating evidence recorded yet; propose conservative clarity improvements only.";

export interface ImproveOptions {
  fixture?: boolean;
  captureLlm?: boolean;
}

export async function runImprove(agent: string, opts: ImproveOptions = {}): Promise<void> {
  const registry = loadRegistry();
  const improvable = improvableAgents(registry);
  if (!improvable.includes(agent)) {
    throw new Error(`no owned prompt file for "${agent}" — improvable agents: ${improvable.join(", ")}`);
  }

  const promptsDir = join(registry.pack, "prompts");
  const agentPromptFile = join(promptsDir, `${agent}.md`);
  const improvePromptFile = join(promptsDir, "improve.md");
  if (!existsSync(improvePromptFile)) {
    throw new Error(`missing ${improvePromptFile} — improve has no prompt of its own to run`);
  }

  const currentPrompt = readFileSync(agentPromptFile, "utf8");
  const evidence = gatherEvidence();

  // --capture-llm records a replay fixture from a live call, same semantics as demo.
  const mode: "live" | "fixture" = opts.fixture === true || opts.captureLlm === true ? "fixture" : "live";
  const llm = makeLLM(mode, opts.captureLlm === true);
  if (!llm) {
    console.error(
      "legwork improve: no model provider — set ANTHROPIC_API_KEY, run with LEGWORK_LLM=cli, or pass --fixture to replay a recorded response.",
    );
    console.error("There is no offline fallback here on purpose: a prompt critique invented without a model would be fake work.");
    process.exitCode = 1;
    return;
  }

  // The agent being improved earns its own tier: revising brief runs on brief's model
  // and brief's ceiling, and the spend lands in the run log like any other run (rule 5).
  const config = effective(registry, agent);
  const costs = new CostMeter(config.costCeilingUsd);
  const { system, user } = parsePrompt(readFileSync(improvePromptFile, "utf8"));
  const filled = fill(user, {
    agent,
    current_prompt: currentPrompt,
    operating_evidence: evidence.text,
  });

  const started = new Date();
  let text: string;
  try {
    const response = await llm.complete({ model: config.model, system, prompt: filled, maxTokens: MAX_TOKENS });
    costs.charge(config.model, response.tokens_in, response.tokens_out);
    text = response.text;
  } catch (err) {
    const killed = err instanceof CostCeilingError;
    const reason = compact(err);
    record(started, evidence.items, 0, costs, mode, killed ? "killed_cost_ceiling" : "error", reason);
    console.error(`legwork improve: ${reason}`);
    if (err instanceof ReplayMissError) {
      console.error(`capture one live response with: npx tsx src/cli.ts improve ${agent} --capture-llm`);
    }
    process.exitCode = 1;
    return;
  }

  const checked = gate(text, currentPrompt);
  if (!checked.ok) {
    // Same ethic as the brief citations gate: a broken revision is rejected, never patched
    // into shape. A silently repaired prompt is a prompt nobody reviewed.
    record(started, evidence.items, 0, costs, mode, "error", `gate: ${checked.reason}`);
    console.error(`legwork improve: rejected the model's revision — ${checked.reason}`);
    console.error("Nothing was written. The gate rejects; it never repairs.");
    process.exitCode = 1;
    return;
  }

  mkdirSync(MEMO_DIR, { recursive: true });
  const proposedFile = join(MEMO_DIR, `${agent}.prompt.md`);
  const memoFile = join(MEMO_DIR, `${agent}.md`);
  writeFileSync(proposedFile, checked.revised.endsWith("\n") ? checked.revised : checked.revised + "\n");
  writeFileSync(
    memoFile,
    renderMemo({
      agent,
      title: memoTitle(agent, checked.rationale),
      rationale: checked.rationale,
      evidence: evidence.text,
      agentPromptFile,
      proposedFile,
      provider: llm.kind,
      model: config.model,
      tokensIn: costs.tokensIn,
      tokensOut: costs.tokensOut,
      costUsd: costs.costUsd,
    }),
  );
  record(started, evidence.items, 1, costs, mode, "ok");

  console.log(checked.rationale.trim());
  console.log("");
  // `git diff --no-index` exits 1 whenever the files differ, which here is the success
  // case, so the exit code is deliberately ignored.
  const diff = await gitDiff(agentPromptFile, proposedFile);
  if (diff.trim() !== "") {
    console.log(diff.trimEnd());
    console.log("");
  }
  console.log(`memo ${memoFile}`);
  console.log("propose tier: lands as a PR — commands in the memo.");
}

// Only an agent with an owned prompt file can be improved. improve.md lives in the same
// directory but is improve's own prompt, so the registry membership test excludes it.
function improvableAgents(registry: Registry): string[] {
  const dir = join(registry.pack, "prompts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .filter((name) => registry.agents[name] !== undefined)
    .sort();
}

// --- operating evidence ------------------------------------------------------------
//
// Replay determinism: everything below is a pure function of two file sets — the review
// log and the briefs' decision records. No clock, no run log (runs.jsonl grows on every
// run), no paths from this machine. Same repo state, byte-identical prompt, fixture hit.

interface OperatingEvidence {
  text: string;
  items: number; // source records summarized: reviews + decision files
}

interface DecisionRecord {
  org: string;
  brief_mode: string;
  reject_reason: string | null;
}

function gatherEvidence(): OperatingEvidence {
  const reviews = readReviews();
  const decisions = readDecisions();
  if (reviews.length === 0 && decisions.length === 0) {
    return { text: NO_EVIDENCE, items: 0 };
  }

  const lines: string[] = [];
  if (reviews.length > 0) lines.push(...reviewLines(reviews), "");
  if (decisions.length > 0) lines.push(...decisionLines(decisions), "");
  return { text: lines.join("\n").trim(), items: reviews.length + decisions.length };
}

function reviewLines(reviews: ReviewDecision[]): string[] {
  const approved = reviews.filter((r) => r.decision === "approved");
  const rejected = reviews.filter((r) => r.decision === "rejected");
  const avg = (list: ReviewDecision[]) =>
    list.length === 0 ? "n/a" : (list.reduce((sum, r) => sum + r.confidence, 0) / list.length).toFixed(2);
  const rejectedOrgs = [...new Set(rejected.map((r) => r.org))].sort();
  return [
    `Human review decisions: ${reviews.length} recorded.`,
    `- acceptance rate ${((approved.length / reviews.length) * 100).toFixed(0)}% (${approved.length} approved, ${rejected.length} rejected)`,
    `- average confidence: approved ${avg(approved)}, rejected ${avg(rejected)}`,
    `- rejected orgs${countedCap(rejectedOrgs)}: ${rejectedOrgs.slice(0, MAX_LIST).join(", ") || "none"}`,
  ];
}

function decisionLines(decisions: DecisionRecord[]): string[] {
  const modes = new Map<string, number>();
  for (const d of decisions) modes.set(d.brief_mode, (modes.get(d.brief_mode) ?? 0) + 1);
  const modeText = [...modes.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([mode, count]) => `${mode} ${count}`)
    .join(", ");

  const rejects = decisions.filter((d) => d.reject_reason !== null);
  const lines = [
    `Brief decision records: ${decisions.length} briefs written.`,
    `- brief_mode: ${modeText}`,
    `- citations-gate rejections: ${rejects.length} of ${decisions.length}${countedCap(rejects)}`,
  ];
  for (const d of rejects.slice(0, MAX_LIST)) lines.push(`  - ${d.org}: ${d.reject_reason}`);
  return lines;
}

// "(showing 5 of 9)" whenever a list is longer than the cap, so a truncated list never
// reads as a complete one.
function countedCap(list: unknown[]): string {
  return list.length > MAX_LIST ? ` (showing ${MAX_LIST} of ${list.length})` : "";
}

function readDecisions(): DecisionRecord[] {
  const byOrg = new Map<string, DecisionRecord>();
  for (const dir of [BRIEFS_DIR, QUEUE_DIR]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".decision.json")).sort()) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue; // a half-written decision file is not evidence
      }
      const decision = raw as { org?: string; brief_mode?: string; llm?: { reject_reason?: string | null } | null };
      const org = decision.org ?? file.slice(0, -".decision.json".length);
      if (byOrg.has(org)) continue; // published copy wins over the queued one
      byOrg.set(org, {
        org,
        brief_mode: decision.brief_mode ?? "unknown",
        reject_reason: decision.llm?.reject_reason ?? null,
      });
    }
  }
  return [...byOrg.values()].sort((a, b) => (a.org < b.org ? -1 : 1));
}

// --- the structural gate -----------------------------------------------------------

type GateResult = { ok: true; rationale: string; revised: string } | { ok: false; reason: string };

function gate(response: string, currentPrompt: string): GateResult {
  const heading = response.search(/^##\s+revised prompt\s*$/im);
  if (heading === -1) return { ok: false, reason: "no `## revised prompt` section in the response" };

  const revised = extractFenced(response.slice(heading));
  if (revised === null) return { ok: false, reason: "no closed fenced code block under `## revised prompt`" };

  for (const section of ["system", "user"] as const) {
    if (!hasSection(revised, section)) {
      return { ok: false, reason: `revised prompt has no \`## ${section}\` section` };
    }
  }

  const dropped = placeholders(currentPrompt).filter((name) => !revised.includes(`{{${name}}}`));
  if (dropped.length > 0) {
    return { ok: false, reason: `revised prompt drops placeholders: ${dropped.map((n) => `{{${n}}}`).join(", ")}` };
  }

  if (revised.trim() === currentPrompt.trim()) {
    return { ok: false, reason: "revised prompt is identical to the current one" };
  }

  return { ok: true, rationale: sectionBody(response, "rationale"), revised };
}

function extractFenced(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*```/.test(line));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```\s*$/.test(lines[i]!)) return lines.slice(start + 1, i).join("\n");
  }
  return null;
}

function hasSection(text: string, name: string): boolean {
  return text.split("\n").some((line) => new RegExp(`^##\\s+${name}\\s*$`, "i").test(line.trim()));
}

function sectionBody(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`, "i").test(line.trim()));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))].sort();
}

// --- memo ---------------------------------------------------------------------------

function memoTitle(agent: string, rationale: string): string {
  const first = rationale
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[-*]\s+/.test(line));
  const summary = first ? truncate(first.replace(/^[-*]\s+/, "").replace(/\s+/g, " "), 60) : "prompt revision";
  return `improve(${agent}): ${summary}`;
}

function renderMemo(m: {
  agent: string;
  title: string;
  rationale: string;
  evidence: string;
  agentPromptFile: string;
  proposedFile: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}): string {
  const branch = `improve/${m.agent}`;
  const message = m.title.replace(/["`$\\]/g, "");
  return [
    `# ${m.title}`,
    "",
    "## rationale",
    "",
    m.rationale,
    "",
    "## operating evidence",
    "",
    "What the model was given, verbatim. These are the fleet's own records, not a summary of them.",
    "",
    m.evidence,
    "",
    "## how to land it",
    "",
    "```sh",
    `git switch -c ${branch}`,
    `cp ${m.proposedFile} ${m.agentPromptFile}`,
    "npx tsx src/cli.ts evals        # the regression gate must stay green",
    `git add ${m.agentPromptFile} && git commit -m "${message}"`,
    `git push -u origin ${branch} && gh pr create --fill`,
    "```",
    "",
    `provider ${m.provider} · model ${m.model} · ${m.tokensIn} in / ${m.tokensOut} out tokens · $${m.costUsd.toFixed(4)}`,
    "",
    "*Drafted by `legwork improve` from data/reviews.jsonl and the briefs' decision records.*",
    "*Autonomy tier `propose`: this command writes two files and nothing else. No branch, no commit,*",
    "*no push, no PR. A human runs the commands above, and the evals gate decides.*",
    "",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

// --- plumbing -----------------------------------------------------------------------

function gitDiff(before: string, after: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--no-index", "--", before, after], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => resolve("")); // no git on PATH: skip the diff, keep the memo
    child.on("close", () => resolve(out));
  });
}

function record(
  started: Date,
  inputs: number,
  outputs: number,
  costs: CostMeter,
  mode: "live" | "fixture",
  outcome: RunRecord["outcome"],
  error?: string,
): void {
  appendRun({
    id: `r-${Date.now().toString(36)}-improve`,
    agent: "improve",
    started: started.toISOString(),
    duration_ms: Date.now() - started.getTime(),
    inputs,
    outputs,
    tokens_in: costs.tokensIn,
    tokens_out: costs.tokensOut,
    cost_usd: Number(costs.costUsd.toFixed(6)),
    mode,
    outcome,
    ...(error ? { error } : {}),
  });
}

// Copied from src/agents/brief.ts rather than shared: brief.ts is another agent's file in
// this session. Fold the two back into one helper once the parallel work has landed.
function parsePrompt(source: string): { system: string; user: string } {
  const sections: Record<string, string[]> = { system: [], user: [] };
  let current: string | null = null;
  for (const line of source.split("\n")) {
    const heading = /^##\s+(system|user)\s*$/i.exec(line.trim());
    if (heading) {
      current = heading[1]!.toLowerCase();
      continue;
    }
    if (current) sections[current]!.push(line);
  }
  return { system: sections.system!.join("\n").trim(), user: sections.user!.join("\n").trim() };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

function compact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
}
