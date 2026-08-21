// The review page: a generated, static HTML view of the review queue for humans who
// would rather judge briefs in a browser than a readline loop (that is most humans).
//
// It is a window, not a cockpit: buttons stage decisions in localStorage and assemble
// one CLI command you paste to record them. The terminal stays the actuator, the page
// just makes judgment comfortable — full brief, score math, and assumptions per card,
// because reading the assumptions is how the reviewer calibrates their own ICP sense.
//
// The pieces are exported so `legwork report` can compose the same cards into the
// fleet console.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts } from "./store.js";
import type { Account } from "./types.js";

const QUEUE_DIR = join("briefs", "queue");
const OUT_FILE = join("briefs", "review.html");

export function writeReviewPage(): string {
  const queued = loadAccounts().filter((a) => a.review?.status === "queued");
  const body = `<div class="top"><span class="brand">legwork</span><h1>Review queue</h1><span class="spacer"></span><button class="theme" id="theme">dark mode</button></div>
<p class="sub">${queued.length} brief(s) below the confidence gate · this page stages decisions; the command at the bottom records them.
Read the assumptions on every card — that is where you calibrate.</p>
${renderQueueCards(queued)}
${stageBar()}`;
  writeFileSync(OUT_FILE, shell("legwork review queue", body, stageScript()));
  return OUT_FILE;
}

export function renderQueueCards(queued: Account[], opts: { served?: boolean } = {}): string {
  if (queued.length === 0) return `<p class="empty">queue is empty — every published brief cleared the confidence gate.</p>`;
  return queued.map((a) => card(a, opts.served === true)).join("\n");
}

// Served cards post the decision straight to the local server, so they lose the "clear"
// button (nothing is staged to clear) and gain a slot for the server's error text.
function card(a: Account, served = false): string {
  const briefFile = join(QUEUE_DIR, `${a.org}.md`);
  const brief = existsSync(briefFile) ? readFileSync(briefFile, "utf8") : "(no brief file)";
  const q = a.qualification;
  const signals = (q?.signals ?? [])
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="num">${s.value.toFixed(2)} × ${s.weight.toFixed(2)}</td>` +
        `<td class="num">+${s.contribution.toFixed(2)}</td>` +
        `<td>${s.evidence_url ? `<a href="${esc(s.evidence_url)}" target="_blank"${receiptAttrs(s.name)}>receipt</a>` : "—"}</td></tr>`,
    )
    .join("");
  const assumptions = (q?.assumptions ?? []).map((x) => `<li>${esc(x)}</li>`).join("");
  return `
<section class="card" data-org="${esc(a.org)}">
  <header>
    <h2>${esc(a.company ?? a.org)}</h2>
    <span class="meta">segment ${esc(a.segment ?? "?")} · confidence ${(a.confidence ?? 0).toFixed(2)} · score ${q ? q.score.toFixed(2) : "?"} vs threshold ${q ? q.threshold.toFixed(2) : "?"}</span>
    <span class="verdict" data-state="undecided">undecided</span>
  </header>
  <div class="cols">
    <div class="col brief">${mdToHtml(brief)}</div>
    <div class="col why">
      <h3>Why this score</h3>
      <table><tr><th>signal</th><th>value × weight</th><th>adds</th><th>source</th></tr>${signals}</table>
      <h3>Assumptions — what the model admits it doesn't know</h3>
      <ul>${assumptions || "<li>none recorded</li>"}</ul>
      ${q?.fallback ? `<p class="fallback">Fallback: ${esc(q.fallback)}</p>` : ""}
    </div>
  </div>
  <footer>${
    served
      ? `
    <button data-act="approve">approve</button>
    <button data-act="reject">reject</button>
    <span class="cardnote"></span>`
      : `
    <button data-act="approve">approve</button>
    <button data-act="reject">reject</button>
    <button data-act="clear">clear</button>`
  }
  </footer>
</section>`;
}

export function stageBar(): string {
  return `<div id="bar">
  <p class="hint">Decisions staged here are not recorded until you run this in the repo: <button id="copy">copy</button></p>
  <div id="cmd">— no decisions staged yet —</div>
</div>`;
}

// The static page's script: localStorage staging plus the shared chrome (theme, tabs).
// Kept as one exported string so the generated static HTML is unchanged; served mode
// reuses chromeScript() alone, because staging a decision it can record is nonsense.
export function stageScript(): string {
  return stagingScript() + chromeScript();
}

function stagingScript(): string {
  return `
  const state = JSON.parse(localStorage.getItem("legwork-review") || "{}");
  function paint() {
    document.querySelectorAll(".card").forEach((c) => {
      const v = state[c.dataset.org];
      const el = c.querySelector(".verdict");
      if (!el) return;
      el.dataset.state = v || "undecided";
      el.textContent = v || "undecided";
    });
    const parts = Object.entries(state).map(([org, v]) =>
      "npx tsx src/cli.ts review --" + (v === "approve" ? "approve" : "reject") + " " + org);
    const cmd = document.getElementById("cmd");
    if (cmd) cmd.textContent = parts.length ? parts.join(" && \\\\\\n") : "— no decisions staged yet —";
  }
  document.querySelectorAll(".card footer button").forEach((b) => {
    b.addEventListener("click", () => {
      const org = b.closest(".card").dataset.org;
      if (b.dataset.act === "clear") delete state[org];
      else state[org] = b.dataset.act;
      localStorage.setItem("legwork-review", JSON.stringify(state));
      paint();
    });
  });
  const copy = document.getElementById("copy");
  if (copy) copy.addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("cmd").textContent);
  });
  paint();
`;
}

export function chromeScript(): string {
  return `  const themeBtn = document.getElementById("theme");
  if (themeBtn) {
    const label = () => themeBtn.textContent = document.documentElement.dataset.theme === "dark" ? "light mode" : "dark mode";
    themeBtn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next; localStorage.setItem("legwork-theme", next); label();
    });
    label();
  }
  // tabs: hash-linked so #queue etc. deep-link; no tabs present on single-section pages
  const tabs = document.querySelectorAll(".tabs button");
  if (tabs.length) {
    const show = (id) => {
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === id));
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
      history.replaceState(null, "", "#" + id);
    };
    tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
    const initial = location.hash.slice(1);
    show(document.getElementById(initial) && document.getElementById(initial).classList.contains("panel") ? initial : tabs[0].dataset.tab);
  }`;
}

// Served-mode chrome: the toolbar, status chip, log pane, and the in-place affordances
// on cards, fleet rows, and briefs. Same tokens as the static page — no new fonts, no new
// colors; the chip borrows the ok/warn/no trio the dots already use.
export function servedStyles(): string {
  return `  .opbanner { display:inline-block; background:var(--accent-soft); color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:4px 12px; font-size:12px; font-weight:500; margin-bottom:12px; }
  .toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:-14px 0 12px; }
  .chip { font-size:12px; padding:3px 11px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; }
  .toolbar .chip { margin-left:auto; }
  .chip[data-state="running"] { color:var(--warn); border-color:var(--warn); background:var(--warn-bg); }
  .chip[data-state="done"] { color:var(--ok); border-color:var(--ok); background:var(--ok-bg); }
  .chip[data-state="failed"] { color:var(--no); border-color:var(--no); background:var(--no-bg); }
  .logpane { background:var(--bg-2); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:12.5px/1.6 var(--mono); color:var(--text); max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin-bottom:24px; }
  .logpane[data-empty="1"] { color:var(--dim); }
  .card.settled { opacity:.45; }
  .cardnote, .note { color:var(--dim); font-size:12.5px; }
  .cardnote[data-state="err"], .note[data-state="err"] { color:var(--no); }
  .rowact { text-align:right; }
  .rowact button { padding:4px 12px; font-size:12.5px; }
  .briefact { display:flex; align-items:center; gap:10px; margin:10px 0 2px; }
`;
}

export function servedScript(): string {
  return chromeScript() + `
  // Every call below is served-mode only; the static Pages copy ships without this script
  // and makes no network requests. Failures are always surfaced on the status chip.
  const chip = document.getElementById("op-status");
  const logpane = document.getElementById("op-log");
  function setStatus(state, text) {
    if (!chip) return;
    chip.dataset.state = state;
    chip.textContent = text;
  }
  function writeLog(text) {
    if (!logpane) return;
    logpane.dataset.empty = text ? "0" : "1";
    logpane.textContent = text || "— no run yet —";
    logpane.scrollTop = logpane.scrollHeight;
  }
  function fail(err, note) {
    const msg = (err && err.message) ? err.message : String(err);
    setStatus("failed", "failed: " + msg);
    if (note) { note.dataset.state = "err"; note.textContent = msg; }
  }
  async function api(path, body) {
    const init = body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    let res;
    try { res = await fetch(path, init); }
    catch (e) { throw new Error("cannot reach " + path + " — is legwork serve still running?"); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || (path + " returned " + res.status));
    }
    return data;
  }
  async function refreshPanels() {
    const data = await api("/api/state");
    const html = data.html || {};
    Object.keys(html).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html[id];
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let polling = false;
  async function pollRun() {
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        const s = await api("/api/run/status");
        writeLog((s.lines || []).join("\\n"));
        if (!s.running) {
          if (s.error) setStatus("failed", "failed: " + s.error);
          else setStatus("done", "run finished");
          await refreshPanels();
          break;
        }
        await sleep(700);
      }
    } catch (e) { fail(e); }
    finally { polling = false; }
  }
  async function startRun(mode, sinceDays) {
    setStatus("running", mode === "live" ? "running · live" : "running · demo");
    writeLog("");
    try {
      await api("/api/run", sinceDays ? { mode, sinceDays } : { mode });
      await pollRun();
    } catch (e) { fail(e); }
  }
  async function runEvals() {
    setStatus("running", "running · evals");
    try {
      const d = await api("/api/evals", {});
      writeLog(d.output || "(no output)");
      if (d.regressions) setStatus("failed", "evals: regression against baseline");
      else setStatus("done", "evals: no regressions");
      await refreshPanels();
    } catch (e) { fail(e); }
  }
  async function decide(card, act) {
    const note = card.querySelector(".cardnote");
    if (note) { note.dataset.state = ""; note.textContent = "recording…"; }
    try {
      await api("/api/review", { org: card.dataset.org, decision: act });
      const verdict = card.querySelector(".verdict");
      if (verdict) { verdict.dataset.state = act; verdict.textContent = act; }
      card.classList.add("settled");
      card.querySelectorAll("footer button").forEach((b) => { b.disabled = true; });
      if (note) { note.dataset.state = ""; note.textContent = "recorded to data/reviews.jsonl"; }
      const count = document.querySelector('.tabs button[data-tab="queue"] .count');
      if (count) count.textContent = String(Math.max(0, Number(count.textContent) - 1));
      setStatus("done", act === "approve" ? "approved " + card.dataset.org : "rejected " + card.dataset.org);
    } catch (e) { fail(e, note); }
  }
  async function retire(btn) {
    const agent = btn.dataset.retire;
    const out = document.getElementById("retire-out");
    setStatus("running", "retiring · " + agent);
    try {
      const d = await api("/api/retire", { agent });
      if (out) {
        const box = document.createElement("details");
        box.open = true;
        const sum = document.createElement("summary");
        sum.textContent = "retirement memo — " + agent;
        const pre = document.createElement("pre");
        pre.className = "logpane";
        pre.textContent = d.memo || "(empty memo)";
        box.appendChild(sum); box.appendChild(pre); out.appendChild(box);
      }
      setStatus("done", "memo written for " + agent);
    } catch (e) { fail(e); }
  }
  async function notify(btn) {
    const note = btn.parentElement ? btn.parentElement.querySelector(".note") : null;
    if (note) { note.dataset.state = ""; note.textContent = "sending…"; }
    try {
      const d = await api("/api/notify", { org: btn.dataset.notify });
      if (note) { note.dataset.state = ""; note.textContent = d.result === "posted" ? "posted to Slack" : "printed to console (no webhook set)"; }
      setStatus("done", "notified " + btn.dataset.notify);
    } catch (e) { fail(e, note); }
  }
  // Delegated: panels are replaced wholesale on refresh, so nothing is bound to a node.
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const runBtn = t.closest("[data-run]");
    if (runBtn) { startRun(runBtn.dataset.run, runBtn.dataset.since ? Number(runBtn.dataset.since) : undefined); return; }
    if (t.closest("#op-evals")) { runEvals(); return; }
    if (t.closest("#op-refresh")) {
      setStatus("running", "refreshing");
      refreshPanels().then(() => setStatus("idle", "idle")).catch((e) => fail(e));
      return;
    }
    const retireBtn = t.closest("[data-retire]");
    if (retireBtn) { retire(retireBtn); return; }
    const notifyBtn = t.closest("[data-notify]");
    if (notifyBtn) { notify(notifyBtn); return; }
    const act = t.closest(".card footer button[data-act]");
    if (act) {
      const card = act.closest(".card");
      if (card) decide(card, act.dataset.act);
    }
  });
  writeLog("");
  // A run may already be going (page opened mid-run, or reloaded): pick it back up.
  api("/api/run/status").then((s) => { if (s.running) { setStatus("running", "running"); pollRun(); } }).catch((e) => fail(e));`;
}

// Just enough markdown for our own briefs and memos: headings, bullets, links, bold, code, quotes.
export function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (line.startsWith("# ")) out.push(`<h2>${inline(line.slice(2))}</h2>`);
    else if (line.startsWith("## ")) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (line.startsWith("> ")) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function inline(s: string): string {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, `<a href="$2" target="_blank"${receiptAttrs()}>$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- receipt drawer -------------------------------------------------------------------
//
// Receipts are meant to be checked in passing, not navigated to. Every evidence link the
// console renders opens a right-hand drawer with the source previewed in place; the page
// stays behind a dimmed scrim and Esc / scrim / Close puts you back exactly where you were.
// Interaction lifted from the sidebar-note system on ravenhoward.org, wearing legwork's
// palette. One implementation covers review cards, briefs, memos, and the score-math table
// because all four render their links through this file.
//
// Link convention, applied everywhere: dashed underline = opens here, solid = leaves.

/** Attributes that turn an anchor into a drawer receipt. `claim` seeds the title when the
 *  evidence index has nothing for the URL (the score-math table's terse "receipt" links). */
function receiptAttrs(claim?: string): string {
  return ` class="receipt" data-receipt${claim ? ` data-claim="${esc(claim)}"` : ""}`;
}

// The drawer's meta row comes from the Evidence records themselves — unit, date, account —
// keyed by URL so a link anywhere on the page can find its provenance. Fields are the
// Evidence fields and nothing else; keys are one letter only to keep the page small.
interface ReceiptRecord { c: string; u: string; d: string; a: string }

function receiptIndex(): string {
  const index: Record<string, ReceiptRecord> = {};
  let accounts: Account[] = [];
  try {
    accounts = loadAccounts();
  } catch {
    accounts = []; // no state file yet: the drawer still opens, just without provenance
  }
  for (const account of accounts) {
    const name = account.company ?? account.org;
    for (const e of account.evidence ?? []) {
      if (!e?.url || index[e.url]) continue; // first sighting wins: stable across renders
      index[e.url] = { c: e.claim ?? "", u: e.agent ?? "", d: (e.date ?? "").slice(0, 10), a: name };
    }
  }
  // `<` is escaped so no evidence claim can close this script tag early.
  const json = JSON.stringify(index).replace(/</g, "\\u003c");
  return `<script type="application/json" id="rd-index">${json}</script>`;
}

function drawerMarkup(): string {
  return `<div class="rd-scrim" id="rd-scrim"></div>
<aside class="rd" id="rd" role="dialog" aria-modal="true" aria-labelledby="rd-title" aria-hidden="true" tabindex="-1">
  <div class="rd-notch"></div>
  <div class="rd-head">
    <div class="rd-headrow"><span class="rd-kind" id="rd-kind">receipt</span><button class="rd-close" id="rd-close">Close <span aria-hidden="true">✕</span></button></div>
    <h2 class="rd-title" id="rd-title">Receipt</h2>
    <p class="rd-meta" id="rd-meta"></p>
  </div>
  <div class="rd-body">
    <div id="rd-preview"></div>
    <div class="rd-url" id="rd-url"></div>
    <a class="rd-open" id="rd-open" href="#" target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>
  </div>
</aside>
${receiptIndex()}`;
}

function drawerStyles(): string {
  return `  /* receipt drawer — dashed underline means it opens here and you stay on the page */
  a.receipt { text-decoration:underline; text-decoration-style:dashed; text-decoration-thickness:1px; text-underline-offset:3px; text-decoration-color:color-mix(in srgb, var(--accent) 50%, transparent); cursor:pointer; }
  a.receipt:hover { text-decoration:underline dashed; text-decoration-color:var(--accent); }
  .rd-scrim { position:fixed; inset:0; z-index:60; background:color-mix(in srgb, var(--text) 26%, transparent); opacity:0; visibility:hidden; transition:opacity .45s cubic-bezier(.4,0,.2,1), visibility .45s; }
  [data-theme="dark"] .rd-scrim { background:rgba(0,0,0,.55); }
  .rd-scrim.on { opacity:1; visibility:visible; }
  .rd { position:fixed; top:0; right:0; z-index:61; height:100%; width:min(470px,94vw); display:flex; flex-direction:column; background:var(--bg); border-left:1px solid var(--line); box-shadow:none; transform:translateX(103%); visibility:hidden; transition:transform .5s cubic-bezier(.4,0,.2,1), visibility .5s, box-shadow .5s cubic-bezier(.4,0,.2,1); }
  /* The shadow belongs to .on and only .on. On a closed drawer it bleeds a pale band down
     the right edge of every page — found and fixed once already; do not hoist it to .rd. */
  .rd.on { transform:translateX(0); visibility:visible; box-shadow:-22px 0 48px rgba(0,0,0,.14); }
  [data-theme="dark"] .rd.on { box-shadow:-22px 0 48px rgba(0,0,0,.5); }
  .rd-notch { display:none; width:40px; height:4px; border-radius:999px; background:var(--line-strong); margin:10px auto 0; flex:none; }
  .rd-head { padding:20px 24px 15px; border-bottom:1px solid var(--line); flex:none; }
  .rd-headrow { display:flex; align-items:center; gap:10px; margin-bottom:11px; }
  .rd-kind { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim); background:var(--bg-2); border:1px solid var(--line); border-radius:999px; padding:3px 10px; white-space:nowrap; }
  .rd-close { margin-left:auto; padding:4px 12px; font-size:12.5px; color:var(--dim); }
  .rd-title { font-size:15.5px; font-weight:600; line-height:1.5; letter-spacing:-0.01em; }
  .rd-meta { color:var(--faint); font-family:var(--mono); font-size:11.5px; margin-top:9px; word-break:break-word; }
  .rd-body { padding:18px 24px 34px; overflow:auto; flex:1; line-height:1.7; max-width:60ch; }
  .rd-lead { font-size:13.5px; margin-bottom:12px; }
  .rd-note { color:var(--dim); font-size:12.5px; margin-bottom:6px; }
  .rd-note[data-state="err"] { color:var(--no); }
  .rd-pre { background:var(--bg-2); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:12px/1.65 var(--mono); color:var(--text); white-space:pre-wrap; word-break:break-word; max-height:46vh; overflow:auto; margin-bottom:12px; }
  .rd-facts { width:100%; font-size:13px; margin-bottom:12px; }
  .rd-facts td { padding:5px 10px 5px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .rd-facts td:first-child { color:var(--faint); white-space:nowrap; width:1%; }
  .rd-url { font:11.5px/1.6 var(--mono); color:var(--dim); word-break:break-all; background:var(--bg-2); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:16px 0 12px; }
  .rd-open { display:inline-block; font-size:13px; font-weight:500; }
  @media (max-width: 700px) {
    .rd { width:100%; border-left:none; }
    .rd-notch { display:block; }
    .rd-body { max-width:none; }
  }
`;
}

// The drawer's client. Deliberately self-contained and framework-free, and — this is the
// invariant the static Pages copy depends on — it issues no request until a receipt is
// actually clicked. Nothing here runs on load beyond wiring three listeners.
export function drawerScript(): string {
  return `(function () {
  var drawer = document.getElementById("rd");
  var scrim = document.getElementById("rd-scrim");
  if (!drawer || !scrim) return;
  var elKind = document.getElementById("rd-kind");
  var elTitle = document.getElementById("rd-title");
  var elMeta = document.getElementById("rd-meta");
  var elPrev = document.getElementById("rd-preview");
  var elUrl = document.getElementById("rd-url");
  var elOpen = document.getElementById("rd-open");
  var INDEX = {};
  var idxNode = document.getElementById("rd-index");
  if (idxNode) { try { INDEX = JSON.parse(idxNode.textContent) || {}; } catch (e) { INDEX = {}; } }

  var MAX_LINES = 200, MAX_BYTES = 20480;
  var STATIC_NOTE = "preview unavailable in the static console — run legwork serve for inline previews";
  // Only a page served from localhost has /api/receipt behind it. The Pages copy never
  // probes for it, so a static console makes no failed request either.
  var served = (location.protocol === "http:" || location.protocol === "https:") &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "[::1]");
  var cache = {};
  var opener = null;
  var token = 0;

  function parse(url) { try { return new URL(url, location.href); } catch (e) { return null; } }
  function segments(u) { return u.pathname.split("/").filter(function (s) { return s !== ""; }); }

  function kindOf(url) {
    var u = parse(url);
    if (!u) return "link";
    var h = u.hostname.toLowerCase().replace(/^www\\./, "");
    var seg = segments(u);
    if (h === "raw.githubusercontent.com") return "github file";
    if (h === "api.github.com") return "github";
    if (h === "github.com") {
      if (seg.length >= 3 && (seg[2] === "blob" || seg[2] === "raw")) return "github file";
      if (seg.length >= 3 && (seg[2] === "issues" || seg[2] === "pull")) return "issue";
      if (seg.length >= 2) return "github repo";
      if (seg.length === 1) return "github profile";
      return "github";
    }
    if (h === "apps.apple.com" || h === "play.google.com") return "app store";
    if (h === "news.ycombinator.com") return "hn";
    return "homepage";
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // A failed preview is a quiet line, never a red alarm: the receipt itself is still
  // right there, and the metadata view above it is a perfectly good answer.
  function note(text) {
    var p = document.createElement("p");
    p.className = "rd-note";
    p.textContent = text;
    return p;
  }

  function factsTable(meta) {
    var t = document.createElement("table");
    t.className = "rd-facts";
    Object.keys(meta).forEach(function (k) {
      var v = meta[k];
      if (v === null || v === undefined || v === "") return;
      var tr = t.insertRow();
      tr.insertCell().textContent = k;
      tr.insertCell().textContent = String(v);
    });
    return t.rows.length ? t : null;
  }

  function paint(p) {
    clear(elPrev);
    if (!p) { elPrev.appendChild(note("loading preview…")); return; }
    if (p.kind) elKind.textContent = p.kind;
    if (p.title) {
      var lead = document.createElement("p");
      lead.className = "rd-lead";
      lead.textContent = p.title;
      elPrev.appendChild(lead);
    }
    if (p.meta) { var f = factsTable(p.meta); if (f) elPrev.appendChild(f); }
    if (p.text) {
      var pre = document.createElement("pre");
      pre.className = "rd-pre";
      pre.textContent = p.text;
      elPrev.appendChild(pre);
    }
    if (p.note) elPrev.appendChild(note(p.note));
  }

  function truncate(text, kind) {
    var truncated = false;
    if (text.length > MAX_BYTES) { text = text.slice(0, MAX_BYTES); truncated = true; }
    var lines = text.split("\\n");
    if (lines.length > MAX_LINES) { lines = lines.slice(0, MAX_LINES); truncated = true; }
    return {
      ok: true, kind: kind, text: lines.join("\\n"),
      note: truncated ? "showing the first " + MAX_LINES + " lines / 20KB — open in a new tab for the whole file" : ""
    };
  }

  async function fromServer(url) {
    var res = await fetch("/api/receipt?url=" + encodeURIComponent(url), { headers: { accept: "application/json" } });
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("application/json") === -1) throw new Error("no-api");
    return await res.json();
  }

  // Static mode: raw.githubusercontent.com and api.github.com both send
  // Access-Control-Allow-Origin: *, so a Pages copy can still preview GitHub. Everything
  // else degrades to metadata only — honestly, and without a console error.
  async function fromStatic(url, kind) {
    var u = parse(url);
    if (!u) throw new Error("static");
    var h = u.hostname.toLowerCase().replace(/^www\\./, "");
    var seg = segments(u);

    if (h === "raw.githubusercontent.com" || (h === "github.com" && kind === "github file")) {
      var raw = h === "raw.githubusercontent.com"
        ? u.href
        : "https://raw.githubusercontent.com/" + seg[0] + "/" + seg[1] + "/" + seg.slice(3).join("/");
      var r = await fetch(raw);
      if (!r.ok) throw new Error("raw.githubusercontent.com returned " + r.status);
      return truncate(await r.text(), "github file");
    }
    if (h === "github.com" && kind === "github repo" && seg.length >= 2) {
      var repo = await ghApi("https://api.github.com/repos/" + seg[0] + "/" + seg[1]);
      return {
        ok: true, kind: "github repo", title: repo.full_name,
        meta: { description: repo.description, language: repo.language, "pushed at": (repo.pushed_at || "").slice(0, 10), stars: repo.stargazers_count }
      };
    }
    if (h === "github.com" && kind === "github profile" && seg.length === 1) {
      var user = await ghApi("https://api.github.com/users/" + seg[0]);
      return {
        ok: true, kind: "github profile", title: user.name || user.login,
        meta: { login: user.login, type: user.type, company: user.company, location: user.location, bio: user.bio, "public repos": user.public_repos }
      };
    }
    throw new Error("static");
  }

  async function ghApi(endpoint) {
    var r = await fetch(endpoint, { headers: { accept: "application/vnd.github+json" } });
    if (r.status === 403 || r.status === 429) {
      throw new Error("GitHub's unauthenticated API limit (60/hr) is spent — run legwork serve for inline previews");
    }
    if (!r.ok) throw new Error("api.github.com returned " + r.status);
    return await r.json();
  }

  async function resolve(url, kind) {
    if (served) {
      try {
        var d = await fromServer(url);
        if (d && d.ok) return d;
        // A refusal (host off the allowlist, fetch failed) is an answer, not a fault:
        // the drawer keeps the metadata view and says why there is no preview.
        return { ok: false, kind: kind, note: (d && d.error) ? d.error : "no preview available for this source" };
      } catch (e) { /* no server behind this page after all — fall through to static */ }
    }
    try { return await fromStatic(url, kind); }
    catch (e) {
      var msg = e && e.message ? e.message : String(e);
      return { ok: false, kind: kind, note: msg === "static" ? STATIC_NOTE : msg };
    }
  }

  function show() {
    drawer.classList.add("on");
    scrim.classList.add("on");
    drawer.setAttribute("aria-hidden", "false");
    drawer.focus();
  }

  function close() {
    if (!drawer.classList.contains("on")) return;
    token++; // any in-flight preview belongs to a drawer that is no longer open
    drawer.classList.remove("on");
    scrim.classList.remove("on");
    drawer.setAttribute("aria-hidden", "true");
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }

  function openFor(a) {
    var url = a.getAttribute("href");
    if (!url) return;
    var rec = INDEX[url] || {};
    var kind = kindOf(url);
    opener = a;
    elKind.textContent = kind;
    elTitle.textContent = rec.c || a.getAttribute("data-claim") || (a.textContent || "").trim() || url;
    elMeta.textContent = [rec.u, rec.d, rec.a].filter(Boolean).join("  ·  ");
    elUrl.textContent = url;
    elOpen.setAttribute("href", url);
    show();
    var mine = ++token;
    if (cache[url]) { paint(cache[url]); return; }
    paint(null);
    resolve(url, kind).then(function (p) {
      cache[url] = p;
      if (mine === token) paint(p);
    });
  }

  // Delegated: served mode replaces whole panels on refresh, so nothing may be bound to a node.
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("#rd-close")) { ev.preventDefault(); close(); return; }
    if (t.closest("#rd-scrim")) { close(); return; }
    var a = t.closest("a[data-receipt]");
    if (!a) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // cmd-click still opens a tab
    ev.preventDefault();
    openFor(a);
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
})();`;
}

// One visual system for every generated page, modeled on expo.dev: Inter for text,
// mono only where numbers and code live, Expo's light and dark palettes with a switch.
// Deliberately violates nothing on the AI-slop checklist — no gradients, no glow, no
// sparkle; restraint is the signature.
export function shell(title: string, body: string, script = "", extraCss = ""): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#ffffff; --bg-2:#f7f8fb; --card:#ffffff; --line:#e1e4ea; --line-strong:#d8dee8;
    --text:#111827; --dim:#5b6472; --faint:#8a93a0; --accent:#0081f1; --accent-soft:#e6f2fd;
    --ok:#1f9d55; --no:#d83a3a; --warn:#b8860b; --ok-bg:#e8f6ee; --no-bg:#fdecec; --warn-bg:#fbf3dc;
    --sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  }
  [data-theme="dark"] {
    --bg:#151718; --bg-2:#1c1e1f; --card:#1c1e1f; --line:#2b2f33; --line-strong:#34383b;
    --text:#ecedee; --dim:#9ba1a6; --faint:#6f767c; --accent:#2788f3; --accent-soft:#152a44;
    --ok:#4cc38a; --no:#f15139; --warn:#e0b84e; --ok-bg:#14301f; --no-bg:#3a1a17; --warn-bg:#3a3014;
  }
  * { box-sizing:border-box; margin:0; }
  html { background:var(--bg); }
  body { background:var(--bg); color:var(--text); font:15px/1.6 var(--sans); padding:32px 28px 64px; max-width:1180px; margin:0 auto; -webkit-font-smoothing:antialiased; }
  .top { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
  .top h1 { font-size:22px; font-weight:700; letter-spacing:-0.02em; }
  .top .brand { font-family:var(--mono); font-size:12px; color:var(--dim); }
  .top .spacer { flex:1; }
  .theme { background:var(--card); border:1px solid var(--line); color:var(--dim); border-radius:999px; padding:6px 12px; font:inherit; font-size:12.5px; cursor:pointer; }
  .theme:hover { border-color:var(--line-strong); color:var(--text); }
  .sub { color:var(--dim); margin-bottom:18px; font-size:14px; }
  /* tabs: one thing on screen at a time */
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin:14px 0 26px; border-bottom:1px solid var(--line); padding-bottom:12px; }
  .tabs button { background:transparent; border:1px solid transparent; color:var(--dim); padding:7px 14px; border-radius:999px; font:inherit; font-size:13.5px; font-weight:500; cursor:pointer; }
  .tabs button:hover { color:var(--text); background:var(--bg-2); }
  .tabs button.active { color:var(--accent); background:var(--accent-soft); }
  .tabs .count { font-family:var(--mono); color:var(--faint); margin-left:6px; font-size:11px; }
  .panel { display:none; } .panel.active { display:block; }
  .panel > .lead { color:var(--dim); font-size:14.5px; margin-bottom:20px; max-width:760px; }
  section.block { margin-bottom:34px; }
  section.block > h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--faint); margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid var(--line); font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:22px 24px; margin-bottom:18px; }
  .card header { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:16px; flex-wrap:wrap; }
  .card h2 { font-size:17px; font-weight:600; }
  .meta { color:var(--dim); font-size:13px; }
  .verdict { margin-left:auto; font-size:12px; padding:3px 11px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; }
  .verdict[data-state="approve"] { color:var(--ok); border-color:var(--ok); background:var(--ok-bg); }
  .verdict[data-state="reject"] { color:var(--no); border-color:var(--no); background:var(--no-bg); }
  .cols { display:grid; grid-template-columns: 6fr minmax(280px, 4fr); gap:32px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .why { border-left:1px solid var(--line); padding-left:22px; }
  h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); margin:16px 0 8px; font-weight:600; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; }
  td,th { text-align:left; padding:7px 12px 7px 0; border-bottom:1px solid var(--line); color:var(--text); vertical-align:top; }
  th { color:var(--faint); font-weight:500; font-size:12px; }
  .num { font-family:var(--mono); font-size:12.5px; white-space:nowrap; text-align:right; }
  .dimcell { color:var(--dim); }
  ul { padding-left:18px; font-size:13.5px; }
  li { margin:4px 0; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .fallback { color:var(--dim); font-size:13px; margin-top:10px; }
  .brief { font-size:14px; }
  .brief h2, .memo h2 { font-size:16px; margin:8px 0; font-weight:600; }
  .brief h3, .memo h3 { text-transform:none; letter-spacing:0; color:var(--text); font-size:14px; margin-top:14px; font-weight:600; }
  blockquote { color:var(--dim); border-left:2px solid var(--line-strong); padding-left:12px; margin:8px 0; }
  code { font-family:var(--mono); font-size:12.5px; background:var(--bg-2); border:1px solid var(--line); padding:1px 5px; border-radius:5px; }
  .card footer { margin-top:16px; display:flex; gap:8px; }
  button { background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 16px; font:inherit; font-size:13.5px; font-weight:500; cursor:pointer; }
  button:hover { border-color:var(--line-strong); background:var(--bg-2); }
  button[data-act="approve"]:hover { color:var(--ok); border-color:var(--ok); }
  button[data-act="reject"]:hover { color:var(--no); border-color:var(--no); }
  #bar { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:14px 0 4px; margin-top:24px; }
  #cmd { width:100%; background:var(--bg-2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:12.5px/1.6 var(--mono); min-height:44px; white-space:pre-wrap; word-break:break-all; }
  #bar .hint, .empty { color:var(--dim); font-size:13px; margin:6px 0; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; margin-right:8px; vertical-align:middle; }
  .dot.ok { background:var(--ok); } .dot.err { background:var(--no); } .dot.warn { background:var(--warn); } .dot.none { background:var(--line-strong); }
  .kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:18px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .kpi .v { font-size:24px; font-weight:600; letter-spacing:-0.01em; } .kpi .k { color:var(--faint); font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
  details { margin:8px 0; } summary { cursor:pointer; color:var(--dim); font-size:14px; padding:6px 0; }
  .memo { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; font-size:14px; margin-top:8px; }
  footer.page { color:var(--faint); font-size:12.5px; margin-top:44px; border-top:1px solid var(--line); padding-top:14px; }
${drawerStyles()}${extraCss}</style>
<script>
  (function(){ var t = localStorage.getItem("legwork-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.dataset.theme = t; })();
</script>
${body}
${drawerMarkup()}
<script>${script}</script>
<script>${drawerScript()}</script>
`;
}
