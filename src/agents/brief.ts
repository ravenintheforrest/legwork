// brief: the account brief, and the compact operator summary.
// Rule 6 — no source, no sentence: the template only formats account.evidence, it never
// adds a fact. Without a model key it is fully deterministic and offline.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
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
    const out: Account[] = [];
    const artifacts: Array<{ org: string; queued: boolean; body: string; summary: string; decision: string }> = [];

    // Prepare every model result before touching the filesystem. A cost kill or other
    // run failure therefore cannot leave a half-published batch.
    for (const account of queue) {
      const model = await modelBrief(account, ctx, segmentNames);
      let briefMode = "template";
      let rejectReason: string | null = null;
      let body: string;
      if (model) {
        rejectReason = validateModelBrief(model.text, account);
        if (rejectReason === null) {
          briefMode = model.provider === "replay" ? "model-replay" : "model";
          const accepted = injectDecisionSection(model.text, account);
          body = ctx.mode === "fixture" ? injectFixtureBanner(accepted) : accepted;
        } else {
          body = renderBrief(account, ctx, segmentNames);
        }
      } else {
        body = renderBrief(account, ctx, segmentNames);
      }

      const queued = (account.confidence ?? 0) < gate;
      artifacts.push({
        org: account.org,
        queued,
        body,
        summary: renderSummary(account, segmentNames, ctx.mode),
        decision: JSON.stringify(
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
      });
      out.push({
        ...account,
        stage: "briefed",
        updated: ctx.now(),
        ...(queued ? { review: { status: "queued" as const, date: ctx.now() } } : {}),
      });
    }

    mkdirSync(BRIEFS_DIR, { recursive: true });
    mkdirSync(join(BRIEFS_DIR, "queue"), { recursive: true });
    for (const artifact of artifacts) {
      const dir = artifact.queued ? join(BRIEFS_DIR, "queue") : BRIEFS_DIR;
      const stale = artifact.queued ? BRIEFS_DIR : join(BRIEFS_DIR, "queue");
      for (const suffix of [".md", ".summary.txt", ".decision.json"]) {
        rmSync(join(stale, `${artifact.org}${suffix}`), { force: true });
      }
      writeFileSync(join(dir, `${artifact.org}.md`), artifact.body, { mode: 0o600 });
      writeFileSync(join(dir, `${artifact.org}.summary.txt`), artifact.summary, { mode: 0o600 });
      writeFileSync(join(dir, `${artifact.org}.decision.json`), artifact.decision, { mode: 0o600 });
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

  const { system: systemTemplate, user } = parsePrompt(readFileSync(promptFile, "utf8"));
  // The pack's brain is explicit input (rule 2): who the seller is, who they sell to, how
  // they talk, whom to address. It never supplies a fact about the account — the prompt
  // says so — so it can change without changing what counts as evidence.
  const system = fill(systemTemplate, { brain: readBrain(ctx.pack) });
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
  let response;
  try {
    response = await ctx.llm.complete({ model, system, prompt: filled, maxTokens: 1200 });
  } catch (err) {
    // Provider availability has a deterministic template fallback. CostCeilingError is
    // raised after completion below and deliberately remains outside this catch.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  ! brief model path unavailable for ${account.org}: ${reason.slice(0, 160)} (template fallback)`);
    return null;
  }
  ctx.costs.charge(model, response.tokens_in, response.tokens_out);
  return {
    text: response.text,
    model,
    provider: ctx.llm.kind,
    promptVersion,
    latencyMs: ctx.llm.kind === "replay" ? 0 : Date.now() - startedAt,
  };
}

// The gate that makes "claims restricted to supplied evidence" structural: required
// sections present, and every link in the body is a URL the evidence actually contains.
// Lines that state an absence rather than a fact: allowed without a receipt (see below).
const ABSENCE_LINE = /^[-*]?\s*(The evidence (does not|doesn't|cannot|can't|contains no|has no|gives no|lists no|names no|includes no|shows no|offers no|provides no)|No (public )?evidence|Not in the evidence|Nothing in the evidence)\b/i;

export function validateModelBrief(body: string, account: Account): string | null {
  const required = ["## Who", "## Production Expo signals", "## Who to talk to", "## Suggested opener"];
  let last = -1;
  for (const heading of required) {
    const at = body.indexOf(heading);
    if (at < 0) return `missing section: ${heading}`;
    if (at <= last) return `section out of order: ${heading}`;
    last = at;
  }

  const allowed = new Set(account.evidence.map((item) => item.url));
  const links = [...body.matchAll(/\[source\]\((https?:[^)]+)\)/g)].map((match) => match[1]!);
  for (const url of links) {
    if (!allowed.has(url)) return `uncited URL not in evidence: ${url}`;
  }
  if (new Set(links).size < 3) return "fewer than 3 distinct receipts";

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line === "No evidence yet.") continue;
    // A sentence that says the evidence is silent is not a claim about the company; it is
    // the honesty the rules ask for. It may stand without a receipt as long as it asserts
    // nothing else — no URL, and it opens by naming the gap.
    if (ABSENCE_LINE.test(line) && !/https?:\/\//.test(line)) continue;
    if (!line.includes("[source](")) return `claim lacks an evidence receipt: ${line.slice(0, 100)}`;
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

// packs/<pack>/brain/*.md and brain/personas/*.md, concatenated in a stable order with a
// heading per file. Missing folder → empty string, and the prompt's {{brain}} slot says so.
export function readBrain(pack: string): string {
  const dir = join(pack, "brain");
  if (!existsSync(dir)) return "(no brain files in this pack)";
  const order = ["company.md", "customer.md", "offer.md", "voice.md"];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const parts = files.map((f) => `<!-- brain/${f} -->\n${readFileSync(join(dir, f), "utf8").trim()}`);
  const personaDir = join(dir, "personas");
  if (existsSync(personaDir)) {
    for (const f of readdirSync(personaDir).filter((f) => f.endsWith(".md")).sort()) {
      parts.push(`<!-- brain/personas/${f} -->\n${readFileSync(join(personaDir, f), "utf8").trim()}`);
    }
  }
  return parts.length ? parts.join("\n\n") : "(no brain files in this pack)";
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

  lines.push("## Who to talk to");
  if (groups.people.length > 0) for (const e of groups.people) lines.push(bullet(e));
  else lines.push("No evidence yet.");
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

function renderSummary(account: Account, segmentNames: Record<string, string>, mode: "live" | "fixture"): string {
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
  people: Evidence[];  // people receipts (who to talk to)
}

const COMPANY_AGENTS = new Set(["resolve", "enrich"]);

function groupEvidence(evidence: Evidence[]): EvidenceGroups {
  const seen = new Set<string>();
  const groups: EvidenceGroups = { signals: [], company: [], store: [], whyNow: [], people: [] };
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
    else if (e.agent === "people") groups.people.push(e);
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
