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
  const themeBtn = document.getElementById("theme");
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

// One visual system for every generated page, modeled on expo.dev: Inter for text,
// mono only where numbers and code live, Expo's light and dark palettes with a switch.
// Deliberately violates nothing on the AI-slop checklist — no gradients, no glow, no
// sparkle; restraint is the signature.
export function shell(title: string, body: string, script = ""): string {
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
</style>
<script>
  (function(){ var t = localStorage.getItem("legwork-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.dataset.theme = t; })();
</script>
${body}
<script>${script}</script>
`;
}
