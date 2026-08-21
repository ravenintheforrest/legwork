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
  const body = `<h1>legwork review queue</h1>
<p class="sub">${queued.length} brief(s) below the confidence gate · this page stages decisions; the command at the bottom records them.
Read the assumptions on every card — that is where you calibrate.</p>
${renderQueueCards(queued)}
${stageBar()}`;
  writeFileSync(OUT_FILE, shell("legwork review queue", body, stageScript()));
  return OUT_FILE;
}

export function renderQueueCards(queued: Account[]): string {
  if (queued.length === 0) return `<p class="empty">queue is empty — every published brief cleared the confidence gate.</p>`;
  return queued.map((a) => card(a)).join("\n");
}

function card(a: Account): string {
  const briefFile = join(QUEUE_DIR, `${a.org}.md`);
  const brief = existsSync(briefFile) ? readFileSync(briefFile, "utf8") : "(no brief file)";
  const q = a.qualification;
  const signals = (q?.signals ?? [])
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="num">${s.value.toFixed(2)} × ${s.weight.toFixed(2)}</td>` +
        `<td class="num">+${s.contribution.toFixed(2)}</td>` +
        `<td>${s.evidence_url ? `<a href="${esc(s.evidence_url)}" target="_blank">receipt</a>` : "—"}</td></tr>`,
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
  <footer>
    <button data-act="approve">approve</button>
    <button data-act="reject">reject</button>
    <button data-act="clear">clear</button>
  </footer>
</section>`;
}

export function stageBar(): string {
  return `<div id="bar">
  <p class="hint">Decisions staged here are not recorded until you run this in the repo: <button id="copy">copy</button></p>
  <div id="cmd">— no decisions staged yet —</div>
</div>`;
}

export function stageScript(): string {
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
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// One visual system for every generated page: monochrome, monospace, no decoration.
// Deliberately violates nothing on the AI-slop checklist. The restraint is the signature.
export function shell(title: string, body: string, script = ""): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#111; --card:#181818; --line:#2c2c2c; --text:#e6e6e6; --dim:#9a9a9a; --ok:#7fd7a4; --no:#e08a7a; --warn:#e0c27a; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.55 "JetBrains Mono", ui-monospace, Menlo, monospace; padding:24px; max-width:1280px; margin:0 auto; }
  h1 { font-size:18px; margin-bottom:4px; }
  .sub { color:var(--dim); margin-bottom:20px; font-size:13px; }
  /* tabs: one thing on screen at a time */
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin:18px 0 24px; border-bottom:1px solid var(--line); padding-bottom:10px; }
  .tabs button { background:transparent; border:1px solid transparent; color:var(--dim); padding:7px 14px; border-radius:6px; font:inherit; font-size:13px; cursor:pointer; }
  .tabs button:hover { color:var(--text); border-color:var(--line); }
  .tabs button.active { color:var(--text); background:var(--card); border-color:var(--line); }
  .tabs .count { color:var(--dim); margin-left:6px; font-size:11px; }
  .panel { display:none; } .panel.active { display:block; }
  .panel > .lead { color:var(--dim); font-size:13px; margin-bottom:18px; max-width:760px; }
  section.block { margin-bottom:34px; }
  section.block > h2 { font-size:13px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim); margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:18px; margin-bottom:18px; }
  .card header { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:12px; flex-wrap:wrap; }
  .card h2 { font-size:16px; }
  .meta { color:var(--dim); font-size:12.5px; }
  .verdict { margin-left:auto; font-size:12px; padding:2px 10px; border:1px solid var(--line); border-radius:99px; color:var(--dim); }
  .verdict[data-state="approve"] { color:var(--ok); border-color:var(--ok); }
  .verdict[data-state="reject"] { color:var(--no); border-color:var(--no); }
  .cols { display:grid; grid-template-columns: 6fr minmax(280px, 4fr); gap:28px; }
  .why { border-left:1px solid var(--line); padding-left:20px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  td,th { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid var(--line); color:var(--text); vertical-align:top; }
  th { color:var(--dim); font-weight:normal; }
  .num { white-space:nowrap; text-align:right; }
  ul { padding-left:18px; font-size:13px; }
  li { margin:3px 0; }
  a { color:#8ab4d8; }
  .fallback { color:var(--dim); font-size:12.5px; margin-top:8px; }
  .brief { font-size:13.5px; }
  .brief h2, .memo h2 { font-size:15px; margin:6px 0; }
  .brief h3, .memo h3 { text-transform:none; letter-spacing:0; color:var(--text); font-size:13px; margin-top:12px; }
  blockquote { color:var(--dim); border-left:2px solid var(--line); padding-left:10px; margin:6px 0; }
  code { background:#222; padding:1px 4px; border-radius:3px; }
  .card footer { margin-top:14px; display:flex; gap:8px; }
  button { background:#222; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 16px; font:inherit; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--dim); }
  #bar { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:14px 0 4px; margin-top:24px; }
  #cmd { width:100%; background:#181818; color:var(--ok); border:1px solid var(--line); border-radius:6px; padding:10px; font:inherit; font-size:12.5px; min-height:44px; white-space:pre-wrap; word-break:break-all; }
  #bar .hint, .empty { color:var(--dim); font-size:12px; margin:6px 0; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; margin-right:6px; vertical-align:middle; }
  .dot.ok { background:var(--ok); } .dot.err { background:var(--no); } .dot.warn { background:var(--warn); } .dot.none { background:var(--line); }
  .kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:14px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .kpi .v { font-size:20px; } .kpi .k { color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; }
  details { margin:8px 0; } summary { cursor:pointer; color:var(--dim); font-size:13px; }
  .memo { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px 18px; font-size:13.5px; }
  footer.page { color:var(--dim); font-size:12px; margin-top:40px; border-top:1px solid var(--line); padding-top:12px; }
</style>
${body}
<script>${script}</script>
`;
}
