// brief: the account brief, and the Slack-shaped short form.
// Rule 6 — no source, no sentence: the template only formats account.evidence, it never
// adds a fact. Without a model key it is fully deterministic and offline.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { effective, loadRegistry } from "../registry.js";

const BRIEFS_DIR = "briefs";
const MAX_SLACK_BULLETS = 6;

// Evidence carries no signal field, so store receipts are identified by their host —
// the only app-store URLs an account can collect.
const STORE_HOSTS = new Set(["apps.apple.com", "play.google.com"]);

export const brief: AgentDef = {
  name: "brief",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const queue = input.filter((a) => a.stage === "qualified");
    if (queue.length === 0) return [];

    const segmentNames = loadSegmentNames(ctx.pack);
    const gate = confidenceGate();
    mkdirSync(BRIEFS_DIR, { recursive: true });
    mkdirSync(join(BRIEFS_DIR, "queue"), { recursive: true });
    const out: Account[] = [];

    for (const account of queue) {
      const body = (await modelBrief(account, ctx, segmentNames)) ?? renderBrief(account, ctx, segmentNames);
      // HITL gate: confidence below the registry bar queues for a human (F7);
      // at or above it, the brief publishes directly.
      const queued = (account.confidence ?? 0) < gate;
      const dir = queued ? join(BRIEFS_DIR, "queue") : BRIEFS_DIR;
      writeFileSync(join(dir, `${account.org}.md`), body);
      writeFileSync(join(dir, `${account.org}.slack.txt`), renderSlack(account, segmentNames, ctx.mode));
      out.push({
        ...account,
        stage: "briefed",
        updated: ctx.now(),
        ...(queued ? { review: { status: "queued" as const, date: ctx.now() } } : {}),
      });
    }

    return out;
  },
};

// --- model path (rule 4: the prompt is an owned file, never inlined here) ---------

async function modelBrief(
  account: Account,
  ctx: RunContext,
  segmentNames: Record<string, string>,
): Promise<string | null> {
  if (!ctx.llm) return null;
  const promptFile = join(ctx.pack, "prompts", "brief.md");
  if (!existsSync(promptFile)) return null;

  const { system, user } = parsePrompt(readFileSync(promptFile, "utf8"));
  const filled = fill(user, {
    company: account.company ?? account.org,
    org: account.org,
    segment: account.segment ?? "",
    segment_name: segmentNames[account.segment ?? ""] ?? "",
    confidence: (account.confidence ?? 0).toFixed(2),
    evidence_json: JSON.stringify(account.evidence),
  });

  const model = effective(loadRegistry(), "brief").model;
  const response = await ctx.llm.complete({ model, system, prompt: filled, maxTokens: 1200 });
  ctx.costs.charge(model, response.tokens_in, response.tokens_out);
  return response.text;
}

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

// --- template path ---------------------------------------------------------------

function renderBrief(account: Account, ctx: RunContext, segmentNames: Record<string, string>): string {
  const company = account.company ?? account.org;
  const groups = groupEvidence(account.evidence);
  const lines: string[] = [];

  lines.push(`# ${company} — account brief`, "");
  lines.push(metaLine(account, segmentNames));
  lines.push(`generated ${ctx.now().slice(0, 10)} · legwork brief (template mode)`, "");
  if (ctx.mode === "fixture") {
    lines.push("> **FIXTURE DATA** — authored sample evidence; source links may not resolve.", "> Run `legwork run` (live mode) for real receipts.", "");
  }

  lines.push("## Production Expo signals");
  for (const e of groups.signals) lines.push(bullet(e));
  lines.push("");

  if (groups.company.length > 0) {
    lines.push("## Company");
    for (const e of groups.company) lines.push(bullet(e));
    lines.push("");
  }

  if (groups.store.length > 0) {
    lines.push("## Scale and velocity");
    for (const e of groups.store) lines.push(bullet(e));
    lines.push("");
  }

  if (groups.whyNow.length > 0) {
    lines.push("## Why now");
    for (const e of groups.whyNow) lines.push(bullet(e));
    lines.push("");
  }

  lines.push("## Suggested opener");
  lines.push(opener(company, groups));
  lines.push("");

  return lines.join("\n");
}

function metaLine(account: Account, segmentNames: Record<string, string>): string {
  const parts = [`org github.com/${account.org}`];
  if (account.domain) parts.push(`domain ${account.domain}`);
  if (account.segment) {
    const name = segmentNames[account.segment];
    parts.push(`segment ${account.segment}${name ? ` (${name})` : ""}`);
  }
  parts.push(`confidence ${(account.confidence ?? 0).toFixed(2)}`);
  return parts.join(" · ");
}

function bullet(e: Evidence): string {
  return `- ${e.claim} ([source](${e.url}))`;
}

// Two or three plain sentences, each fact followed by its receipt. Nothing here is
// asserted that is not already an evidence claim.
function opener(company: string, groups: EvidenceGroups): string {
  const [first, second, third] = [...groups.signals, ...groups.store];
  if (!first) return "";

  const sentences = [`Public evidence that ${company} builds with Expo: ${cite(first)}.`];
  if (second) sentences.push(`Also public: ${cite(second)}.`);
  if (third) {
    sentences.push(isStore(third) ? `On the store side, ${cite(third)}.` : `And ${cite(third)}.`);
  }
  return sentences.join(" ");
}

function cite(e: Evidence): string {
  return `${e.claim} ([source](${e.url}))`;
}

function renderSlack(account: Account, segmentNames: Record<string, string>, mode: "live" | "fixture"): string {
  const company = account.company ?? account.org;
  const groups = groupEvidence(account.evidence);
  const segment = account.segment ?? "";
  const name = segmentNames[segment];
  const header =
    `*${company}* — segment ${segment}${name ? ` (${name})` : ""}, ` +
    `confidence ${(account.confidence ?? 0).toFixed(2)}`;

  const strongest = [...groups.signals, ...groups.store, ...groups.whyNow, ...groups.company].slice(0, MAX_SLACK_BULLETS);
  const bullets = strongest.map((e) => `• ${e.claim} (${e.url})`);

  const banner = mode === "fixture" ? ["[FIXTURE DATA — sample evidence, links may not resolve]"] : [];
  return [...banner, header, ...bullets, `full brief: briefs/${account.org}.md`, ""].join("\n");
}

interface EvidenceGroups {
  signals: Evidence[]; // discover + qualify (repo/profile) receipts
  company: Evidence[]; // resolve + enrich receipts (who they are)
  store: Evidence[];   // app-store receipts
  whyNow: Evidence[];  // intent receipts (timing signals)
}

const COMPANY_AGENTS = new Set(["resolve", "enrich"]);

function groupEvidence(evidence: Evidence[]): EvidenceGroups {
  const seen = new Set<string>();
  const groups: EvidenceGroups = { signals: [], company: [], store: [], whyNow: [] };
  // qualify first: its receipts are the scored signals, in signal order.
  const ordered = [
    ...evidence.filter((e) => e.agent === "qualify"),
    ...evidence.filter((e) => COMPANY_AGENTS.has(e.agent)),
    ...evidence.filter((e) => e.agent !== "qualify" && !COMPANY_AGENTS.has(e.agent)),
  ];
  for (const e of ordered) {
    const key = `${e.claim}|${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.agent === "intent") groups.whyNow.push(e);
    else if (isStore(e)) groups.store.push(e);
    else if (COMPANY_AGENTS.has(e.agent)) groups.company.push(e);
    else groups.signals.push(e);
  }
  return groups;
}

function isStore(e: Evidence): boolean {
  try {
    return STORE_HOSTS.has(new URL(e.url).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

// The gate is registry config, not code (rule 8): loops.review.confidence_gate.
function confidenceGate(): number {
  const loops = loadRegistry().loops as Record<string, Record<string, unknown>>;
  const raw = loops.review?.confidence_gate;
  return typeof raw === "number" ? raw : 0.8;
}

function loadSegmentNames(pack: string): Record<string, string> {
  const icp = yaml.load(readFileSync(join(pack, "icp.yaml"), "utf8")) as {
    segments?: Record<string, { name?: string }>;
  };
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(icp.segments ?? {})) {
    if (value?.name) names[key] = value.name;
  }
  return names;
}
