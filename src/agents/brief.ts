// brief: the account brief, and the Slack-shaped short form.
// Rule 6 — no source, no sentence: the template only formats account.evidence, it never
// adds a fact. Without a model key it is fully deterministic and offline.

import { createHash } from "node:crypto";
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
      const model = await modelBrief(account, ctx, segmentNames);
      let briefMode = "template";
      let rejectReason: string | null = null;
      let body: string;
      if (model) {
        rejectReason = validateModelBrief(model.text, account);
        if (rejectReason === null) {
          briefMode = model.provider === "replay" ? "model-replay" : "model";
          body = ctx.mode === "fixture" ? injectFixtureBanner(model.text) : model.text;
        } else {
          // The citations gate: model output that strays from the evidence never ships.
          body = renderBrief(account, ctx, segmentNames);
        }
      } else {
        body = renderBrief(account, ctx, segmentNames);
      }
      // HITL gate: confidence below the registry bar queues for a human (F7);
      // at or above it, the brief publishes directly.
      const queued = (account.confidence ?? 0) < gate;
      const dir = queued ? join(BRIEFS_DIR, "queue") : BRIEFS_DIR;
      writeFileSync(join(dir, `${account.org}.md`), body);
      writeFileSync(join(dir, `${account.org}.slack.txt`), renderSlack(account, segmentNames, ctx.mode));
      writeFileSync(
        join(dir, `${account.org}.decision.json`),
        JSON.stringify(
          {
            org: account.org,
            brief_mode: briefMode,
            review_gate: gate,
            llm: model
              ? {
                  model: model.model,
                  provider: model.provider,
                  prompt_version: model.promptVersion,
                  latency_ms: model.latencyMs,
                  reject_reason: rejectReason,
                }
              : null,
            qualification: account.qualification ?? null,
          },
          null,
          2,
        ) + "\n",
      );
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

interface ModelBriefResult {
  text: string;
  model: string;
  provider: "api" | "cli" | "replay";
  promptVersion: string;
  latencyMs: number;
}

async function modelBrief(
  account: Account,
  ctx: RunContext,
  segmentNames: Record<string, string>,
): Promise<ModelBriefResult | null> {
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
    qualification_json: JSON.stringify(account.qualification ?? null),
  });

  const model = effective(loadRegistry(), "brief").model;
  const promptVersion = createHash("sha256").update(readFileSync(promptFile)).digest("hex").slice(0, 8);
  const startedAt = Date.now();
  try {
    const response = await ctx.llm.complete({ model, system, prompt: filled, maxTokens: 1200 });
    ctx.costs.charge(model, response.tokens_in, response.tokens_out);
    return {
      text: injectDecisionSection(response.text, account),
      model,
      provider: ctx.llm.kind,
      promptVersion,
      // Replay is a file read; its sub-millisecond timing jitter (0 vs 1) was the one
      // thing keeping decision.json from being byte-deterministic in demo mode.
      latencyMs: ctx.llm.kind === "replay" ? 0 : Date.now() - startedAt,
    };
  } catch (err) {
    // Missing replay fixture or provider failure: the template path is the fallback,
    // never a blank brief and never a crashed run — but never a silent one either.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  ! brief model path unavailable for ${account.org}: ${reason.slice(0, 160)} (template fallback)`);
    return null;
  }
}

// The gate that makes "claims restricted to supplied evidence" structural: required
// sections present, and every link in the body is a URL the evidence actually contains.
function validateModelBrief(body: string, account: Account): string | null {
  const required = ["## Who", "## Production Expo signals", "## Suggested opener"];
  for (const heading of required) {
    if (!body.includes(heading)) return `missing section: ${heading}`;
  }
  const allowed = new Set(account.evidence.map((e) => e.url));
  const links = [...body.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]!);
  if (links.length < 3) return "fewer than 3 receipts";
  for (const url of links) {
    if (!allowed.has(url)) return `uncited URL not in evidence: ${url}`;
  }
  return null;
}

function injectFixtureBanner(body: string): string {
  const lines = body.split("\n");
  const banner = [
    "",
    "> **FIXTURE DATA** — authored sample evidence; source links may not resolve.",
    "> Model output replayed from a recorded fixture. Run `legwork run` (live) for real receipts.",
  ];
  return [lines[0], ...banner, ...lines.slice(1)].join("\n");
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

  lines.push(...renderDecisionSection(account), "");

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
  const action = account.qualification?.action ?? "unknown";
  const header =
    `*${company}* — segment ${segment}${name ? ` (${name})` : ""}, ` +
    `confidence ${(account.confidence ?? 0).toFixed(2)} · action ${action}`;

  const scoreReasons = [...(account.qualification?.signals ?? [])]
    .filter((signal) => signal.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map(
      (signal) =>
        `• score +${signal.contribution.toFixed(2)}: ${signal.name} ` +
        `(${signal.value.toFixed(2)} × ${signal.weight.toFixed(2)})` +
        (signal.evidence_url ? ` ${signal.evidence_url}` : ""),
    );
  const strongest = [...groups.signals, ...groups.store, ...groups.whyNow, ...groups.company].slice(
    0,
    Math.max(0, MAX_SLACK_BULLETS - scoreReasons.length),
  );
  const bullets = strongest.map((e) => `• ${e.claim} (${e.url})`);

  const banner = mode === "fixture" ? ["[FIXTURE DATA — sample evidence, links may not resolve]"] : [];
  return [...banner, header, ...scoreReasons, ...bullets, `full brief: briefs/${account.org}.md`, ""].join("\n");
}

function injectDecisionSection(body: string, account: Account): string {
  const section = renderDecisionSection(account);
  if (section.length === 0) return body;
  const [title, ...rest] = body.trim().split("\n");
  return [title ?? "", "", ...section, "", ...rest].join("\n").trim() + "\n";
}

function renderDecisionSection(account: Account): string[] {
  const decision = account.qualification;
  if (!decision) return [];

  const comparison = decision.score >= decision.threshold ? "meets" : "does not meet";
  const lines = [
    "## Why this score",
    `${decision.score.toFixed(2)} ${comparison} the ${decision.threshold.toFixed(2)} qualification threshold. ` +
      `Proposed action: **${decision.action}**.`,
    "",
  ];

  for (const signal of decision.signals) {
    const math =
      `${signal.value.toFixed(2)} × ${signal.weight.toFixed(2)} = +${signal.contribution.toFixed(2)}`;
    const receipt = signal.evidence_url
      ? ` ([source](${signal.evidence_url}))`
      : " (no public evidence observed; counted as 0)";
    lines.push(`- \`${signal.name}\`: ${math}${receipt}`);
  }

  if (decision.assumptions.length > 0) {
    lines.push("", "**Assumptions and missing evidence**");
    for (const assumption of decision.assumptions) lines.push(`- ${assumption}`);
  }
  lines.push("", `**Fallback:** ${decision.fallback}`);
  return lines;
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
    // Same fact, two refs: discover's code-search hit cites
    // github.com/o/r/blob/<sha>/eas.json while qualify's contents URL cites
    // github.com/o/r/blob/main/eas.json. Canonicalizing the URL for the key alone
    // collapses that pair; the claim stays in the key, so the store's ratings and
    // cadence receipts (two claims, one URL) both still render. First seen wins and
    // renders its ORIGINAL url.
    const key = `${e.claim}|${canonicalReceiptUrl(e.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.agent === "intent") groups.whyNow.push(e);
    else if (isStore(e)) groups.store.push(e);
    else if (COMPANY_AGENTS.has(e.agent)) groups.company.push(e);
    else groups.signals.push(e);
  }
  return groups;
}

// Dedupe key helper: collapses github blob/tree ref variants
// (https://github.com/<owner>/<repo>/(blob|tree)/<ref>/<path> → github.com/<owner>/<repo>/<path>)
// and nothing else — any other URL comes back exactly as given. Never used for display:
// the citations gate (validateModelBrief) and the model both work off raw evidence URLs.
function canonicalReceiptUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.replace(/^www\./, "") !== "github.com") return url;
    const [owner, repo, kind, , ...path] = parsed.pathname.split("/").filter(Boolean);
    if ((kind !== "blob" && kind !== "tree") || path.length === 0) return url;
    return `github.com/${owner}/${repo}/${path.join("/")}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
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
