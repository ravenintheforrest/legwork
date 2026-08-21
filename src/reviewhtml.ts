// The review page: a generated, static HTML view of the review queue for humans who
// would rather judge briefs in a browser than a readline loop (that is most humans).
//
// It is a window, not a cockpit: buttons stage decisions in localStorage and assemble
// one CLI command you paste to record them. The terminal stays the actuator, the page
// just makes judgment comfortable — full brief, score math, and assumptions per card,
// because reading the assumptions is how the reviewer calibrates their own ICP sense.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts } from "./store.js";
import type { Account } from "./types.js";

const QUEUE_DIR = join("briefs", "queue");
const OUT_FILE = join("briefs", "review.html");

export function writeReviewPage(): string {
  const queued = loadAccounts().filter((a) => a.review?.status === "queued");
  const cards = queued.map((a) => card(a)).join("\n");
  writeFileSync(OUT_FILE, page(cards, queued.length));
  return OUT_FILE;
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
    <div class="col">
      <h3>Score math</h3>
      <table><tr><th>signal</th><th>value × weight</th><th>adds</th><th>source</th></tr>${signals}</table>
      <h3>Assumptions — read these; they are where the model admits what it doesn't know</h3>
      <ul>${assumptions || "<li>none recorded</li>"}</ul>
      ${q?.fallback ? `<p class="fallback">Fallback: ${esc(q.fallback)}</p>` : ""}
    </div>
    <div class="col brief">${mdToHtml(brief)}</div>
  </div>
  <footer>
    <button data-act="approve">approve</button>
    <button data-act="reject">reject</button>
    <button data-act="clear">clear</button>
  </footer>
</section>`;
}

// Just enough markdown for our own briefs: headings, bullets, links, bold, blockquote.
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const asHtml = inline(line);
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
    else out.push(`<p>${asHtml}</p>`);
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(cards: string, count: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>legwork review queue</title>
<style>
  :root { --bg:#111; --card:#181818; --line:#2c2c2c; --text:#e6e6e6; --dim:#9a9a9a; --ok:#7fd7a4; --no:#e08a7a; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.55 "JetBrains Mono", ui-monospace, Menlo, monospace; padding:24px; }
  h1 { font-size:18px; margin-bottom:4px; }
  .sub { color:var(--dim); margin-bottom:20px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:18px; margin-bottom:18px; }
  .card header { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:12px; }
  .card h2 { font-size:16px; }
  .meta { color:var(--dim); font-size:12.5px; }
  .verdict { margin-left:auto; font-size:12px; padding:2px 10px; border:1px solid var(--line); border-radius:99px; color:var(--dim); }
  .verdict[data-state="approve"] { color:var(--ok); border-color:var(--ok); }
  .verdict[data-state="reject"] { color:var(--no); border-color:var(--no); }
  .cols { display:grid; grid-template-columns: minmax(280px, 4fr) 6fr; gap:20px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  td,th { text-align:left; padding:3px 8px 3px 0; border-bottom:1px solid var(--line); color:var(--text); }
  th { color:var(--dim); font-weight:normal; }
  .num { white-space:nowrap; }
  ul { padding-left:18px; font-size:13px; }
  li { margin:3px 0; }
  a { color:#8ab4d8; }
  .fallback { color:var(--dim); font-size:12.5px; margin-top:8px; }
  .brief { border-left:1px solid var(--line); padding-left:20px; font-size:13.5px; }
  .brief h2 { font-size:15px; margin:6px 0; }
  .brief h3 { text-transform:none; letter-spacing:0; color:var(--text); font-size:13px; margin-top:12px; }
  .brief blockquote { color:var(--dim); border-left:2px solid var(--line); padding-left:10px; margin:6px 0; }
  code { background:#222; padding:1px 4px; border-radius:3px; }
  .card footer { margin-top:14px; display:flex; gap:8px; }
  button { background:#222; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 16px; font:inherit; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--dim); }
  #bar { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:14px 0 4px; margin-top:24px; }
  #cmd { width:100%; background:#181818; color:var(--ok); border:1px solid var(--line); border-radius:6px; padding:10px; font:inherit; font-size:12.5px; min-height:44px; white-space:pre-wrap; word-break:break-all; }
  #bar .hint { color:var(--dim); font-size:12px; margin:6px 0; }
</style>
<h1>legwork review queue</h1>
<p class="sub">${count} brief(s) below the confidence gate · this page stages decisions; the command at the bottom records them.
Read the assumptions on every card — that is where you calibrate.</p>
${cards}
<div id="bar">
  <p class="hint">Decisions staged here are not recorded until you run this in the repo: <button id="copy">copy</button></p>
  <div id="cmd">— no decisions staged yet —</div>
</div>
<script>
  const state = JSON.parse(localStorage.getItem("legwork-review") || "{}");
  function paint() {
    document.querySelectorAll(".card").forEach((c) => {
      const v = state[c.dataset.org];
      c.querySelector(".verdict").dataset.state = v || "undecided";
      c.querySelector(".verdict").textContent = v || "undecided";
    });
    const parts = Object.entries(state).map(([org, v]) =>
      "npx tsx src/cli.ts review --" + (v === "approve" ? "approve" : "reject") + " " + org);
    document.getElementById("cmd").textContent = parts.length ? parts.join(" && \\\\\\n") : "— no decisions staged yet —";
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
  document.getElementById("copy").addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("cmd").textContent);
  });
  paint();
</script>
`;
}
