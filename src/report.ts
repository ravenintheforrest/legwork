// The fleet console: one static page generated from the files the fleet already keeps —
// run log, accounts, briefs, memos, eval baseline. Nothing here is live state; it is a
// window onto the files, regenerated on demand (`legwork report`) or by CI on every run.
//
// Why static: the operator surface is the terminal and the record of truth is git.
// A page that reads those and stages decisions (review cards → one CLI command) gives
// non-terminal humans the comfortable view without creating a second control plane.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import { readReviews } from "./review.js";
import { esc, mdToHtml, renderQueueCards, shell, stageBar, stageScript } from "./reviewhtml.js";
import type { Account, RunRecord } from "./types.js";

const SITE_DIR = "site";

export function writeConsole(): string {
  const registry = loadRegistry();
  const runs = readRuns();
  const accounts = loadAccounts();
  const reviews = readReviews();
  const queued = accounts.filter((a) => a.review?.status === "queued");
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

  const body = `
<h1>legwork — fleet console</h1>
<p class="sub">static view generated ${generatedAt} from data/runs.jsonl, data/accounts.jsonl, briefs/, memos/. The terminal acts; this page shows.</p>
<nav>
  <a href="#fleet">fleet</a><a href="#evals">evals</a><a href="#queue">review queue (${queued.length})</a>
  <a href="#briefs">published briefs</a><a href="#memos">retirement memos</a><a href="#runs">run log</a>
</nav>
${fleetSection(registry.agents, runs, accounts, reviews)}
${evalsSection(registry.pack)}
<section class="block" id="queue"><h2>Review queue — judge here, record via the command bar</h2>${renderQueueCards(queued)}</section>
${briefsSection(accounts)}
${memosSection()}
${runsSection(runs)}
${stageBar()}
<footer class="page">legwork · <a href="https://github.com/ravenintheforrest/legwork">repo</a> · every number above is recomputed from files on each generation; nothing is cached in this page.</footer>`;

  mkdirSync(SITE_DIR, { recursive: true });
  const file = join(SITE_DIR, "index.html");
  writeFileSync(file, shell("legwork fleet console", body, stageScript()));
  return file;
}

// --- sections -----------------------------------------------------------------------

function fleetSection(
  agents: Record<string, { does: string }>,
  runs: RunRecord[],
  accounts: Account[],
  reviews: { decision: string; confidence: number }[],
): string {
  const names = Object.keys(agents);
  const briefed = accounts.filter((a) => a.stage === "briefed").length;
  const published = accounts.filter((a) => a.stage === "briefed" && (!a.review || a.review.status === "approved")).length;
  const totalCost = runs.reduce((n, r) => n + r.cost_usd, 0);
  const approved = reviews.filter((r) => r.decision === "approved").length;
  const acceptance = reviews.length ? `${Math.round((approved / reviews.length) * 100)}%` : "—";

  const rows = names
    .map((name) => {
      const mine = runs.filter((r) => r.agent === name);
      const last = mine[mine.length - 1];
      const errors = mine.filter((r) => r.outcome !== "ok").length;
      const cost = mine.reduce((n, r) => n + r.cost_usd, 0);
      const dot = !last ? "none" : last.outcome === "ok" ? (errors ? "warn" : "ok") : "err";
      const state = !last ? "never run" : last.outcome;
      return `<tr>
        <td><span class="dot ${dot}"></span>${esc(name)}</td>
        <td class="dimcell">${esc(agents[name]!.does)}</td>
        <td class="num">${mine.length}</td>
        <td class="num">${errors}</td>
        <td>${last ? esc(last.started.slice(0, 16).replace("T", " ")) : "—"}</td>
        <td>${esc(state)}</td>
        <td class="num">$${cost.toFixed(4)}</td>
      </tr>`;
    })
    .join("");

  return `<section class="block" id="fleet"><h2>Fleet</h2>
<div class="kpis">
  <div class="kpi"><div class="v">${names.length}</div><div class="k">units in registry</div></div>
  <div class="kpi"><div class="v">${runs.length}</div><div class="k">runs logged</div></div>
  <div class="kpi"><div class="v">${accounts.length}</div><div class="k">accounts in state</div></div>
  <div class="kpi"><div class="v">${briefed}</div><div class="k">briefed (${published} published)</div></div>
  <div class="kpi"><div class="v">$${totalCost.toFixed(2)}</div><div class="k">model spend, all runs</div></div>
  <div class="kpi"><div class="v">${acceptance}</div><div class="k">review acceptance (${reviews.length} decisions)</div></div>
</div>
<table><tr><th>unit</th><th>does</th><th>runs</th><th>failed</th><th>last run</th><th>last outcome</th><th>spend</th></tr>${rows}</table>
<p class="sub" style="margin-top:8px">A red dot is a unit whose most recent run did not finish — the silent-fail case, made loud. Amber: last run ok, but it has failed before.</p>
</section>`;
}

function evalsSection(pack: string): string {
  const file = join(pack, "evals-baseline.json");
  if (!existsSync(file)) return `<section class="block" id="evals"><h2>Evals</h2><p class="empty">no baseline yet — run <code>legwork evals</code>.</p></section>`;
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  const rows = Object.entries(baseline)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.toFixed(2)}</td></tr>`)
    .join("");
  return `<section class="block" id="evals"><h2>Evals — the regression gate's baseline</h2>
<table><tr><th>metric</th><th>baseline</th></tr>${rows}</table>
<p class="sub" style="margin-top:8px">Every unit is scored against the hand-labeled golden set on each <code>legwork evals</code>; a score below this baseline exits non-zero and fails CI.</p>
</section>`;
}

function briefsSection(accounts: Account[]): string {
  const published = accounts.filter((a) => a.stage === "briefed" && (!a.review || a.review.status === "approved"));
  if (published.length === 0) return `<section class="block" id="briefs"><h2>Published briefs</h2><p class="empty">none yet — everything is in the review queue.</p></section>`;
  const items = published
    .map((a) => {
      const f = join("briefs", `${a.org}.md`);
      const md = existsSync(f) ? readFileSync(f, "utf8") : "(brief file missing)";
      return `<details><summary>${esc(a.company ?? a.org)} — segment ${esc(a.segment ?? "?")} · confidence ${(a.confidence ?? 0).toFixed(2)}</summary><div class="memo">${mdToHtml(md)}</div></details>`;
    })
    .join("\n");
  return `<section class="block" id="briefs"><h2>Published briefs</h2>${items}</section>`;
}

function memosSection(): string {
  if (!existsSync("memos")) return `<section class="block" id="memos"><h2>Retirement memos</h2><p class="empty">none yet.</p></section>`;
  const files = readdirSync("memos").filter((f) => f.endsWith(".md")).sort();
  const items = files
    .map((f) => `<div class="memo">${mdToHtml(readFileSync(join("memos", f), "utf8"))}</div>`)
    .join("\n");
  return `<section class="block" id="memos"><h2>Retirement memos</h2>${items || '<p class="empty">none yet.</p>'}</section>`;
}

function runsSection(runs: RunRecord[]): string {
  const recent = [...runs].slice(-25).reverse();
  const rows = recent
    .map(
      (r) => `<tr>
      <td>${esc(r.started.slice(0, 19).replace("T", " "))}</td><td>${esc(r.agent)}</td><td>${esc(r.mode ?? "—")}</td>
      <td><span class="dot ${r.outcome === "ok" ? "ok" : "err"}"></span>${esc(r.outcome)}</td>
      <td class="num">${r.inputs}→${r.outputs}</td><td class="num">${(r.duration_ms / 1000).toFixed(1)}s</td>
      <td class="num">$${r.cost_usd.toFixed(4)}</td><td class="dimcell">${r.error ? esc(r.error.slice(0, 80)) : ""}</td></tr>`,
    )
    .join("");
  return `<section class="block" id="runs"><h2>Run log — last 25</h2>
<table><tr><th>started</th><th>unit</th><th>mode</th><th>outcome</th><th>in→out</th><th>time</th><th>spend</th><th>error</th></tr>${rows}</table>
</section>`;
}
