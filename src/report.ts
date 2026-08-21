// The fleet console: one static page generated from the files the fleet already keeps —
// run log, accounts, briefs, memos, eval baseline. Nothing here is live state; it is a
// window onto the files, regenerated on demand (`legwork report`) or by CI on every run.
//
// Why static: the operator surface is the terminal and the record of truth is git.
// A page that reads those and stages decisions (review cards → one CLI command) gives
// non-terminal humans the comfortable view without creating a second control plane.
//
// The same renderer has a served mode (`legwork serve`), which keeps every byte of the
// static page and adds the buttons that call the local server. Static stays the Pages
// artifact and the fallback: no toolbar, no fetch, nothing that needs a process running.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import { readReviews } from "./review.js";
import { brainStyles, renderBrain } from "./brain.js";
import {
  esc,
  mdToHtml,
  renderQueueCards,
  servedScript,
  servedStyles,
  shell,
  stageBar,
  stageScript,
} from "./reviewhtml.js";
import type { Account, RunRecord } from "./types.js";

const SITE_DIR = "site";

export type Panels = {
  overview: string;
  queue: string;
  briefs: string;
  evals: string;
  memos: string;
  runs: string;
  brain: string;
};

// The six panel bodies, on their own, so `/api/state` can swap them in place without a
// reload. Served is the default here because the only caller that renders panels alone is
// the local server; the static generator passes `served: false` explicitly below.
export function renderPanels(opts: { served?: boolean } = {}): Panels {
  const served = opts.served !== false;
  const registry = loadRegistry();
  const runs = readRuns();
  const accounts = loadAccounts();
  const reviews = readReviews();
  const queued = accounts.filter((a) => a.review?.status === "queued");

  return {
    overview: `
  <p class="lead">Is the fleet healthy, what is it costing, and is anyone waiting on a human? A red dot is a unit whose last run did not finish — the silent-fail case, made loud.</p>
  ${fleetSection(registry.agents, runs, accounts, reviews, served)}
`,
    queue: `
  <p class="lead">Briefs below the confidence gate, waiting for a person. Read the brief, then the score math and the assumptions beside it — the assumptions are where you calibrate. ${
    served
      ? "Approve or reject records the decision on this machine, through the same code path as the CLI."
      : "Approve or reject stages a decision; the command bar records it through the CLI."
  }</p>
  ${renderQueueCards(queued, { served })}
${served ? "" : `  ${stageBar()}\n`}`,
    briefs: `
  <p class="lead">Briefs that cleared the gate or were approved. Every sentence carries its source.</p>
  ${briefsSection(accounts, served)}
`,
    evals: `
  <p class="lead">Every unit is scored against the hand-labeled golden set on each run; a score below this baseline fails CI.</p>
  ${evalsSection(registry.pack)}
`,
    memos: `
  <p class="lead">Units judged on their own run history: what was expected, what it cost, what only it produced, and the verdict.</p>
  ${memosSection()}
`,
    runs: `
  <p class="lead">The last 25 runs, newest first. Mode, outcome, in→out, time, spend, and the compact error if any.</p>
  ${runsSection(runs)}
`,
    // renderBrain supplies its own lead — it reads config off disk at render time, so the
    // panel is always describing the fleet as it is right now, not as it was when built.
    brain: renderBrain({ served }),
  };
}

// The whole page. `served: false` (the default) is the Pages artifact and must stay
// byte-identical to what it has always been; `served: true` adds the operator affordances.
export function renderConsole(opts: { served?: boolean } = {}): string {
  const served = opts.served === true;
  const runs = readRuns();
  const accounts = loadAccounts();
  const queued = accounts.filter((a) => a.review?.status === "queued");
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

  const published = accounts.filter((a) => a.stage === "briefed" && (!a.review || a.review.status === "approved")).length;
  const memoCount = existsSync("memos") ? readdirSync("memos").filter((f) => f.endsWith(".md")).length : 0;
  const panels = renderPanels({ served });
  const body = `${served ? banner() : ""}
<div class="top"><span class="brand">legwork</span><h1>Fleet console</h1><span class="spacer"></span><button class="theme" id="theme">dark mode</button></div>
<p class="sub">Generated ${generatedAt} from the fleet's own files. ${
    served ? "Actions on this page run here, on your machine." : "The terminal acts; this page shows."
  }</p>
<div class="tabs">
  <button data-tab="overview">overview</button>
  <button data-tab="queue">review queue<span class="count">${queued.length}</span></button>
  <button data-tab="briefs">published briefs<span class="count">${published}</span></button>
  <button data-tab="evals">evals</button>
  <button data-tab="memos">retirement memos<span class="count">${memoCount}</span></button>
  <button data-tab="runs">run log<span class="count">${runs.length}</span></button>
  <button data-tab="brain">how it runs</button>
</div>
${served ? toolbar() : ""}
<div class="panel" id="overview">${panels.overview}</div>

<div class="panel" id="queue">${panels.queue}</div>

<div class="panel" id="briefs">${panels.briefs}</div>

<div class="panel" id="evals">${panels.evals}</div>

<div class="panel" id="memos">${panels.memos}</div>

<div class="panel" id="runs">${panels.runs}</div>

<div class="panel" id="brain">${panels.brain}</div>

<footer class="page">legwork · <a href="https://github.com/ravenintheforrest/legwork">repo</a> · recomputed from files on each generation; nothing is cached in this page.</footer>`;

  return served
    ? shell("legwork fleet console", body, servedScript(), servedStyles() + brainStyles)
    : shell("legwork fleet console", body, stageScript(), brainStyles);
}

export function writeConsole(): string {
  mkdirSync(SITE_DIR, { recursive: true });
  const file = join(SITE_DIR, "index.html");
  writeFileSync(file, renderConsole({ served: false }));
  return file;
}

// --- served-only chrome -------------------------------------------------------------

function banner(): string {
  return `\n<div class="opbanner">local operator desk — actions run on your machine</div>`;
}

function toolbar(): string {
  return `<div class="toolbar">
  <button data-run="fixture">Run demo</button>
  <button data-run="live" data-since="90">Run live (90d)</button>
  <button id="op-evals">Re-run evals</button>
  <button id="op-refresh">Refresh</button>
  <span class="chip" id="op-status" data-state="idle">idle</span>
</div>
<pre class="logpane" id="op-log" data-empty="1">— no run yet —</pre>
`;
}

// --- sections -----------------------------------------------------------------------

function fleetSection(
  agents: Record<string, { does: string }>,
  runs: RunRecord[],
  accounts: Account[],
  reviews: { decision: string; confidence: number }[],
  served = false,
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
        <td class="num">$${cost.toFixed(4)}</td>${served ? `\n        <td class="rowact"><button data-retire="${esc(name)}">retire</button></td>` : ""}
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
<table><tr><th>unit</th><th>does</th><th>runs</th><th>failed</th><th>last run</th><th>last outcome</th><th>spend</th>${served ? "<th></th>" : ""}</tr>${rows}</table>
<p class="sub" style="margin-top:8px">Amber: last run ok, but it has failed before.${served ? " Retire writes the memo and opens it below; the PR is still yours to open." : ""}</p>${served ? `\n<div id="retire-out"></div>` : ""}
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
</section>`;
}

function briefsSection(accounts: Account[], served = false): string {
  const published = accounts.filter((a) => a.stage === "briefed" && (!a.review || a.review.status === "approved"));
  if (published.length === 0) return `<section class="block" id="briefs"><h2>Published briefs</h2><p class="empty">none yet — everything is in the review queue.</p></section>`;
  const items = published
    .map((a) => {
      const f = join("briefs", `${a.org}.md`);
      const md = existsSync(f) ? readFileSync(f, "utf8") : "(brief file missing)";
      const send = served
        ? `<div class="briefact"><button data-notify="${esc(a.org)}">Send to Slack</button><span class="note"></span></div>`
        : "";
      return `<details><summary>${esc(a.company ?? a.org)} — segment ${esc(a.segment ?? "?")} · confidence ${(a.confidence ?? 0).toFixed(2)}</summary>${send}<div class="memo">${mdToHtml(md)}</div></details>`;
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
