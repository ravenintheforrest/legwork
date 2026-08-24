// The console, third pass: four screens, one job each.
//
//   Inbox    — what needs a decision, and the one line of what the last run changed.
//   Accounts — every lead, where it got to, and one account view for reading any of them.
//   Search   — one configurable form that is honest about what it will do and what it needs.
//   System   — everything about the machine: health, the log, the answer key, the memos,
//              what this is, what it believes, and the config. Nothing from here leaks
//              onto the other three screens.
//
// Same rules as ever: a static build renders commands where the served build has buttons;
// the record of truth is the files; nothing here is a second control plane. The previous
// console remains at /v2 (served) and site/v2.html (static) until nobody misses it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE } from "./agents/index.js";
import { renderBrain, brainStyles, type Section } from "./brain.js";
import { loadRegistry } from "./registry.js";
import { lastRunCluster, readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import { readReviews } from "./review.js";
import { listTriggers, renderTriggers, triggerStyles } from "./triggers.js";
import {
  esc,
  queueHeadline,
  segmentNames,
  renderReviewCard,
  servedScript,
  servedStyles,
  shell,
  stageBar,
  stageScript,
} from "./reviewhtml.js";
import { evalsSection, fleetTable, funnelBlock, healthRows, memosSection, runsSection, sourceLabel } from "./report.js";
import type { Account, RunRecord } from "./types.js";

const SITE_DIR = "site";

export type PanelsV3 = {
  inbox: string;
  accounts: string;
  search: string;
  system: string;
};

export function renderPanelsV3(opts: { served?: boolean } = {}): PanelsV3 {
  const served = opts.served !== false;
  const runs = readRuns();
  const accounts = loadAccounts();
  const queued = accounts
    .filter((a) => a.review?.status === "queued")
    .sort((x, y) => (y.qualification?.score ?? 0) - (x.qualification?.score ?? 0) || (x.org < y.org ? -1 : 1));

  return {
    inbox: inboxPanel(served, runs, accounts, queued),
    accounts: accountsPanel(served, accounts),
    search: searchPanel(served, runs, accounts),
    system: systemPanel(served, runs),
  };
}

export function renderConsoleV3(opts: { served?: boolean; requestToken?: string } = {}): string {
  const served = opts.served === true;
  const runs = readRuns();
  const accounts = loadAccounts();
  const queued = accounts.filter((a) => a.review?.status === "queued").length;
  const companies = accounts.filter((a) => a.kind === "org").length;
  const mode = accounts.find((a) => a.mode)?.mode ?? null;
  const badge =
    mode === "live"
      ? `<span class="modebadge" data-mode="live" title="accounts in data/ came from live sources">LIVE</span>`
      : mode === "fixture"
        ? `<span class="modebadge" data-mode="fixture" title="accounts in data/ are authored samples; receipts may not resolve">SAMPLE DATA</span>`
        : "";
  const facts = lastRunFacts(runs, accounts);
  const panels = renderPanelsV3({ served });

  const body = `<div class="top"><a class="brand" href="#inbox" data-tab-go="inbox">legwork</a>${badge}${
    facts ? `<span class="lastrun">last search ${esc(facts.ago)}</span>` : ""
  }<span class="spacer"></span><button class="theme" id="theme">dark mode</button></div>
<nav class="tabs" aria-label="sections">
  <button data-tab="inbox">Inbox<span class="count">${queued}</span></button>
  <button data-tab="accounts">Accounts<span class="count">${companies}</span></button>
  <button data-tab="search">Search</button>
  <button data-tab="system">System</button>
</nav>
<div class="panel" id="inbox">${panels.inbox}</div>

<div class="panel" id="accounts">${panels.accounts}</div>

<div class="panel" id="search">${panels.search}</div>

<div class="panel" id="system">${panels.system}</div>

<footer class="page">legwork · reads the fleet's own files on every render · ${
    served ? `actions run here, on your machine · <button class="linkish" id="op-refresh">re-read the files</button>` : "the terminal acts; this page shows"
  } · <a href="/v2">the previous console</a> · <a href="https://github.com/ravenintheforrest/legwork">repo</a></footer>`;

  const tokenBootstrap = `window.__LEGWORK_TOKEN__=${JSON.stringify(opts.requestToken ?? "")};\n`;
  return served
    ? shell("legwork", body, tokenBootstrap + servedScript() + v3Script(true), v3Styles + servedStyles() + brainStyles + triggerStyles)
    : shell("legwork", body, stageScript() + v3Script(false), v3Styles + brainStyles + triggerStyles);
}

export function writeConsoleV3(): string {
  mkdirSync(SITE_DIR, { recursive: true });
  const file = join(SITE_DIR, "index.html");
  writeFileSync(file, renderConsoleV3({ served: false }));
  return file;
}

// --- inbox ------------------------------------------------------------------------------

function inboxPanel(served: boolean, runs: RunRecord[], accounts: Account[], queued: Account[]): string {
  const facts = lastRunFacts(runs, accounts);
  const since = facts
    ? `<p class="sinceline">Since the last search (${esc(facts.mode ?? "?")}, ${esc(facts.ago)}): ${facts.discovered} lead${facts.discovered === 1 ? "" : "s"} touched · ${facts.briefs} brief${facts.briefs === 1 ? "" : "s"} written · ${facts.entered} entered review · ${
        facts.failures.length ? `<strong>${esc(facts.failures.join(", "))} failed</strong>` : "no failures"
      } · $${facts.cost.toFixed(2)}</p>`
    : "";

  if (queued.length === 0) {
    return `${since}
  <h1 class="headline">${queueHeadline(0)}</h1>
  <p class="sub">When a brief scores under the publish line, it lands here for your call. <button class="linkish" data-tab-go="search">Search for more</button>${accounts.length ? ` or <button class="linkish" data-tab-go="accounts">read the accounts</button>.` : "."}</p>`;
  }

  const items = queued
    .map(
      (a, i) => `<button class="qitem${i === 0 ? " active" : ""}" data-org="${esc(a.org)}">
      <span class="qname">${esc(a.company ?? a.org)}</span>
      <span class="qmeta">${(a.qualification?.score ?? 0).toFixed(2)} · ${esc(sourceLabel(a))}</span>
    </button>`,
    )
    .join("\n");
  const cards = queued
    .map((a, i) => `<div class="qcard" data-org="${esc(a.org)}"${i === 0 ? "" : " hidden"}>${renderReviewCard(a, { served, actions: true })}</div>`)
    .join("\n");

  return `${since}
  <h1 class="headline">${queueHeadline(queued.length)}</h1>
  <div class="inboxwrap">
    <nav class="qlist" aria-label="review queue">
${items}
    </nav>
    <div class="qcards">
${cards}
    </div>
  </div>
  <p class="dimline keys">keys: <code>j</code>/<code>k</code> next/previous · <code>a</code> send · <code>r</code> not a fit · <code>l</code> later</p>
${served ? "" : `  ${stageBar()}\n`}`;
}

// --- accounts ---------------------------------------------------------------------------

type Bucket = "brief" | "held" | "individual" | "unresolved";

function bucketOf(a: Account): { bucket: Bucket; text: string; dot: "ok" | "warn" | "none" | "err" } {
  if (a.kind === "user") return { bucket: "individual", text: "individual, excluded", dot: "none" };
  if (a.stage === "briefed") {
    if (a.review?.status === "queued") return { bucket: "brief", text: "brief · waiting for review", dot: "warn" };
    if (a.review?.status === "rejected") return { bucket: "brief", text: "brief · not a fit", dot: "err" };
    return { bucket: "brief", text: "brief · published", dot: "ok" };
  }
  if (!a.kind) return { bucket: "unresolved", text: "not resolved to a company", dot: "none" };
  const prod = a.qualification?.signals.find((s) => s.name === "production_evidence")?.value;
  return { bucket: "held", text: prod ? "held · under the bar" : "held · no production evidence", dot: "none" };
}

function accountsPanel(served: boolean, accounts: Account[]): string {
  if (accounts.length === 0) {
    return `<p class="empty">Nothing yet. <button class="linkish" data-tab-go="search">Run a search</button> and every lead it touches shows up here.</p>`;
  }
  const rank = (a: Account) => (a.stage === "briefed" ? 3 : a.kind === "org" ? 2 : !a.kind ? 1 : 0);
  const sorted = [...accounts].sort(
    (x, y) => rank(y) - rank(x) || (y.qualification?.score ?? 0) - (x.qualification?.score ?? 0) || (x.company ?? x.org).localeCompare(y.company ?? y.org),
  );
  const sources = [...new Set(sorted.map((a) => sourceLabel(a)))].filter((s) => s !== "—").sort();
  const segments = [...new Set(sorted.map((a) => a.segment).filter(Boolean))].sort() as string[];
  const segNames = segmentNames();

  const rows = sorted
    .map((a) => {
      const st = bucketOf(a);
      const name = a.company ?? a.org;
      const detail = a.kind === "org";
      return `<tr${detail ? ` data-org="${esc(a.org)}"` : ""} data-bucket="${st.bucket}" data-src="${esc(sourceLabel(a))}" data-seg="${esc(a.segment ?? "")}" data-name="${esc(`${name} ${a.domain ?? ""}`.toLowerCase())}">
      <td>${a.domain ? `<a class="receipt namelink" href="https://${esc(a.domain)}/" data-receipt data-claim="${esc(name)} — homepage">${esc(name)}</a>` : esc(name)}${a.domain ? `<div class="dimcell" style="font-size:12.5px">${esc(a.domain)}</div>` : ""}</td>
      <td><span class="dot ${st.dot}"></span>${esc(st.text)}</td>
      <td class="dimcell">${esc(sourceLabel(a))}</td>
      <td class="num">${a.qualification ? a.qualification.score.toFixed(2) : "—"}</td>
      <td>${a.segment ? `<span title="${esc(segNames[a.segment] ?? "")}">${esc(a.segment)}${segNames[a.segment] ? ` · ${esc(segNames[a.segment])}` : ""}</span>` : "—"}</td>
      <td class="dimcell">${esc((a.updated ?? "").slice(0, 10))}</td>
    </tr>`;
    })
    .join("");

  const cards = sorted
    .filter((a) => a.kind === "org")
    .map((a) => `<div class="qcard" data-org="${esc(a.org)}" hidden>${renderReviewCard(a, { served, actions: true })}</div>`)
    .join("\n");

  return `
  <div class="filterbar">
    <input id="acct-q" type="search" placeholder="filter by name or domain" aria-label="filter accounts">
    <select id="acct-status" aria-label="status"><option value="">every status</option><option value="brief">brief</option><option value="held">held</option><option value="individual">individual</option><option value="unresolved">unresolved</option></select>
    <select id="acct-src" aria-label="found by"><option value="">every source</option>${sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    ${segments.length ? `<select id="acct-seg" aria-label="segment"><option value="">every segment</option>${segments.map((s) => `<option value="${esc(s)}">${esc(s)}${segNames[s] ? ` — ${esc(segNames[s])}` : ""}</option>`).join("")}</select>` : ""}
    <span class="dimline" id="acct-count"></span>
    <span class="spacer"></span>
    <button class="pill quiet" id="acct-csv" title="download the table, as filtered, as a CSV">Export CSV</button>
    <button class="pill quiet" id="acct-copy-briefs" title="copy every visible account's brief as one Markdown document">Copy briefs</button>
  </div>
  <table class="accounts" id="acct-table"><tr><th>company</th><th>where it got to</th><th>found by</th><th>score</th><th>segment</th><th>last changed</th></tr>${rows}</table>
  <div id="acct-detail" class="qcards">
${cards}
  </div>
  ${funnelBlock(accounts)}`;
}

// --- search ------------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  discover: "GitHub code search — public repos with an eas.json",
  "discover-jobs": "Job boards — HN, Remotive, web search, a company's own ATS board",
  "discover-issues": "Expo's issue trackers — engineers with a company on their profile",
  "discover-gitlab": "GitLab — public projects using Expo",
};

function searchPanel(served: boolean, runs: RunRecord[], accounts: Account[]): string {
  const discovery = PIPELINE.filter((n) => n.startsWith("discover"));
  const sources = discovery
    .map(
      (n) => `<label class="choice"><input type="checkbox" name="src" value="${esc(n)}" checked> ${esc(SOURCE_LABELS[n] ?? n)}</label>`,
    )
    .join("\n      ");
  const windows = [7, 30, 90]
    .map((d) => `<label class="choice"><input type="radio" name="window" value="${d}"${d === 90 ? " checked" : ""}> last ${d} days</label>`)
    .join("\n      ");

  const facts = lastRunFacts(runs, accounts);
  const last = facts
    ? `<section class="block" id="last-search"><h2>The last search</h2>
  <p class="sub">${esc(facts.mode ?? "?")}, ${esc(facts.ago)} — ${facts.units} unit${facts.units === 1 ? "" : "s"} ran · ${facts.discovered} lead${facts.discovered === 1 ? "" : "s"} touched · ${facts.briefs} brief${facts.briefs === 1 ? "" : "s"} written · ${facts.entered} entered review · ${
        facts.failures.length ? `<strong>${esc(facts.failures.join(", "))} failed</strong>` : "no failures"
      } · $${facts.cost.toFixed(2)} spent</p>
</section>`
    : "";

  return `
  <h1 class="headline">Search the public web for companies.</h1>
  <form class="form" id="search-form" onsubmit="return false">
    <div class="fieldset"><span class="label">Look at</span>
    <div class="choices">
      ${sources}
    </div></div>
    <div class="fieldset"><span class="label">Activity window</span>
    <div class="choices">
      ${windows}
    </div></div>
    <div class="fieldset"><span class="label">Options</span>
    <div class="choices">
      <label class="choice"><input type="checkbox" id="opt-cli" checked> model-written briefs, through the Claude CLI</label>
      <label class="choice"><input type="checkbox" id="opt-refresh"> refresh known accounts — re-score and re-brief everything</label>
    </div></div>
    ${served ? `<div class="dimline" id="preflight">checking what this machine has…</div>` : ""}
    ${
      served
        ? `<div class="searchrow"><button class="pill primary" id="go-search">Search</button><span class="chip" id="op-status" data-state="idle">idle</span></div>`
        : `<div class="fieldset"><span class="label">This page cannot run anything — copy the command</span><div id="cmd-preview" class="cmdline"><code></code><button class="linkish" id="copy-cmd" type="button">copy</button></div></div>`
    }
  </form>
  ${served ? `<pre class="logpane" id="op-log" data-empty="1"></pre>` : ""}
  ${last}
  <p class="dimline">Offline instead: <button class="linkish" id="replay-sample">replay the sample data</button> — deterministic, never touches the network${served ? ", and replaces your live accounts with the sample cast until the next live search" : ""}.</p>`;
}

// --- system ------------------------------------------------------------------------------

function systemPanel(served: boolean, runs: RunRecord[]): string {
  let agents: string[] = [];
  try {
    agents = Object.keys(loadRegistry().agents);
  } catch {
    agents = [];
  }
  let triggers: ReturnType<typeof listTriggers> = [];
  try {
    triggers = listTriggers();
  } catch {
    triggers = [];
  }
  let gate = 0.7;
  try {
    const loops = loadRegistry().loops as Record<string, Record<string, unknown>>;
    if (typeof loops.review?.confidence_gate === "number") gate = loops.review.confidence_gate as number;
  } catch { /* the dial still renders with the default shown */ }
  let bar = 0.5;
  try {
    const yaml = require("js-yaml") as typeof import("js-yaml");
    const icp = yaml.load(readFileSync(join(packOf(), "icp.yaml"), "utf8")) as { thresholds?: { qualify_at?: number } };
    if (typeof icp?.thresholds?.qualify_at === "number") bar = icp.thresholds.qualify_at;
  } catch { /* same */ }
  const before: Section[] = [
    {
      id: "sys-dials",
      nav: "The dials",
      heading: "The dials",
      body: served
        ? `<p class="sub">The two numbers that decide what you see. Saving edits the config file — the same edit you could make in the repo, visible in git like any other.</p>
  <div class="dials">
    <label class="dial">qualification bar <input id="dial-bar" type="number" min="0.2" max="0.9" step="0.05" value="${bar.toFixed(2)}"> <span class="dimline">production evidence + at least this score → a brief is written</span></label>
    <label class="dial">publish line <input id="dial-gate" type="number" min="0.3" max="0.95" step="0.05" value="${gate.toFixed(2)}"> <span class="dimline">at or above publishes on its own; below waits in the Inbox</span></label>
    <div class="searchrow"><button class="pill" id="save-dials">Save</button><span class="dimline" id="dials-note"></span></div>
  </div>`
        : `<p class="sub">The qualification bar is ${bar.toFixed(2)} (icp.yaml thresholds.qualify_at); the publish line is ${gate.toFixed(2)} (registry.yaml loops.review.confidence_gate). The served console can change both; this copy only reports them.</p>`,
    },
    {
      id: "sys-health",
      nav: "Is it healthy",
      heading: "Is it healthy",
      // healthRows was written for the v2 tabs; System hosts the same content as folds.
      body: `<div class="health">
    ${healthRows(agents, runs, triggers, served)
      .split('data-tab-go="runs">See the run log').join('data-open-details="fold-sys-runs">See the run log')
      .split('data-open-details="triggers-detail">Which ones').join('data-open-details="fold-sys-triggers">Which ones')
      .split('data-tab-go="memos">Read the case to drop it').join('data-open-details="fold-sys-memos">Read the case to drop it')}
    </div>
    <details class="detail-block"><summary>Every unit, in detail</summary>
    ${fleetTable(agents, runs, served)}
    </details>${served ? `\n<div id="retire-out"></div>` : ""}`,
    },
    { id: "sys-runs", nav: "Run log", heading: "The run log", body: inner(runsSection(runs)) },
    { id: "sys-evals", nav: "The answer key", heading: "The answer key", body: inner(evalsSection(packOf())) },
    { id: "sys-memos", nav: "Retirement memos", heading: "Retirement memos", body: inner(memosSection()) },
    { id: "sys-triggers", nav: "What starts a run", heading: "What starts a run", body: inner(renderTriggers({ served })) },
  ];
  return renderBrain({
    served,
    before,
    lead: "The machine. Open what you need; nothing here is required to review an account.",
  });
}

function packOf(): string {
  try {
    return loadRegistry().pack;
  } catch {
    return join("packs", "expo");
  }
}

// The section helpers render themselves as full blocks for the v2 page; System nests them
// under its own headings, so the outer wrapper and duplicate heading come off here.
function inner(sectionHtml: string): string {
  return sectionHtml.replace(/^<section class="block"[^>]*>\s*<h2>[^<]*<\/h2>/, "").replace(/<\/section>\s*$/, "");
}

// --- the last run, as facts --------------------------------------------------------------

interface RunFacts {
  started: string;
  ago: string;
  mode: string | null;
  units: number;
  discovered: number;
  briefs: number;
  entered: number;
  failures: string[];
  cost: number;
}

function lastRunFacts(runs: RunRecord[], accounts: Account[]): RunFacts | null {
  const cluster = lastRunCluster(runs);
  if (cluster.length === 0) return null;
  const started = cluster[0]!.started;
  const last = cluster[cluster.length - 1]!;
  const endedMs = Date.parse(last.started) + (Number.isFinite(last.duration_ms) ? last.duration_ms : 0);
  return {
    started,
    ago: ago(endedMs),
    mode: cluster[0]!.mode ?? null,
    units: cluster.length,
    discovered: cluster.filter((r) => r.agent.startsWith("discover")).reduce((n, r) => n + r.outputs, 0),
    briefs: cluster.filter((r) => r.agent === "brief").reduce((n, r) => n + r.outputs, 0),
    entered: accounts.filter((a) => a.review?.status === "queued" && a.review.date >= started).length,
    failures: cluster.filter((r) => r.outcome !== "ok").map((r) => r.agent),
    cost: cluster.reduce((n, r) => n + r.cost_usd, 0),
  };
}

function ago(endedMs: number): string {
  if (!Number.isFinite(endedMs)) return "at an unknown time";
  const mins = Math.max(0, Math.round((Date.now() - endedMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// --- client ------------------------------------------------------------------------------

const v3Styles = `  .lastrun { color:var(--faint); font-size:13px; }
  .sinceline { color:var(--dim); font-size:14px; margin-bottom:26px; }
  .sinceline strong { color:var(--no); font-weight:600; }
  .dimline { color:var(--dim); font-size:13.5px; }
  .keys { margin-top:22px; } .keys code { font-size:11.5px; }
  .inboxwrap { display:grid; grid-template-columns:270px minmax(0,1fr); gap:28px; align-items:start; }
  @media (max-width: 900px) { .inboxwrap { grid-template-columns:1fr; } }
  .qlist { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:16px; overflow:hidden; position:sticky; top:16px; }
  .qitem { display:flex; flex-direction:column; gap:3px; padding:14px 16px; text-align:left; background:transparent; border:0; border-radius:0; cursor:pointer; border-left:2px solid transparent; }
  .qitem + .qitem { border-top:1px solid var(--line); }
  .qitem:hover { background:var(--bg-2); border-color:var(--line); border-left-color:var(--line-strong); }
  .qitem.active { border-left-color:var(--text); background:var(--bg-2); }
  .qitem.done { opacity:.45; }
  .qname { font-weight:600; font-size:15px; } .qmeta { font-size:12.5px; color:var(--dim); }
  .qcards .qcard[hidden] { display:none; }
  .qcards .card.review { margin-bottom:0; }
  .filterbar { display:flex; gap:10px; margin:6px 0 18px; flex-wrap:wrap; align-items:center; }
  .filterbar input, .filterbar select { background:var(--bg); border:1px solid var(--line-strong); border-radius:10px; padding:8px 12px; font:inherit; font-size:14px; color:var(--text); }
  .filterbar input { min-width:220px; }
  #acct-table tr[data-org] { cursor:pointer; }
  #acct-table tr[data-org]:hover td { background:var(--bg-2); }
  #acct-table tr[hidden] { display:none; }
  #acct-detail { margin-top:26px; }
  .form { display:flex; flex-direction:column; gap:24px; max-width:640px; margin-bottom:30px; }
  .fieldset { display:flex; flex-direction:column; gap:10px; }
  .fieldset .label { font-size:13px; color:var(--dim); }
  .choices { display:flex; gap:10px; flex-wrap:wrap; }
  .choice { display:inline-flex; gap:9px; align-items:center; border:1px solid var(--line-strong); border-radius:999px; padding:9px 16px; font-size:14px; cursor:pointer; line-height:1.35; }
  .choice input { accent-color: var(--text); margin:0; }
  .choice:has(input:checked) { border-color:var(--text); }
  .searchrow { display:flex; gap:14px; align-items:center; }
  .searchrow .pill.primary { padding:12px 30px; font-size:15px; }
  .cmdline { display:flex; gap:12px; align-items:center; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:10px 14px; }
  .cmdline code { background:transparent; border:0; font-size:12.5px; word-break:break-all; }
`;

function v3Script(served: boolean): string {
  return `
  // v3 chrome: list/detail selection, filters, the search form, keyboard. Shares one
  // script scope with the served helpers (api, startRun, setStatus) when they exist.
  (function () {
    function pickIn(scope, org) {
      scope.querySelectorAll(".qcard").forEach((c) => { c.hidden = c.dataset.org !== org; });
      scope.querySelectorAll(".qitem").forEach((i) => i.classList.toggle("active", i.dataset.org === org));
    }
    document.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      const item = t.closest(".qitem");
      if (item) { pickIn(item.closest(".panel"), item.dataset.org); return; }
      if (t.closest("a[data-receipt]")) return; // a receipt link opens the drawer, not the row
      const row = t.closest("#acct-table tr[data-org]");
      if (row) {
        const panel = row.closest(".panel");
        pickIn(panel, row.dataset.org);
        const detail = panel.querySelector("#acct-detail .qcard:not([hidden])");
        if (detail) detail.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    });

    // Inbox keyboard: j/k move, a/r/l decide, on the visible card.
    document.addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const typing = /^(input|textarea|select)$/i.test((document.activeElement || {}).tagName || "");
      if (typing) return;
      const inbox = document.getElementById("inbox");
      if (!inbox || !inbox.classList.contains("active")) return;
      const items = [...inbox.querySelectorAll(".qitem")];
      if (!items.length) return;
      const at = items.findIndex((i) => i.classList.contains("active"));
      if (ev.key === "j" || ev.key === "k") {
        const next = items[Math.min(items.length - 1, Math.max(0, at + (ev.key === "j" ? 1 : -1)))];
        if (next) next.click();
        ev.preventDefault();
        return;
      }
      const acts = { a: "approve", r: "reject", l: "later" };
      if (acts[ev.key]) {
        const card = inbox.querySelector('.qcards .qcard:not([hidden]) .card.review');
        const btn = card && card.querySelector('footer button[data-act="' + acts[ev.key] + '"]');
        if (btn && !btn.disabled) btn.click();
        ev.preventDefault();
      }
    });

    // A decided card gets .settled (served) — grey its list item and advance.
    new MutationObserver((muts) => {
      for (const m of muts) {
        const card = m.target;
        if (!(card instanceof Element) || !card.classList.contains("settled")) continue;
        const wrap = card.closest(".qcard");
        const inbox = card.closest("#inbox");
        if (!wrap || !inbox) continue;
        const item = inbox.querySelector('.qitem[data-org="' + wrap.dataset.org + '"]');
        if (item) item.classList.add("done");
        const nextItem = [...inbox.querySelectorAll(".qitem:not(.done)")].find((i) => i.dataset.org !== wrap.dataset.org);
        if (nextItem) setTimeout(() => nextItem.click(), 600);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });

    // Accounts toolbar: CSV of the filtered table; every visible brief as one Markdown doc.
    function visibleRows() {
      return [...document.querySelectorAll("#acct-table tr")].slice(1).filter((r) => !r.hidden);
    }
    const csvBtn = document.getElementById("acct-csv");
    if (csvBtn) csvBtn.addEventListener("click", () => {
      const cell = (td) => '"' + (td ? td.innerText.replace(/\\s+/g, " ").trim().replace(/"/g, '""') : "") + '"';
      const lines = ["company,status,found by,score,segment,last changed"];
      for (const row of visibleRows()) lines.push([...row.children].map(cell).join(","));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\\n")], { type: "text/csv" }));
      a.download = "legwork-accounts.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const copyBriefs = document.getElementById("acct-copy-briefs");
    if (copyBriefs) copyBriefs.addEventListener("click", () => {
      const orgs = visibleRows().map((r) => r.dataset.org).filter(Boolean);
      const docs = [];
      for (const org of orgs) {
        const pre = document.querySelector('#acct-detail .qcard[data-org="' + org + '"] .brieftext');
        if (pre) docs.push(pre.textContent.trim());
      }
      if (!docs.length) { copyBriefs.textContent = "No briefs in view"; setTimeout(() => { copyBriefs.textContent = "Copy briefs"; }, 1600); return; }
      navigator.clipboard.writeText(docs.join("\\n\\n---\\n\\n")).then(() => {
        copyBriefs.textContent = "Copied " + docs.length;
        setTimeout(() => { copyBriefs.textContent = "Copy briefs"; }, 1600);
      });
    });

    // Accounts filters.
    function applyFilters() {
      const q = (document.getElementById("acct-q") || {}).value || "";
      const bucket = (document.getElementById("acct-status") || {}).value || "";
      const src = (document.getElementById("acct-src") || {}).value || "";
      const seg = (document.getElementById("acct-seg") || {}).value || "";
      const rows = [...document.querySelectorAll("#acct-table tr")].slice(1);
      let shown = 0;
      for (const row of rows) {
        const ok = (!q || (row.dataset.name || "").includes(q.toLowerCase()))
          && (!bucket || row.dataset.bucket === bucket)
          && (!src || row.dataset.src === src)
          && (!seg || row.dataset.seg === seg);
        row.hidden = !ok;
        if (ok) shown++;
      }
      const count = document.getElementById("acct-count");
      if (count) count.textContent = shown === rows.length ? "" : shown + " of " + rows.length;
    }
    for (const id of ["acct-q", "acct-status", "acct-src", "acct-seg"]) {
      document.addEventListener("input", (ev) => { if (ev.target && ev.target.id === id) applyFilters(); });
    }

    // The search form.
    function formConfig() {
      const srcs = [...document.querySelectorAll('#search-form input[name="src"]')];
      const skip = srcs.filter((c) => !c.checked).map((c) => c.value);
      const windowEl = document.querySelector('#search-form input[name="window"]:checked');
      return {
        mode: "live",
        sinceDays: windowEl ? Number(windowEl.value) : 90,
        skip,
        cli: Boolean((document.getElementById("opt-cli") || {}).checked),
        refresh: Boolean((document.getElementById("opt-refresh") || {}).checked),
      };
    }
${
    served
      ? `    const go = document.getElementById("go-search");
    if (go) go.addEventListener("click", async () => {
      const cfg = formConfig();
      setStatus("running", "searching · live");
      writeLog("");
      try { await api("/api/run", cfg); await pollRun(); } catch (e) { fail(e); }
    });
    const replay = document.getElementById("replay-sample");
    if (replay) replay.addEventListener("click", () => {
      if (!confirm("Replaying the sample replaces your live accounts with the sample cast until the next live search. Continue?")) return;
      startRun("fixture");
    });
    // The dials and the brain editors: each Save is one validated file write on the server.
    document.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest("#save-dials")) {
        const note = document.getElementById("dials-note");
        try {
          const body = { qualify_at: Number(document.getElementById("dial-bar").value), publish_gate: Number(document.getElementById("dial-gate").value) };
          await api("/api/config", body);
          if (note) note.textContent = "Saved. The bar applies on the next search; the publish line applies immediately.";
        } catch (e) { if (note) note.textContent = (e && e.message) || String(e); }
        return;
      }
      const edit = t.closest("[data-edit-brain]");
      if (edit) { const f = edit.closest(".editwrap").querySelector("form"); f.hidden = !f.hidden; return; }
      const save = t.closest("[data-save-brain]");
      if (save) {
        const form = save.closest("form");
        const note = form.querySelector(".brainedit-note");
        try {
          await api("/api/brain", { file: form.dataset.file, content: form.querySelector("textarea").value });
          note.textContent = "Saved. The next run reads it.";
          await refreshPanels();
        } catch (e) { note.textContent = (e && e.message) || String(e); }
      }
    });
    function fillPreflight() {
      return api("/api/preflight").then((p) => {
      const el = document.getElementById("preflight");
      if (!el) return;
      const bits = [
        p.github_token ? "GitHub token ✓" : "GitHub token missing — code search and org lookups will be skipped or fail",
        p.claude_cli ? "Claude CLI ✓" : "Claude CLI not found — model briefs and the web-search feed will be skipped",
        p.cost_ceiling_usd !== null ? "ceiling $" + p.cost_ceiling_usd.toFixed(2) + " per unit" : null,
      ].filter(Boolean);
      el.textContent = "This machine: " + bits.join(" · ");
      const cli = document.getElementById("opt-cli");
      if (cli && !p.claude_cli) cli.checked = false;
      }).catch(() => {});
    }
    fillPreflight();
    document.addEventListener("legwork:refreshed", fillPreflight);`
      : `    function renderCmd() {
      const cfg = formConfig();
      const parts = [];
      if (cfg.cli) parts.push("LEGWORK_LLM=cli");
      parts.push("legwork run", "--since " + cfg.sinceDays + "d");
      if (cfg.refresh) parts.push("--refresh");
      const cmd = parts.join(" ") + (cfg.skip.length ? "   # sources are chosen in the served console; the CLI runs them all" : "");
      const el = document.querySelector("#cmd-preview code");
      if (el) el.textContent = cmd;
    }
    document.addEventListener("input", (ev) => { if (ev.target && ev.target.closest && ev.target.closest("#search-form")) renderCmd(); });
    renderCmd();
    const copyCmd = document.getElementById("copy-cmd");
    if (copyCmd) copyCmd.addEventListener("click", () => {
      const el = document.querySelector("#cmd-preview code");
      if (el) navigator.clipboard.writeText(el.textContent);
    });
    const replay = document.getElementById("replay-sample");
    if (replay) replay.addEventListener("click", () => alert("This is the static copy. In a terminal: legwork demo"));`
  }
  })();`;
}
