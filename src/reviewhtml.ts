// The review page: a generated, static HTML view of the review queue for humans who
// would rather judge briefs in a browser than a readline loop (that is most humans).
//
// It is a window, not a cockpit: buttons stage decisions in localStorage and assemble
// one CLI command you paste to record them. The terminal stays the actuator, the page
// just makes judgment comfortable. Each card is the account as a person reads it (see
// briefview.ts): who they are, what we found, who to talk to, the opener, and a verdict
// in words — with the score math and the full brief one click away, not in the headline.
//
// The pieces are exported so `legwork report` can compose the same cards into the
// fleet console.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBriefView, type Cited } from "./briefview.js";
import { loadRegistry } from "./registry.js";
import { loadAccounts } from "./store.js";
import type { Account } from "./types.js";

const QUEUE_DIR = join("briefs", "queue");
const OUT_FILE = join("briefs", "review.html");

export function writeReviewPage(): string {
  const queued = loadAccounts().filter((a) => a.review?.status === "queued");
  const body = `<div class="top"><span class="brand">legwork</span><span class="spacer"></span><button class="theme" id="theme">dark mode</button></div>
<h1 class="headline">${queueHeadline(queued.length)}</h1>
<p class="sub">This page stages decisions; the command at the bottom records them. Every mark opens the page that fact came from.</p>
${renderQueueCards(queued)}
${stageBar()}`;
  writeFileSync(OUT_FILE, shell("legwork review queue", body, stageScript()));
  return OUT_FILE;
}

/** "2 briefs waiting for your review." — the sentence the overview and the review page share.
 *  A notification, not copy: digits, the thing that is waiting, and what it waits for. It
 *  does not say "lead" or "call" — a queued brief is a brief, not a promise about the company. */
export function queueHeadline(n: number): string {
  if (n === 0) return "Nothing waiting for your review.";
  return `${n} brief${n === 1 ? "" : "s"} waiting for your review.`;
}

export function renderQueueCards(queued: Account[], opts: { served?: boolean } = {}): string {
  if (queued.length === 0) return `<p class="empty">The queue is empty — every published brief cleared the confidence gate.</p>`;
  const gate = reviewGate();
  return queued.map((a) => card(a, opts.served === true, gate)).join("\n");
}

/** Segment letters as words, from the pack's icp.yaml — "A" tells a reader nothing. */
export function segmentNames(): Record<string, string> {
  try {
    const yaml = require("js-yaml") as typeof import("js-yaml");
    const icp = yaml.load(readFileSync(join(loadRegistry().pack, "icp.yaml"), "utf8")) as { segments?: Record<string, { name?: string }> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(icp?.segments ?? {})) if (v?.name) out[k] = String(v.name);
    return out;
  } catch {
    return {};
  }
}

// Same source of truth as the brief agent's gate: loops.review.confidence_gate (rule 8).
// A missing registry is not a reason to fail the page, so this degrades to the default.
function reviewGate(): number {
  try {
    const loops = loadRegistry().loops as Record<string, Record<string, unknown>>;
    const raw = loops.review?.confidence_gate;
    return typeof raw === "number" ? raw : 0.8;
  } catch {
    return 0.8;
  }
}

// Numbered receipts, per card: the first time a URL is cited it gets the next number and
// every later mention reuses it, so "1" means the same source everywhere on that card.
class Citer {
  private readonly numbers = new Map<string, number>();
  mark(url: string | undefined, claim?: string): string {
    if (!url) return "";
    let n = this.numbers.get(url);
    if (n === undefined) {
      n = this.numbers.size + 1;
      this.numbers.set(url, n);
    }
    return `<a class="receipt cite" href="${esc(url)}" target="_blank" data-receipt${claim ? ` data-claim="${esc(claim)}"` : ""} title="source ${n} · ${esc(sourceName(url))}" aria-label="source ${n}, ${esc(sourceName(url))}">${sourceIcon(url)}</a>`;
  }
  get count(): number {
    return this.numbers.size;
  }
}

// One card: the brief column and the rail. Served cards post the decision to the local
// server; static cards stage it. "Decide later" is the same on both — it records nothing
// and sets the card aside, because a skip that writes state is not a skip.
function card(a: Account, served: boolean, gate: number): string {
  return renderReviewCard(a, { served, actions: true, gate });
}

/** The one account view the whole console uses. `actions` shows the decision buttons
 *  (only queued accounts get them); the brief is read from queue/ or briefs/. */
export function renderReviewCard(a: Account, opts: { served?: boolean; actions?: boolean; gate?: number } = {}): string {
  const served = opts.served === true;
  const withActions = opts.actions === true && a.review?.status === "queued";
  const gate = opts.gate ?? reviewGate();
  const queueFile = join(QUEUE_DIR, `${a.org}.md`);
  const publishedFile = join("briefs", `${a.org}.md`);
  const briefFile = existsSync(queueFile) ? queueFile : publishedFile;
  const brief = existsSync(briefFile) ? readFileSync(briefFile, "utf8") : "";
  const v = buildBriefView(a, { gate, brief });
  const cites = new Citer();
  const q = a.qualification;

  const segName = v.segment ? segmentNames()[v.segment] : undefined;
  const sub = [
    v.domain ? esc(v.domain) : null,
    v.location ? `${esc(v.location.text)}${cites.mark(v.location.url, v.location.claim)}` : null,
    v.segment ? `segment ${esc(v.segment)}${segName ? ` — ${esc(segName)}` : ""}` : null,
    v.sample ? "sample data — links may not resolve" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const statsHtml = v.stats.length
    ? `<div class="rv-stats">${v.stats
        .map((s) => `<div class="rv-stat"><div class="v">${esc(s.value)}</div><div class="k">${esc(s.label)}${cites.mark(s.url, s.claim)}</div></div>`)
        .join("")}</div>`
    : "";

  const aboutHtml = v.about ? `<p class="rv-about">${esc(v.about.text)}${cites.mark(v.about.url, v.about.claim)}</p>` : "";

  const foundHtml = v.found.length
    ? `<div class="rv-sec"><div class="rv-h">What we found</div><div class="rv-facts">${v.found
        .map((f) => `<div>${esc(f.text)}${cites.mark(f.url, f.claim)}</div>`)
        .join("")}</div></div>`
    : "";

  const peopleHtml = v.people.length
    ? `<div class="rv-sec"><div class="rv-h">Who to talk to</div><div class="rv-people">${v.people
        .map(
          (p) => `<div class="rv-person"><div class="rv-avatar" aria-hidden="true"></div><div><div class="rv-pname">${esc(p.name)}${cites.mark(p.url, p.claim)}</div><div class="rv-pdetail">${esc(p.detail)}</div></div></div>`,
        )
        .join("")}</div></div>`
    : "";

  const openerHtml = v.opener.length
    ? `<div class="rv-sec"><div class="rv-h">Suggested opener</div><div class="rv-opener">${renderCited(v.opener, cites)}</div></div>`
    : "";

  const signals = (q?.signals ?? [])
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="num">${s.value.toFixed(2)} × ${s.weight.toFixed(2)}</td>` +
        `<td class="num">+${s.contribution.toFixed(2)}</td>` +
        `<td>${s.evidence_url ? `<a href="${esc(s.evidence_url)}" target="_blank"${receiptAttrs(s.name)}>receipt</a>` : "—"}</td></tr>`,
    )
    .join("");
  const assumptions = (q?.assumptions ?? []).map((x) => `<li>${esc(x)}</li>`).join("");
  const scoring = q
    ? `<p class="rv-scoreline">Score <strong>${q.score.toFixed(2)}</strong> against a threshold of ${q.threshold.toFixed(2)}; briefs publish on their own at ${gate.toFixed(2)}. Proposed action: ${esc(q.action)}.</p>
      <table><tr><th>signal</th><th>value × weight</th><th>adds</th><th>source</th></tr>${signals}</table>
      <h3>Assumptions — what the model admits it doesn't know</h3>
      <ul>${assumptions || "<li>none recorded</li>"}</ul>
      ${q.fallback ? `<p class="fallback">Fallback: ${esc(q.fallback)}</p>` : ""}`
    : `<p class="empty">No qualification record on this account.</p>`;

  const have = v.have.map((i) => `<div class="rv-ck"><span class="rv-tick">✓</span><span>${esc(i.label)}${cites.mark(i.url)}</span></div>`).join("");
  const missing = v.missing.map((i) => `<div class="rv-ck dim"><span class="rv-dash">–</span><span>${esc(i.label)}</span></div>`).join("");

  const summaryFile = [join(QUEUE_DIR, `${a.org}.summary.txt`), join("briefs", `${a.org}.summary.txt`)].find((f) => existsSync(f));
  const summary = summaryFile ? readFileSync(summaryFile, "utf8") : "";
  // The handoff row. Copy is always there; Send to Slack appears when the desk process
  // has a webhook — a human pressing it once per brief is what human-tier means, and
  // every send is appended to data/sends.jsonl by the server.
  const canSlack = served && Boolean(process.env.SLACK_WEBHOOK_URL) && summary !== "";
  const copySlack = `<div class="copyrow">${brief ? `<button data-copy="brief" class="pill quiet">Copy brief</button>` : ""}${
    summary ? `<button data-copy="summary" class="pill quiet">Copy summary</button>` : ""
  }${canSlack ? `<button data-send-slack class="pill">Send to Slack</button>` : ""}</div>${
    brief ? `<pre class="brieftext" hidden>${esc(brief)}</pre>` : ""
  }${summary ? `<pre class="slacktext" hidden>${esc(summary)}</pre>` : ""}`;
  const decisionButtons = withActions
    ? `
    <button data-act="approve" class="pill primary" title="records your approval and moves the brief to Published — nothing is sent anywhere">Approve</button>
    <button data-act="reject" class="pill">Not a fit</button>
    <button data-act="later" class="pill quiet">Later</button>
    ${copySlack}${served ? `\n    <span class="cardnote">Approve records the decision and publishes the brief; nothing sends itself.</span>` : ""}`
    : `
    ${copySlack}
    <span class="cardnote">${a.review?.status === "approved" || (a.stage === "briefed" && !a.review) ? "published" : a.review?.status === "rejected" ? "marked not a fit" : "no decision to make here"}</span>`;

  return `
<section class="card review" data-org="${esc(a.org)}">
  <div class="rv">
    <div class="rv-main">
      <div class="rv-id">
        <div class="rv-logo" aria-hidden="true">${esc(v.initial)}</div>
        <div class="rv-who"><h2 class="rv-name">${
          v.domain
            ? `<a class="receipt namelink" href="https://${esc(v.domain)}/" data-receipt data-claim="${esc(v.company)} — homepage" title="open ${esc(v.domain)} in the side panel">${esc(v.company)}</a>`
            : esc(v.company)
        }</h2><div class="rv-sub">${sub}</div></div>
        <span class="verdict" data-state="undecided"></span>
      </div>
      ${statsHtml}
      ${aboutHtml}
      ${foundHtml}
      ${peopleHtml}
      ${openerHtml}
      ${cites.count > 0 ? `<div class="rv-fine">Every mark opens the page that fact came from; the glyph is the source.</div>` : ""}
      <details class="rv-more" data-sec="scoring"><summary>See the scoring</summary><div class="why">${scoring}</div></details>
      <details class="rv-more" data-sec="brief"><summary>Read the full brief</summary><div class="brief">${brief ? mdToHtml(brief) : "<p class=\"empty\">(no brief file)</p>"}</div></details>
    </div>
    <div class="rv-rail">
      <div class="rv-verdict">
        <div class="rv-vword tone-${v.verdict.tone}">${esc(v.verdict.word)}</div>
        <div class="rv-bar"><div class="tone-${v.verdict.tone}" style="width:${v.verdict.pct}%"></div></div>
        <div class="rv-vmean">${esc(v.verdict.meaning)}</div>
      </div>
      <div class="rv-check">
        ${have ? `<div class="rv-k">What they have</div><div class="rv-cks">${have}</div>` : ""}
        ${missing ? `<div class="rv-k">What we couldn't find</div><div class="rv-cks dim">${missing}</div><div class="rv-finer">Not found means not found — we didn't score these as absent.</div>` : ""}
      </div>
      <footer>${decisionButtons}
      </footer>
      <button class="linkish" data-open="scoring">See the scoring →</button>
    </div>
  </div>
  <div class="rv-deferred"><span>${esc(v.company)} — set aside for now. It stays in the queue.</span><button class="linkish" data-act="reopen">Reopen</button></div>
</section>`;
}

// --- source marks -----------------------------------------------------------------------
//
// A receipt mark shows where the fact came from, as a small monochrome glyph in the text
// colour: Apple for the App Store, GitHub's mark, the Y for Hacker News, a tanuki for
// GitLab, a briefcase for a job board, a globe for the company's own site. Inline SVG —
// the page fetches nothing to draw them.
export function sourceName(url: string): string {
  const host = hostOf(url);
  if (!host) return "link";
  if (host === "apps.apple.com" || host === "itunes.apple.com") return "App Store";
  if (host === "github.com" || host === "raw.githubusercontent.com" || host === "api.github.com") return "GitHub";
  if (host === "gitlab.com") return "GitLab";
  if (host === "news.ycombinator.com") return "Hacker News";
  if (host === "play.google.com") return "Google Play";
  if (/(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|remotive\.com|remotive\.io|workable\.com|smartrecruiters\.com|myworkdayjobs\.com)$/.test(host)) return "job board";
  return host;
}

export function sourceIcon(url: string): string {
  const name = sourceName(url);
  const svg = (path: string, vb = "0 0 24 24") => `<svg class="src-icon" viewBox="${vb}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${path}"/></svg>`;
  switch (name) {
    case "App Store":
      return svg("M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701");
    case "GitHub":
      return svg("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12");
    case "Hacker News":
      return svg("M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z");
    case "GitLab":
      return svg("M22.65 14.39 12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z");
    case "Google Play":
      return svg("M3 20.5v-17c0-.59.34-1.11.84-1.35L13.69 12l-9.85 9.85c-.5-.25-.84-.76-.84-1.35zm13.81-5.38L6.05 21.34l8.49-8.49 2.27 2.27zm3.35-4.31c.34.27.59.69.59 1.19s-.22.9-.57 1.18l-2.29 1.32-2.5-2.5 2.5-2.5 2.27 1.31zM6.05 2.66l10.76 6.22-2.27 2.27-8.49-8.49z");
    case "job board":
      return svg("M10 2h4a2 2 0 0 1 2 2v2h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4V4a2 2 0 0 1 2-2zm0 4h4V4h-4v2zm-6 5v8h16v-8h-5v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-1H4zm0-3v1h16V8H4z");
    case "link":
      return svg("M10.59 13.41a1 1 0 0 1 0-1.41l2.83-2.83a1 1 0 1 1 1.41 1.41L12 13.41a1 1 0 0 1-1.41 0zM7.05 16.95a3 3 0 0 1 0-4.24l2.12-2.12-1.41-1.42-2.12 2.12a5 5 0 0 0 7.07 7.07l2.12-2.12-1.41-1.41-2.12 2.12a3 3 0 0 1-4.25 0zm9.9-9.9a3 3 0 0 1 0 4.24l-2.12 2.12 1.41 1.42 2.12-2.12a5 5 0 0 0-7.07-7.07L9.17 7.76l1.41 1.41 2.12-2.12a3 3 0 0 1 4.25 0z");
    default:
      // the company's own site, or anything else on the open web
      return svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 9h-2.95a15.7 15.7 0 0 0-1.38-5.72A8.03 8.03 0 0 1 18.93 11zM12 4.04c.83 1.2 1.48 2.9 1.83 4.96h-3.66c.35-2.06 1-3.76 1.83-4.96zM4.26 14a8 8 0 0 1 0-4h3.38a17.7 17.7 0 0 0 0 4H4.26zm.81 2h2.95c.32 2.1.8 4 1.38 5.72A8.03 8.03 0 0 1 5.07 16zm2.95-8H5.07a8.03 8.03 0 0 1 4.33-5.72A15.7 15.7 0 0 0 8.02 8zM12 19.96c-.83-1.2-1.48-2.9-1.83-4.96h3.66c-.35 2.06-1 3.76-1.83 4.96zM14.34 13H9.66a15.9 15.9 0 0 1 0-4h4.68a15.9 15.9 0 0 1 0 4zm.25 8.72c.58-1.72 1.06-3.62 1.38-5.72h2.95a8.03 8.03 0 0 1-4.33 5.72zM16.36 14a17.7 17.7 0 0 0 0-4h3.38a8 8 0 0 1 0 4h-3.38z");
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function renderCited(runs: Cited[], cites: Citer): string {
  return runs.map((r) => `${esc(r.text)}${cites.mark(r.url, r.claim)}`).join("");
}

export function stageBar(): string {
  return `<div id="bar">
  <p class="hint">Decisions staged here are not recorded until you run this in the repo: <button id="copy" class="pill quiet">copy</button></p>
  <div id="cmd">— no decisions staged yet —</div>
</div>`;
}

// The static page's script: localStorage staging plus the shared chrome (theme, tabs).
// Kept as one exported string; served mode reuses chromeScript() alone, because staging a
// decision it can record is nonsense.
export function stageScript(): string {
  return stagingScript() + chromeScript();
}

function stagingScript(): string {
  return `
  const VERDICT_WORDS = { approve: "Approved", reject: "Not a fit" };
  const state = JSON.parse(localStorage.getItem("legwork-review") || "{}");
  function paint() {
    document.querySelectorAll(".card").forEach((c) => {
      const v = state[c.dataset.org];
      const el = c.querySelector(".verdict");
      if (!el) return;
      el.dataset.state = v || "undecided";
      el.textContent = v ? VERDICT_WORDS[v] || v : "";
    });
    const parts = Object.entries(state).map(([org, v]) =>
      "npx tsx src/cli.ts review --" + (v === "approve" ? "approve" : "reject") + " " + org);
    const cmd = document.getElementById("cmd");
    if (cmd) cmd.textContent = parts.length ? parts.join(" && \\\\\\n") : "— no decisions staged yet —";
  }
  document.querySelectorAll(".card footer button[data-act]").forEach((b) => {
    b.addEventListener("click", () => {
      const org = b.closest(".card").dataset.org;
      // "later" stages nothing — it clears anything staged and sets the card aside (chrome handles the fold).
      if (b.dataset.act === "later" || b.dataset.act === "clear") delete state[org];
      else if (b.dataset.act === "approve" || b.dataset.act === "reject") state[org] = b.dataset.act;
      else return;
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
  let showTab = null;
  if (tabs.length) {
    showTab = (id) => {
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === id));
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
      history.replaceState(null, "", "#" + id);
    };
    tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
    const initial = location.hash.slice(1);
    showTab(document.getElementById(initial) && document.getElementById(initial).classList.contains("panel") ? initial : tabs[0].dataset.tab);
    // A deep link (#queue) is a tab, not an anchor: the browser must not scroll the chrome away.
    if (initial) requestAnimationFrame(() => window.scrollTo(0, 0));
  }
  // Page-level affordances that write no state. Delegated, because served mode swaps
  // panel bodies wholesale and nothing may be bound to a node.
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const go = t.closest("[data-tab-go]");
    if (go && showTab) { showTab(go.dataset.tabGo); window.scrollTo({ top: 0 }); return; }
    const later = t.closest('[data-act="later"]');
    if (later) { const c = later.closest(".card"); if (c) c.classList.add("deferred"); return; }
    const reopen = t.closest('[data-act="reopen"]');
    if (reopen) { const c = reopen.closest(".card"); if (c) c.classList.remove("deferred"); return; }
    const open = t.closest("[data-open]");
    if (open) {
      const c = open.closest(".card");
      const d = c && c.querySelector('details[data-sec="' + open.dataset.open + '"]');
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
      return;
    }
    const od = t.closest("[data-open-details]");
    if (od) {
      const d = document.getElementById(od.dataset.openDetails);
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
      return;
    }
    const copy = t.closest("[data-copy]");
    if (copy) {
      const scope = copy.closest(".card") || document;
      const src = scope.querySelector(copy.dataset.copy === "brief" ? ".brieftext" : ".slacktext");
      if (src) navigator.clipboard.writeText(src.textContent).then(() => {
        const was = copy.textContent;
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = was; }, 1400);
      });
    }
  });`;
}

// Served-mode chrome: the status chip, the log pane, and the in-place affordances on
// cards, fleet rows, and briefs. Same tokens as the static page — no new fonts, no new
// colors; the chip borrows the ok/warn/no trio the dots already use.
export function servedStyles(): string {
  return `  .chip { font-size:13px; padding:4px 12px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; }
  .chip[data-state="idle"] { display:none; }
  .chip[data-state="running"] { color:var(--warn); border-color:var(--warn); }
  .chip[data-state="done"] { color:var(--ok); border-color:var(--ok); }
  .chip[data-state="failed"] { color:var(--no); border-color:var(--no); }
  .oprow { display:flex; align-items:center; gap:12px; min-height:28px; margin-top:14px; }
  .logpane { background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:12px 14px; font:12.5px/1.6 var(--mono); color:var(--text); max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin-top:10px; }
  .logpane[data-empty="1"] { display:none; }
  .card.settled { opacity:.45; }
  .cardnote, .note { color:var(--dim); font-size:13px; }
  .cardnote[data-state="err"], .note[data-state="err"] { color:var(--no); }
  .rowact { text-align:right; }
  .rowact button { padding:4px 12px; font-size:12.5px; }
  .briefact { display:flex; align-items:center; gap:10px; margin:10px 0 2px; }
`;
}

export function servedScript(stateUrl = "/api/state"): string {
  return chromeScript() + `
  const STATE_URL = ${JSON.stringify(stateUrl)};` + `
  // Every call below is served-mode only; the static Pages copy ships without this script
  // and makes no network requests. Failures are always surfaced on the status chip.
  const VERDICT_WORDS = { approve: "Approved", reject: "Not a fit" };
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
    const headers = { "x-legwork-token": window.__LEGWORK_TOKEN__ || "" };
    const init = body === undefined
      ? { headers }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
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
    const data = await api(STATE_URL);
    const html = data.html || {};
    // The live transcript and status chip live inside a panel; replacing the panel must
    // not erase the record of the run that just happened.
    const keepLog = document.getElementById("op-log");
    const keepChip = document.getElementById("op-status");
    const saved = { log: keepLog ? keepLog.textContent : "", logEmpty: keepLog ? keepLog.dataset.empty : "1", chip: keepChip ? keepChip.textContent : "", chipState: keepChip ? keepChip.dataset.state : "idle" };
    Object.keys(html).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html[id];
    });
    const newLog = document.getElementById("op-log");
    if (newLog && saved.log) { newLog.textContent = saved.log; newLog.dataset.empty = saved.logEmpty; }
    const newChip = document.getElementById("op-status");
    if (newChip && saved.chipState !== "idle") { newChip.textContent = saved.chip; newChip.dataset.state = saved.chipState; }
    document.dispatchEvent(new CustomEvent("legwork:refreshed"));
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
    setStatus("running", mode === "live" ? "looking for companies · live" : "replaying the sample");
    writeLog("");
    try {
      await api("/api/run", sinceDays ? { mode, sinceDays } : { mode });
      await pollRun();
    } catch (e) { fail(e); }
  }
  async function runEvals() {
    setStatus("running", "checking it still works");
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
      if (verdict) { verdict.dataset.state = act; verdict.textContent = VERDICT_WORDS[act] || act; }
      card.classList.add("settled");
      card.querySelectorAll("footer button").forEach((b) => { b.disabled = true; });
      if (note) { note.dataset.state = ""; note.textContent = act === "approve" ? "Recorded. The brief moved to Published — nothing was sent; Copy for Slack is the handoff." : "Recorded — marked not a fit."; }
      const count = document.querySelector('.tabs button[data-tab="queue"] .count, .tabs button[data-tab="inbox"] .count');
      if (count) count.textContent = String(Math.max(0, Number(count.textContent) - 1));
      setStatus("done", act === "approve" ? "approved " + card.dataset.org : "marked " + card.dataset.org + " not a fit");
    } catch (e) { fail(e, note); }
  }
  async function retire(btn) {
    const agent = btn.dataset.retire;
    const out = document.getElementById("retire-out");
    setStatus("running", "writing the case · " + agent);
    try {
      const d = await api("/api/retire", { agent });
      if (out) {
        const box = document.createElement("details");
        box.open = true;
        const sum = document.createElement("summary");
        sum.textContent = "retirement memo — " + agent;
        const pre = document.createElement("pre");
        pre.className = "logpane";
        pre.dataset.empty = "0";
        pre.textContent = d.memo || "(empty memo)";
        box.appendChild(sum); box.appendChild(pre); out.appendChild(box);
        box.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setStatus("done", "memo written for " + agent);
    } catch (e) { fail(e); }
  }
  async function sendSlack(btn) {
    const card = btn.closest(".card");
    if (!card) return;
    const note = card.querySelector(".cardnote");
    btn.disabled = true;
    try {
      await api("/api/send", { org: card.closest("[data-org]") ? card.closest("[data-org]").dataset.org : card.dataset.org, target: "slack" });
      btn.textContent = "Sent";
      if (note) { note.dataset.state = ""; note.textContent = "Posted to Slack and logged to data/sends.jsonl."; }
    } catch (e) {
      btn.disabled = false;
      fail(e, note);
    }
  }
  // Delegated: panels are replaced wholesale on refresh, so nothing is bound to a node.
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const slackBtn = t.closest("[data-send-slack]");
    if (slackBtn) { sendSlack(slackBtn); return; }
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
    const act = t.closest(".card footer button[data-act]");
    if (act && (act.dataset.act === "approve" || act.dataset.act === "reject")) {
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
// console renders opens a right-hand drawer with the source previewed in place. The drawer
// stays open: clicking another receipt swaps what it shows, Esc or Close puts it away. The
// page stays live underneath — no scrim between you and the next number.
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
  /* no scrim: the page stays clickable while the drawer is up, so the next receipt is one click, not two */
  .rd-scrim { display:none; }
  .rd { position:fixed; top:0; right:0; z-index:61; height:100%; width:min(470px,94vw); display:flex; flex-direction:column; background:var(--bg); border-left:1px solid var(--line); box-shadow:none; transform:translateX(103%); visibility:hidden; transition:transform .5s cubic-bezier(.4,0,.2,1), visibility .5s, box-shadow .5s cubic-bezier(.4,0,.2,1); }
  /* The shadow belongs to .on and only .on. On a closed drawer it bleeds a pale band down
     the right edge of every page — found and fixed once already; do not hoist it to .rd. */
  .rd.on { transform:translateX(0); visibility:visible; box-shadow:-22px 0 48px rgba(0,0,0,.14); }
  [data-theme="dark"] .rd.on { box-shadow:-22px 0 48px rgba(0,0,0,.5); }
  /* while the drawer is up the page makes room for it instead of sitting under it */
  html.rd-open body { margin-right:min(470px, 94vw); margin-left:max(20px, calc((100vw - min(470px, 94vw) - 1120px) / 2)); transition:margin .5s cubic-bezier(.4,0,.2,1); }
  @media (max-width: 700px) { html.rd-open body { margin-left:0; margin-right:0; } }
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
    var res = await fetch("/api/receipt?url=" + encodeURIComponent(url), {
      headers: { accept: "application/json", "x-legwork-token": window.__LEGWORK_TOKEN__ || "" }
    });
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
    document.documentElement.classList.add("rd-open");
    drawer.classList.add("on");
    scrim.classList.add("on");
    drawer.setAttribute("aria-hidden", "false");
    drawer.focus();
  }

  function close() {
    if (!drawer.classList.contains("on")) return;
    token++; // any in-flight preview belongs to a drawer that is no longer open
    document.documentElement.classList.remove("rd-open");
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
    var a = t.closest("a[data-receipt]");
    if (!a) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // cmd-click still opens a tab
    ev.preventDefault();
    openFor(a);
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
})();`;
}

// One visual system for every generated page, on expo.dev's actual language: pure black
// (or white), Inter for everything including the numbers, thin outlines instead of filled
// boxes, pill buttons with a white-filled primary, and the tiny uppercase label used once
// per page rather than on every block. Mono only where code and logs live. Nothing on the
// AI-slop checklist — no gradients, no glow, no sparkle; restraint is the signature.
export function shell(title: string, body: string, script = "", extraCss = ""): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#ffffff; --bg-2:#f6f7f9; --card:#ffffff; --line:#e6e9ee; --line-strong:#d3d9e0;
    --text:#0d1117; --dim:#5b6472; --faint:#8a93a0; --accent:#0069d9; --accent-soft:#e8f1fc;
    --ok:#1f9d55; --no:#c93a3a; --warn:#a97a17; --ok-bg:#e8f6ee; --no-bg:#fdecec; --warn-bg:#fbf3dc;
    --mono1:#0d1117; --mono2:#e6e9ee;
    --sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  }
  [data-theme="dark"] {
    --bg:#000000; --bg-2:#0d0f11; --card:#000000; --line:#23262a; --line-strong:#33383e;
    --text:#f5f6f7; --dim:#9199a3; --faint:#6b7280; --accent:#4d9dfa; --accent-soft:#0f2340;
    --ok:#5bc98d; --no:#ef6a5a; --warn:#d9a94a; --ok-bg:#0f2a1b; --no-bg:#33171a; --warn-bg:#2e2512;
    --mono1:#f5f6f7; --mono2:#2a2e33;
  }
  * { box-sizing:border-box; margin:0; }
  html { background:var(--bg); }
  body { background:var(--bg); color:var(--text); font:16px/1.65 var(--sans); padding:40px 40px 80px; max-width:1120px; margin:0 auto; -webkit-font-smoothing:antialiased; }
  @media (max-width: 700px) { body { padding:24px 18px 60px; } }
  .top { display:flex; align-items:center; gap:18px; margin-bottom:18px; flex-wrap:wrap; }
  /* the wordmark: a mark and a name, so it reads as the product and not as the first tab */
  .top .brand { display:inline-flex; align-items:center; gap:10px; font-weight:700; font-size:21px; letter-spacing:-.04em; line-height:1; }
  .top .brand::before { content:""; width:12px; height:12px; border-radius:3px; background:var(--text); flex-shrink:0; }
  .modebadge { font-size:10.5px; font-weight:600; letter-spacing:.1em; padding:3px 8px; border-radius:999px; border:1px solid var(--line-strong); color:var(--dim); margin-left:-4px; }
  .modebadge[data-mode="live"] { color:var(--ok); border-color:var(--ok); }
  .modebadge[data-mode="fixture"] { color:var(--warn); border-color:var(--warn); }
  table.accounts td { vertical-align:middle; }
  table.accounts details.acct { margin:0; } table.accounts details.acct > summary { padding:0; color:var(--text); font-size:15px; font-weight:500; }
  table.accounts details.acct[open] > summary { margin-bottom:10px; }
  .health .row strong { font-weight:600; }
  .top .spacer { flex:1; }
  .theme { background:transparent; border:1px solid var(--line2, var(--line-strong)); color:var(--dim); border-radius:999px; padding:6px 14px; font:inherit; font-size:13px; cursor:pointer; }
  .theme:hover { color:var(--text); }
  .sub { color:var(--dim); font-size:14.5px; margin-bottom:18px; }
  .headline { font-size:34px; font-weight:600; letter-spacing:-.03em; line-height:1.25; max-width:22ch; margin-bottom:22px; }
  /* section nav: its own row under the wordmark, ruled, the active one underlined */
  .tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--line); margin:0 0 40px; }
  .tabs button { background:transparent; border:0; color:var(--dim); padding:10px 14px; margin-bottom:-1px; font:inherit; font-size:14.5px; font-weight:500; cursor:pointer; border-bottom:2px solid transparent; border-radius:0; }
  .tabs button:first-child { padding-left:0; }
  .tabs button:hover { color:var(--text); }
  .tabs button.active { color:var(--text); border-bottom-color:var(--text); }
  .tabs .count { color:var(--faint); margin-left:6px; font-size:12.5px; font-weight:500; }
  .panel { display:none; } .panel.active { display:block; }
  .panel > .lead { color:var(--dim); font-size:15px; margin-bottom:26px; max-width:66ch; }
  section.block { margin-bottom:44px; }
  section.block > h2, .h2 { font-size:22px; font-weight:600; letter-spacing:-.02em; margin-bottom:16px; }
  .label { font-size:11.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--faint); font-weight:600; }
  .card { border:1px solid var(--line); border-radius:16px; padding:26px 28px; margin-bottom:22px; background:var(--card); }
  .meta { color:var(--dim); font-size:13.5px; }
  .verdict { margin-left:auto; font-size:13px; padding:4px 12px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; white-space:nowrap; }
  .verdict[data-state="undecided"] { display:none; }
  .verdict[data-state="approve"] { color:var(--ok); border-color:var(--ok); }
  .verdict[data-state="reject"] { color:var(--no); border-color:var(--no); }
  h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); margin:18px 0 8px; font-weight:600; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  td,th { text-align:left; padding:9px 14px 9px 0; border-bottom:1px solid var(--line); color:var(--text); vertical-align:top; }
  th { color:var(--faint); font-weight:500; font-size:12.5px; }
  .num { font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right; }
  .dimcell { color:var(--dim); }
  ul { padding-left:18px; font-size:14px; }
  li { margin:4px 0; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .fallback { color:var(--dim); font-size:13.5px; margin-top:10px; }
  .brief { font-size:14.5px; }
  .brief h2, .memo h2 { font-size:17px; margin:8px 0; font-weight:600; }
  .brief h3, .memo h3 { text-transform:none; letter-spacing:0; color:var(--text); font-size:15px; margin-top:16px; font-weight:600; }
  blockquote { color:var(--dim); border-left:2px solid var(--line-strong); padding-left:12px; margin:8px 0; }
  code { font-family:var(--mono); font-size:12.5px; background:var(--bg-2); border:1px solid var(--line); padding:1px 6px; border-radius:6px; }
  button { background:transparent; color:var(--text); border:1px solid var(--line-strong); border-radius:999px; padding:8px 18px; font:inherit; font-size:14px; font-weight:500; cursor:pointer; }
  button:hover { border-color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  .pill { border-radius:999px; }
  .pill.primary { background:var(--text); color:var(--bg); border-color:var(--text); font-weight:600; }
  .pill.primary:hover { opacity:.9; }
  .pill.quiet { border-color:transparent; color:var(--dim); }
  .pill.quiet:hover { color:var(--text); }
  .linkish { background:transparent; border:0; padding:0; color:var(--dim); font-size:13.5px; cursor:pointer; border-radius:0; }
  .linkish:hover { color:var(--text); }
  #bar { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:14px 0 4px; margin-top:24px; }
  #cmd { width:100%; background:var(--bg-2); color:var(--text); border:1px solid var(--line); border-radius:12px; padding:10px 12px; font:12.5px/1.6 var(--mono); min-height:44px; white-space:pre-wrap; word-break:break-all; }
  #bar .hint, .empty { color:var(--dim); font-size:14px; margin:6px 0; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; margin-right:10px; vertical-align:middle; }
  .dot.ok { background:var(--ok); } .dot.err { background:var(--no); } .dot.warn { background:var(--warn); } .dot.none { background:var(--line-strong); }
  details { margin:8px 0; } summary { cursor:pointer; color:var(--dim); font-size:14.5px; padding:8px 0; }
  summary:hover { color:var(--text); }
  .memo { border:1px solid var(--line); border-radius:16px; padding:22px 24px; font-size:14.5px; margin-top:8px; }
  footer.page { color:var(--faint); font-size:13px; margin-top:56px; border-top:1px solid var(--line); padding-top:16px; }

  /* numbers: sans, large, quiet labels, one outlined row */
  .statrow { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); border:1px solid var(--line); border-radius:16px; overflow:hidden; margin-bottom:14px; }
  .funnel { color:var(--dim); font-size:14.5px; margin-bottom:52px; }
  .statrow .stat { padding:22px 24px; display:flex; flex-direction:column; gap:4px; }
  .statrow .stat + .stat { border-left:1px solid var(--line); }
  .statrow .v { font-size:26px; font-weight:600; letter-spacing:-.02em; }
  .statrow .k { font-size:14px; color:var(--dim); }
  @media (max-width: 760px) { .statrow { grid-template-columns:repeat(2, minmax(0,1fr)); } .statrow .stat:nth-child(3) { border-left:0; } .statrow .stat:nth-child(n+3) { border-top:1px solid var(--line); } }
  .kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:18px; }
  .kpi { border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .kpi .v { font-size:24px; font-weight:600; letter-spacing:-0.01em; } .kpi .k { color:var(--dim); font-size:13px; margin-top:2px; }

  /* review cards */
  .card.review { padding:34px 36px 30px; }
  .rv { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:56px; }
  @media (max-width: 900px) { .rv { grid-template-columns:1fr; gap:36px; } }
  .rv-main { display:flex; flex-direction:column; gap:30px; min-width:0; }
  .rv-id { display:flex; align-items:center; gap:16px; }
  .rv-logo { width:52px; height:52px; border-radius:13px; background:var(--mono1); color:var(--bg); display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:600; flex-shrink:0; }
  .rv-who { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .rv-name { font-size:30px; font-weight:600; letter-spacing:-.028em; line-height:1.15; }
  .rv-sub { font-size:14.5px; color:var(--dim); }
  .rv-stats { display:flex; gap:32px; flex-wrap:wrap; padding-bottom:22px; border-bottom:1px solid var(--line); margin-top:-12px; }
  .rv-stat { display:flex; flex-direction:column; gap:2px; }
  .rv-stat .v { font-size:19px; font-weight:600; }
  .rv-stat .k { font-size:13.5px; color:var(--dim); }
  .rv-about { font-size:17px; line-height:1.7; max-width:60ch; }
  .rv-sec { display:flex; flex-direction:column; gap:14px; }
  .rv-h { font-size:20px; font-weight:600; letter-spacing:-.018em; }
  .rv-facts { display:flex; flex-direction:column; gap:11px; font-size:16px; max-width:62ch; }
  .rv-people { display:flex; flex-direction:column; gap:12px; }
  .rv-person { display:flex; align-items:center; gap:13px; }
  .rv-avatar { width:34px; height:34px; border-radius:99px; background:var(--mono2); flex-shrink:0; }
  .rv-pname { font-size:15.5px; font-weight:600; }
  .rv-pdetail { font-size:13.5px; color:var(--dim); }
  .rv-opener { border:1px solid var(--line); border-radius:14px; padding:22px 24px; font-size:16.5px; line-height:1.75; max-width:58ch; }
  .rv-fine { font-size:14px; color:var(--dim); }
  .rv-finer { font-size:12.5px; color:var(--faint); line-height:1.5; padding-top:2px; }
  .rv-more { margin:0; border-top:1px solid var(--line); padding-top:6px; }
  .rv-more > summary { font-size:14.5px; }
  .rv-more .why { padding:6px 0 10px; }
  .rv-more .brief { padding:6px 0 10px; }
  .rv-scoreline { font-size:14.5px; color:var(--dim); margin:6px 0 12px; }
  .rv-rail { display:flex; flex-direction:column; gap:26px; }
  .rv-verdict { display:flex; flex-direction:column; gap:11px; }
  .rv-vword { font-size:23px; font-weight:600; letter-spacing:-.02em; }
  .tone-ok { color:var(--ok); } .tone-warn { color:var(--warn); }
  .rv-bar { height:6px; border-radius:99px; background:var(--line); overflow:hidden; }
  .rv-bar > div { height:100%; background:currentColor; }
  .rv-bar > .tone-ok { background:var(--ok); } .rv-bar > .tone-warn { background:var(--warn); }
  .rv-vmean { font-size:13.5px; color:var(--dim); }
  .rv-check { display:flex; flex-direction:column; gap:8px; padding-top:26px; border-top:1px solid var(--line); }
  .rv-k { font-size:13px; color:var(--dim); }
  .rv-k + .rv-cks { margin-bottom:10px; }
  .rv-cks { display:flex; flex-direction:column; gap:7px; font-size:14.5px; }
  .rv-cks.dim { color:var(--dim); }
  .rv-ck { display:flex; align-items:flex-start; gap:9px; }
  .rv-tick { color:var(--ok); flex-shrink:0; } .rv-dash { flex-shrink:0; }
  .card.review footer { display:flex; flex-direction:column; gap:9px; padding-top:26px; border-top:1px solid var(--line); margin:0; }
  .card.review footer button { width:100%; padding:13px; font-size:15px; }
  .card.review footer .pill.quiet { padding:11px; font-size:14.5px; }
  .card.review footer .cardnote { text-align:center; }
  .rv-rail > .linkish { align-self:flex-start; }
  .rv-deferred { display:none; align-items:center; gap:16px; color:var(--dim); font-size:14.5px; }
  .card.deferred { padding:16px 28px; }
  .card.deferred .rv { display:none; }
  .card.deferred .rv-deferred { display:flex; }
  a.namelink, a.namelink.receipt { color:inherit; text-decoration:none; }
  a.namelink:hover, a.namelink.receipt:hover { color:var(--accent); text-decoration:none; }
  .slacktext[hidden], .brieftext[hidden] { display:none; }
  .copyrow { display:flex; gap:8px; flex-wrap:wrap; }
  .copyrow .pill { padding:9px 14px; font-size:13.5px; }
  a.cite, a.cite.receipt { display:inline-block; color:var(--faint); padding-left:4px; line-height:1; text-decoration:none; vertical-align:-1px; }
  a.cite:hover, a.cite.receipt:hover { color:var(--accent); text-decoration:none; }
  .src-icon { width:12px; height:12px; display:inline-block; vertical-align:baseline; }
  .rv-name a.cite .src-icon, .rv-h a.cite .src-icon { width:14px; height:14px; }

  /* overview */
  .hero { display:flex; flex-direction:column; gap:22px; margin-bottom:52px; }
  .hero .actions { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .hero .actions .pill { padding:12px 26px; font-size:15px; }
  .hero .how { color:var(--dim); font-size:14.5px; }
  .startgrid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; }
  @media (max-width: 760px) { .startgrid { grid-template-columns:1fr; } }
  .startcard { border:1px solid var(--line); border-radius:16px; padding:22px 24px; display:flex; flex-direction:column; gap:7px; text-align:left; background:transparent; color:var(--text); font:inherit; align-items:stretch; }
  button.startcard { cursor:pointer; } button.startcard:hover { border-color:var(--line-strong); }
  .startcard .t { font-size:17px; font-weight:600; }
  .startcard .d { font-size:14px; color:var(--dim); line-height:1.55; }
  .startcard code { align-self:flex-start; margin-top:6px; }
  .alsoline { font-size:14.5px; color:var(--dim); margin-top:18px; }
  .health { border:1px solid var(--line); border-radius:16px; overflow:hidden; }
  .health .row { display:flex; align-items:center; gap:14px; padding:18px 24px; }
  .health .row + .row { border-top:1px solid var(--line); }
  .health .row > span:nth-child(2) { flex-grow:1; font-size:15.5px; }
  .health .row .act { font-size:14.5px; color:var(--accent); white-space:nowrap; }
  .health .row button.act { background:transparent; border:0; padding:0; border-radius:0; font-weight:500; cursor:pointer; }
  .health .row button.act:hover { text-decoration:underline; }
  .detail-block { margin-top:18px; }
  .detail-block > summary { font-size:14.5px; }
  .detail-block table { margin-top:10px; }
${drawerStyles()}${extraCss}</style>
<script>
  (function(){ var t = localStorage.getItem("legwork-theme") || "dark"; document.documentElement.dataset.theme = t; })();
</script>
${body}
${drawerMarkup()}
<script>${script}</script>
<script>${drawerScript()}</script>
`;
}
