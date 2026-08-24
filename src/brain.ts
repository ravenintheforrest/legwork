// How it runs: the fleet's brain, made legible — for the person who owns the fleet, not
// the person who wrote it.
//
// Every other panel shows what the fleet DID. This one shows what it is CONFIGURED to do,
// and where a person goes to change it. That is the whole claim of this project: the
// control surface is a handful of files in git, not a settings screen and not the code.
//
// So this file hardcodes no values. It reads registry.yaml, packs/*/icp.yaml, the prompt
// files, the golden set, and the scoring weights in qualify.ts at render time, and shows
// what it found — including the places where those files disagree with each other. A panel
// that lies about the config is worse than no panel, so every unreadable file degrades to
// a visible "not configured" line naming the path it wanted.
//
// The reader is a commercially-minded non-engineer. Two rules follow from that: plain words
// over correct-but-opaque ones (a term only appears if it is immediately explained, or if
// it is the literal string they will search for in a file), and one screen of orientation
// before any table. Reference-grade detail — full prompt bodies, per-unit settings, the
// whole golden-set breakdown — sits behind a <details> so the page scans in under a minute.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { PIPELINE } from "./agents/index.js";
import { loadRegistry } from "./registry.js";
import { esc, mdToHtml } from "./reviewhtml.js";
import { loadAccounts } from "./store.js";

const REGISTRY_FILE = "registry.yaml";
const QUALIFY_SRC = join("src", "agents", "qualify.ts");
const AGENT_SRC_DIR = join("src", "agents");
const PLAYBOOK_FILE = "PLAYBOOK.md";
const DEFAULT_PACK = join("packs", "expo");

// Each section carries its own nav label, so the contents list cannot drift from the page:
// both are built from the same array, in one place, below.
export interface Section {
  id: string;
  nav: string;
  heading: string;
  body: string;
}

// --- entry point ---------------------------------------------------------------------

export function renderBrain(opts: { served?: boolean; before?: Section[]; lead?: string } = {}): string {
  const served = opts.served === true;
  const raw = readYamlResult(REGISTRY_FILE);
  const reg = asRecord(raw.value);
  const pack = asString(reg["pack"]) ?? DEFAULT_PACK;
  const playbook = readPlaybook();

  const sections: Section[] = [
    ...(opts.before ?? []),
    guideSection(reg, pack),
    healthSection(raw),
    pipelineSection(reg, pack, playbook),
    tiersSection(reg),
    loopsSection(reg),
    icpSection(pack),
    beliefsSection(pack, served),
    promptsSection(pack, playbook),
    goldenSection(pack, playbook),
  ];

  const toc = `<nav class="braintoc" aria-label="Sections on this page">
  <p class="toctitle">On this page</p>
  <ul>${sections
    .map((s) => `<li><a href="#${s.id}" data-tocfor="${s.id}">${esc(s.nav)}</a></li>`)
    .join("")}</ul>
</nav>`;

  // The first two sections carry the page; everything after folds to a heading, so System
  // scans as a list of questions instead of a wall. The contents list opens a fold it links to.
  const bodies = sections
    .map((s, i) =>
      i < 2
        ? `<section class="block brainsec" id="${s.id}"><h2>${s.heading}</h2>\n${s.body}</section>`
        : `<section class="block brainsec" id="${s.id}"><details class="sysfold" id="fold-${s.id}"><summary><h2>${s.heading}</h2></summary>\n${s.body}</details></section>`,
    )
    .join("\n");

  return `
  <p class="lead">${opts.lead ?? "What this is and how it works, then how it is set up, in plain language. What the fleet does is decided by a few text files in this project, not by code; this page reads those files every time it is built, so it describes the fleet as it is right now. Every section ends with the file to open and what to look for inside it."}</p>
  <div class="brainwrap">
${toc}
  <div class="brainbody">
${bodies}
  <p class="sub brainclose">${
    served
      ? "This desk runs on your machine. The brain files and the two dials above can be edited right here — each Save writes the same file you would edit in the repo, so there is still exactly one version of the truth. Everything else stays a file edit on purpose."
      : "Nothing on this page can be edited here. Open the file, save it, re-run <code>legwork report</code>, reload. One place to write the setup, one place to read it."
  }</p>
  </div>
  </div>
${tocScript()}
`;
}

// The contents list is the only part of this panel that needs behavior. It is deliberately
// small and defensive: real anchors that work with the script dead, one delegated click
// handler so nothing is bound to a node (served mode replaces whole panels on refresh),
// and a guard so a second panel render does not install a second copy.
function tocScript(): string {
  return `<script>
(function () {
  if (window.__legworkBrainToc) return;
  window.__legworkBrainToc = true;
  var timer = null;
  function paint() {
    timer = null;
    var toc = document.querySelector(".braintoc");
    if (!toc || toc.offsetParent === null) return;
    var secs = [].slice.call(document.querySelectorAll(".brainsec"));
    if (!secs.length) return;
    var current = secs[0].id;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].getBoundingClientRect().top <= 140) current = secs[i].id;
    }
    if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) {
      current = secs[secs.length - 1].id;
    }
    [].forEach.call(toc.querySelectorAll("a[data-tocfor]"), function (a) {
      if (a.getAttribute("data-tocfor") === current) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }
  // setTimeout, not requestAnimationFrame: a frame callback never fires while the tab is
  // in the background, which would leave the throttle latched and the mark frozen.
  function schedule() {
    if (timer) return;
    timer = setTimeout(paint, 60);
  }
  addEventListener("scroll", schedule, { passive: true });
  // Capture, on the document as well: scroll events do not bubble, and the console is
  // sometimes rendered inside a host that scrolls a container rather than the window.
  document.addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  addEventListener("hashchange", schedule);
  // The tab machinery runs after this script and reveals the panel; a hidden panel has no
  // geometry, so the first mark has to wait a turn for the panel to actually be on screen.
  addEventListener("load", schedule);
  setTimeout(schedule, 0);
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) { schedule(); return; }
    var link = t.closest(".braintoc a[data-tocfor]");
    if (!link) { setTimeout(schedule, 0); return; }
    var target = document.getElementById(link.getAttribute("data-tocfor"));
    if (!target) return;
    ev.preventDefault();
    var fold = target.querySelector("details.sysfold");
    if (fold) fold.open = true;
    var top = target.getBoundingClientRect().top + window.pageYOffset - 20;
    var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm && "scrollBehavior" in document.documentElement.style) {
      window.scrollTo({ top: top, behavior: "smooth" });
    } else {
      window.scrollTo(0, top);
    }
    setTimeout(schedule, 80);
  });
  schedule();
})();
</script>`;
}

// --- 1. does the settings file still work ---------------------------------------------

// The panel's own honesty check. If registry.yaml stopped validating, every number below
// is being read from a file the runner would refuse, and the reader needs to know first.
// --- 0. the guide ------------------------------------------------------------------------
//
// The demo script (docs/DEMO-SCRIPT.md) as a page: what to say, what to show, where it
// lives. Numbers are read from the same files as everything else here, so the script
// cannot claim a unit count or a gate the fleet does not have.
function guideSection(reg: Record<string, unknown>, pack: string): Section {
  const id = "brain-guide";
  const nav = "What this is";
  const agents = asRecord(reg["agents"]);
  const units = PIPELINE.filter((n) => n in agents);
  const modelUnits = units.filter((n) => kindOf(n, pack).model).length;
  const weights = readWeights();
  const loops = asRecord(reg["loops"]);
  const review = asRecord(loops["review"]);
  const gate = typeof review["confidence_gate"] === "number" ? (review["confidence_gate"] as number) : null;
  const threshold = weights?.threshold ?? null;
  let queued = 0, briefed = 0, accounts = 0;
  try {
    const all = loadAccounts();
    accounts = all.length;
    queued = all.filter((a) => a.review?.status === "queued").length;
    briefed = all.filter((a) => a.stage === "briefed").length;
  } catch {
    /* no state yet: the guide still reads */
  }
  const pct = (n: number | null) => (n === null ? "the gate" : n.toFixed(2));

  const steps: Array<{ say: string; show: string; lives: string }> = [
    {
      say: "legwork finds companies that build mobile apps on Expo, checks the public evidence, and writes a short brief for each one that a salesperson could read in two minutes. Building the agents was the small part. Most of the code here runs them: it records what each one costs, checks their output against an answer key, queues anything uncertain for a person, and writes the case for retiring a unit that stopped earning its place.",
      show: `<button class="linkish" data-tab-go="overview">Home</button>: one sentence on what is waiting, four numbers, three buttons.`,
      lives: "CLAUDE.md (the rules it was built under), registry.yaml (the fleet as config)",
    },
    {
      say: `A run is ${units.length} units in a fixed order: find candidates, resolve them to a company, read the homepage, score, write the brief. Each unit is a plain function that takes the list of accounts and returns the ones it changed. ${modelUnits} of them ${modelUnits === 1 ? "calls" : "call"} a model; the rest are ordinary code. Every unit logs what went in, what came out, how long it took, and what it cost.`,
      show: `<button class="linkish" data-tab-go="overview">Home → Start a search</button>. "Replay the sample" runs everything offline on saved examples and produces the same bytes every time. "Look for companies" runs the same steps against the live web. <button class="linkish" data-tab-go="runs">Runs</button> shows the log.`,
      lives: "src/agents/index.ts (the order), src/agents/*.ts (one file per unit), data/runs.jsonl (the log)",
    },
    {
      say: "A brief is one company as a salesperson would read it: who they are, what we found, who to talk to, a suggested first message. Every mark next to a sentence links to the page that fact came from. The model wrote the prose from evidence it was handed and nothing else; if it cites a page that is not in that evidence, the brief is rejected and a plain template is written instead.",
      show: `<button class="linkish" data-tab-go="queue">Review</button>: open a card, click a mark and the source opens beside the page. "See the scoring" shows the math, which the model does not touch.${queued ? ` ${queued} ${queued === 1 ? "is" : "are"} waiting right now.` : ""}`,
      lives: "briefs/ (the artifacts), packs/expo/prompts/brief.md (what the model is told), src/agents/brief.ts — validateModelBrief (the citations check)",
    },
    {
      say: `An account qualifies when two things are true. First, there is public evidence the company builds on Expo: an eas.json file in one of its repos, a job post it published that names Expo or EAS, or one of its engineers opening an issue on Expo's own tracker. Second, the weighted score is at least ${pct(threshold)}. A brief that scores under ${pct(gate)} waits for a person; above that it publishes on its own. A personal GitHub account never qualifies.`,
      show: `The right-hand column of any Review card: the verdict, what they have, what we could not find. "Not found" is scored as unknown, not as no.`,
      lives: "src/agents/qualify.ts (weights, threshold, the gate), packs/expo/icp.yaml (segments), registry.yaml loops.review.confidence_gate",
    },
    {
      say: "The fleet checks itself. An answer key of accounts with known verdicts is re-scored on every change, and a drop below the saved baseline fails the build. The offline demo produces identical output run after run. A self-test proves the harness never touches the live files.",
      show: `<button class="linkish" data-tab-go="evals">Evals</button>, or "Check it still works" on Home. In a terminal: <code>legwork evals</code>, <code>legwork selftest</code>.`,
      lives: "packs/expo/golden-set.jsonl (the answer key), packs/expo/evals-baseline.json, src/selftest.ts",
    },
    {
      say: "Each unit is judged on its own record: what it cost, what only it produced, and whether any of that reached a brief. When a unit's contribution stays near zero over enough runs, the fleet writes the case for retiring it. Acting on that case is a pull request a person opens.",
      show: `<button class="linkish" data-tab-go="memos">Memos</button>: the case for retiring discover-gitlab. In a terminal: <code>legwork retire &lt;unit&gt;</code>.`,
      lives: "memos/ (the cases), src/retire.ts (the math), registry.yaml loops.retirement.candidate_threshold",
    },
    {
      say: "What the fleet knows about the seller is written in four plain files: who we are, who we sell to, what we offer, how we talk, plus one persona per kind of reader. The brief prompt reads them on every run. They shape the voice of the message and whom it addresses. They are never treated as facts about a company.",
      show: `"What the fleet believes", further down this page.`,
      lives: "packs/expo/brain/*.md and brain/personas/*.md",
    },
    {
      say: "It can propose changes to itself. improve writes a revised prompt and a memo explaining why, as a pull request; a person merges it. How much each unit may do without a person is a setting with three values, fix, propose, or human, and anything that sends a message or touches a credential is always human.",
      show: `"What the fleet may do on its own", below. In a terminal: <code>legwork improve brief</code>.`,
      lives: "registry.yaml autonomy tiers, src/improve.ts",
    },
    {
      say: `The limits, stated plainly. Only public data: no telemetry, nothing behind a login, no LinkedIn. The live funnel is shown as it is${accounts ? `: ${accounts} leads in the file today, ${briefed} with a brief` : " on Home, as leads checked → companies → briefs"}. The offline demo shows the architecture; it is not evidence about the market.`,
      show: `The funnel line under the numbers on <button class="linkish" data-tab-go="overview">Home</button>.`,
      lives: "CLAUDE.md rule 9, docs/specs/private-repo-path.md (why the live funnel was thin and what changed)",
    },
    {
      say: "The discovery inputs are the replaceable part. Pointed at first-party data, signups or EAS usage, the same scoring, review, cost and retirement loop would run unchanged.",
      show: "Nothing further.",
      lives: "docs/DEMO-SCRIPT.md (the rehearsed terminal version)",
    },
  ];

  const body = `<p class="sub">Written for whoever is reading over the operator's shoulder. The picture first, then ten short steps in the order you would look at them; each says where to look on this page and which file it comes from. The rehearsed terminal version is <code>docs/DEMO-SCRIPT.md</code>.</p>
${guideDiagram(units.length, threshold, gate)}
<ol class="guide">
${steps
    .map(
      (st) => `<li><div class="g-say">${st.say}</div><div class="g-row"><span class="g-k">look</span><span>${st.show}</span></div><div class="g-row"><span class="g-k">file</span><span><code>${esc(st.lives).replace(/, /g, "</code>, <code>")}</code></span></div></li>`,
    )
    .join("\n")}
</ol>`;
  return { id, nav, heading: "What this is and how it works", body };
}

// The guide's picture: trigger → public sources → the fleet → the gate's two outcomes → a
// person. Inline SVG on the page's own tokens — nothing fetched, both themes, and the
// numbers come from the same config as the text, so the picture cannot drift from it.
function guideDiagram(unitCount: number, threshold: number | null, gate: number | null): string {
  const t = (n: number | null, fallback: string) => (n === null ? fallback : n.toFixed(2));
  const box = (x: number, y: number, w: number, h: number, title: string, sub: string, tone?: "ok" | "warn") => {
    const stroke = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--line-strong)";
    const sublines = sub.split("\n");
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="none" stroke="${stroke}"/>
    <text x="${x + w / 2}" y="${y + (sublines[0] ? 24 : h / 2 + 5)}" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="600">${esc(title)}</text>
    ${sublines.filter(Boolean).map((line, i) => `<text x="${x + w / 2}" y="${y + 43 + i * 16}" text-anchor="middle" fill="var(--dim)" font-size="12">${esc(line)}</text>`).join("\n    ")}`;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, arrow = true) =>
    `<path d="M ${x1} ${y1} ${x1 === x2 ? `L ${x2} ${y2}` : `L ${x1} ${(y1 + y2) / 2} L ${x2} ${(y1 + y2) / 2} L ${x2} ${y2}`}" fill="none" stroke="var(--line-strong)"${arrow ? ` marker-end="url(#gd-arrow)"` : ""}/>`;
  const label = (x: number, y: number, textContent: string) =>
    `<text x="${x}" y="${y}" text-anchor="middle" fill="var(--faint)" font-size="10.5" letter-spacing="1.5" style="text-transform:uppercase">${esc(textContent)}</text>`;

  return `<div class="gd-wrap"><svg viewBox="0 0 960 560" role="img" aria-label="How a run flows: a trigger, public sources, the fleet, the gate's two outcomes, then a person" style="width:100%;max-width:960px;height:auto;display:block;margin:6px 0 26px;">
  <defs><marker id="gd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--line-strong)"/></marker></defs>
  ${label(480, 14, "starts when")}
  ${box(310, 22, 340, 58, "You press Search — or Monday morning does", "legwork run · every start is a person or a schedule you can read")}
  ${line(480, 80, 480, 108)}
  ${label(480, 102, "public sources only")}
  ${box(15, 112, 240, 72, "GitHub", "code search for eas.json\nissues on Expo's own trackers")}
  ${box(265, 112, 240, 72, "Job boards", "HN · Remotive · web search\na company's own ATS board")}
  ${box(515, 112, 220, 72, "App Store + homepage", "ratings, ship dates\nwhat they say they do")}
  ${box(745, 112, 200, 72, "GitLab", "public projects\n(measured, near retirement)")}
  ${line(135, 184, 480, 232, false)}${line(385, 184, 480, 232, false)}${line(625, 184, 480, 232, false)}${line(845, 184, 480, 232)}
  ${box(240, 236, 480, 66, `The fleet — ${unitCount} units, in a fixed order`, "find → resolve → read the homepage → score → write the brief\nevery unit logs records in and out, time, and dollars")}
  ${line(480, 302, 480, 330)}
  ${label(480, 324, `the gate: production evidence + score ≥ ${t(threshold, "the threshold")}`)}
  ${line(480, 334, 250, 366)}${line(480, 334, 710, 366)}
  ${box(80, 370, 340, 66, `Inbox — under ${t(gate, "the publish line")}`, "a brief that is not sure enough waits for you\nSend to the AE · Not a fit · Decide later", "warn")}
  ${box(540, 370, 340, 66, `Published — ${t(gate, "the publish line")} and up`, "every sentence carries its receipt\nclick any mark to see the source", "ok")}
  ${line(250, 436, 480, 486)}${line(710, 436, 480, 486)}
  ${box(310, 490, 340, 58, "A person, always", "nothing sends itself · approving records a decision, not an email")}
</svg></div>`;
}

// --- 5b. the brain -------------------------------------------------------------------------
//
// The pack's brain: what the selling team wrote down about itself. Shown whole, because
// the point of writing it into files was that a person could read it without opening an
// editor — and change it with one.
function beliefsSection(pack: string, served = false): Section {
  const id = "brain-beliefs";
  const nav = "What the fleet believes";
  const heading = "What the fleet believes — the pack's brain";
  const dir = join(pack, "brain");
  const order = ["company.md", "customer.md", "offer.md", "voice.md"];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
  } catch {
    return {
      id, nav, heading,
      body: `<p class="empty">There is no <code>${esc(dir)}</code> folder. The brief prompt's brain slot is empty, so the model knows nothing about who is selling.</p>
${changeLine([`Create <code>${esc(dir)}/company.md</code>, <code>customer.md</code>, <code>offer.md</code>, <code>voice.md</code>. The brief prompt fills them in on the next run.`])}`,
    };
  }
  const personaDir = join(dir, "personas");
  const personas = existsSync(personaDir) ? readdirSync(personaDir).filter((f) => f.endsWith(".md")).sort() : [];
  const render = (path: string, label: string, open: boolean) => {
    const text = readText(path);
    const editor = served && text !== null
      ? `<div class="editwrap"><button class="linkish" data-edit-brain>Edit</button>
<form class="brainedit" hidden onsubmit="return false" data-file="${esc(path)}"><textarea rows="14" spellcheck="false">${esc(text)}</textarea>
<div class="searchrow"><button class="pill" data-save-brain>Save</button><span class="dimline brainedit-note">The next run reads the change. Re-capture the replay fixtures before a demo that relies on them.</span></div></form></div>`
      : "";
    return `<details${open ? " open" : ""}><summary>${esc(label)} <span class="dimcell">· ${esc(path)}</span></summary><div class="memo">${text === null ? '<p class="empty">could not be read</p>' : mdToHtml(text)}</div>${editor}</details>`;
  };
  const items = [
    ...files.map((f, i) => render(join(dir, f), f.replace(/\.md$/, ""), i === 0)),
    ...personas.map((f) => render(join(personaDir, f), `persona — ${f.replace(/\.md$/, "").replace(/-/g, " ")}`, false)),
  ];
  return {
    id, nav, heading,
    body: `<p class="sub">${files.length} file${files.length === 1 ? "" : "s"}${personas.length ? ` and ${personas.length} persona${personas.length === 1 ? "" : "s"}` : ""}, read into the brief prompt's system block on every run as context about the seller — never as a fact about an account. What is written here shapes the opener's voice and whom it addresses.</p>
${items.join("\n") || '<p class="empty">The folder is empty.</p>'}
${changeLine([`Edit any file under <code>${esc(dir)}</code> and save; the next brief run reads it. A prompt that reads a changed brain is a changed prompt: re-capture the replay fixtures before shipping.`])}`,
  };
}

function healthSection(raw: YamlResult): Section {
  const id = "brain-health";
  const nav = "Config health";
  const heading = "Config health — can the fleet start";
  const intro = `<p class="sub">One file, <code>${esc(REGISTRY_FILE)}</code>, decides what runs. A typo in it stops the fleet before anything else happens, so it gets checked first — and everything further down this page is read out of it.</p>`;

  if (raw.missing) {
    return {
      id,
      nav,
      heading,
      body: `${intro}
<p class="empty"><span class="bpill" data-kind="human">missing</span> There is no <code>${esc(REGISTRY_FILE)}</code> in this folder. Everything it defines is blank below.</p>`,
    };
  }
  if (raw.error !== null) {
    return {
      id,
      nav,
      heading,
      body: `${intro}
<p><span class="bpill" data-kind="human">will not open</span> <span class="dimcell"><code>${esc(REGISTRY_FILE)}</code> has a formatting error, so the fleet cannot start: ${esc(raw.error)}</span></p>
${changeLine([
        `Open <code>${esc(REGISTRY_FILE)}</code> and go to the line named in the message above. The usual cause is a value containing a colon followed by a space; wrap that value in quotes and save.`,
      ])}`,
    };
  }

  let status = `<p><span class="bpill" data-kind="ok">reads cleanly</span> <span class="dimcell"><code>${esc(REGISTRY_FILE)}</code> opens without error and has every field the fleet requires.</span></p>`;
  try {
    loadRegistry(REGISTRY_FILE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status = `<p><span class="bpill" data-kind="human">missing something</span> <span class="dimcell">${esc(message)} — the fleet will refuse this file. Everything below is read straight from it and may be incomplete.</span></p>
${changeLine([`Open <code>${esc(REGISTRY_FILE)}</code> and add the field named above, then re-run.`])}`;
  }
  return { id, nav, heading, body: `${intro}\n${status}` };
}

// --- 2. the pipeline ------------------------------------------------------------------

function pipelineSection(reg: Record<string, unknown>, pack: string, playbook: PlaybookStep[]): Section {
  const id = "brain-pipeline";
  const nav = "What runs, in order";
  const agents = asRecord(reg["agents"]);
  const defaults = asRecord(reg["defaults"]);
  const names = Object.keys(agents);

  if (names.length === 0) {
    return {
      id,
      nav,
      heading: "What runs, in order",
      body: `<p class="empty">There is no <code>agents:</code> list in <code>${esc(REGISTRY_FILE)}</code>, so nothing is set up to run.</p>
${changeLine(
        [`Open <code>${esc(REGISTRY_FILE)}</code> and add an <code>agents:</code> block. The playbook walks through the smallest possible one.`],
        playbook,
        [1, 2, 3],
      )}`,
    };
  }

  // Pipeline order first (that is the order the runner executes), then anything in the
  // registry the runner has no slot for — usually a scheduled unit, sometimes a typo.
  const ordered = [...PIPELINE.filter((n) => n in agents), ...names.filter((n) => !PIPELINE.includes(n))];
  const modelCount = ordered.filter((n) => kindOf(n, pack).model).length;

  const summaryRows = ordered
    .map((name) => {
      const entry = asRecord(agents[name]);
      const kind = kindOf(name, pack);
      const inPipeline = PIPELINE.includes(name);
      const step = inPipeline ? String(PIPELINE.indexOf(name) + 1) : "—";
      const does = asString(entry["does"]);
      const schedule = asString(entry["schedule"]);
      const extra = inPipeline
        ? ""
        : ` <span class="bpill" data-kind="warn">${schedule ? `runs ${esc(schedule)}, not in a normal run` : "not in a normal run"}</span>`;
      return `<tr>
  <td class="num">${step}</td>
  <td><span class="mono">${esc(name)}</span></td>
  <td class="dimcell">${does ? esc(does) : '<span class="empty">no description written for this one</span>'}</td>
  <td>${kindPill(kind.badge)}${extra}</td>
</tr>`;
    })
    .join("");

  const cards = ordered
    .map((name) => unitCard(name, asRecord(agents[name]), defaults, pack))
    .join("\n");

  const plainCount = ordered.length - modelCount;
  return {
    id,
    nav,
    heading: `What runs, in order — ${ordered.length} units, ${modelCount} of them ${modelCount === 1 ? "asks" : "ask"} an AI model`,
    body: `<p class="sub" style="margin-bottom:14px">A run is a relay. Each unit takes the list of companies, adds the one thing it knows how to find, and hands it to the next one. Nothing is remembered between runs — the files are the memory, which is why you can read them.</p>
<p class="sub" style="margin-bottom:14px">${plainCount} of these ${plainCount === 1 ? "unit is" : "units are"} ordinary software: ${plainCount === 1 ? "it fetches" : "they fetch"} a page, read it, and count things, and ${plainCount === 1 ? "gets" : "get"} the same answer every time. ${
      modelCount === 0
        ? "Nothing here asks an AI model."
        : `${modelCount === 1 ? "One unit asks" : `${modelCount} units ask`} an AI model, and only where the work is a judgment call. The badge on each row says which, and the detail below says how that was determined.`
    }</p>
<table class="runorder"><tr><th>step</th><th>unit</th><th>what it does</th><th>how it works</th></tr>${summaryRows}</table>
<details class="unitdetails">
  <summary>Open the full setup for ${ordered.length === 1 ? "this unit" : `all ${ordered.length} units`} — model, spend limit, what each one reads and writes</summary>
  <div class="units">${cards}</div>
</details>
${changeLine(
      [
        `Open <code>${esc(REGISTRY_FILE)}</code> and find <code>agents:</code>. Each unit is a block under it: the sentence after <code>does:</code> is what it is for, <code>cost_ceiling_usd:</code> is what one run of it may spend, <code>model:</code> picks which AI model runs it.`,
        `Anything a unit does not spell out it takes from the <code>defaults:</code> block near the top of the same file.`,
      ],
      playbook,
      [1, 2, 3],
    )}`,
  };
}

function kindPill(badge: "model" | "code" | "none"): string {
  if (badge === "model") return `<span class="bpill" data-kind="model">asks a model</span>`;
  if (badge === "code") return `<span class="bpill" data-kind="ok">plain code</span>`;
  return `<span class="bpill" data-kind="warn">not built yet</span>`;
}

function unitCard(
  name: string,
  entry: Record<string, unknown>,
  defaults: Record<string, unknown>,
  pack: string,
): string {
  const inPipeline = PIPELINE.includes(name);
  const step = inPipeline ? `<span class="step">${PIPELINE.indexOf(name) + 1}</span>` : "";
  const kind = kindOf(name, pack);

  const model = inherit(asString(entry["model"]), asString(defaults["model"]));
  const ceiling = inherit(asNumber(entry["cost_ceiling_usd"]), asNumber(defaults["cost_ceiling_usd"]));
  const autonomy = inherit(asString(entry["autonomy"]), asString(defaults["autonomy"]));

  const sources = asStringArray(entry["sources"]);
  const signals = asStringArray(entry["signals"]);
  const does = asString(entry["does"]);
  const output = asString(entry["output"]);
  const schedule = asString(entry["schedule"]);
  const hypothesis = asString(entry["hypothesis"]);

  const rows: string[] = [];
  if (sources.length) rows.push(row("where it looks", sources.map(codeTag).join(" ")));
  if (signals.length) rows.push(row("what it looks for", signals.map(codeTag).join(" ")));
  if (!sources.length && !signals.length) {
    rows.push(
      row(
        "where it looks",
        `<span class="dimcell">${
          inPipeline
            ? "nowhere new — it works on what the units before it produced"
            : "nothing listed — it works on files the fleet has already written"
        }</span>`,
      ),
    );
  }
  rows.push(
    row(
      "AI model",
      kind.model
        ? valueWithOrigin(model, (v) => `<span class="mono">${esc(v)}</span>`)
        : `<span class="dimcell">${model.value ? `would be <span class="mono">${esc(model.value)}</span>` : "none set"}${
            model.inherited ? " (from the defaults block)" : ""
          }, but ${
            kind.badge === "none"
              ? "nothing is built yet, so nothing spends it"
              : "this unit never asks a model"
          }</span>`,
    ),
  );
  rows.push(
    row(
      "spend limit",
      valueWithOrigin(ceiling, (v) => `at most <span class="mono">$${v.toFixed(2)}</span> in one run; past that the run is stopped`),
    ),
  );
  rows.push(row("how far it may go", autonomyPill(autonomy)));
  if (output) rows.push(row("writes to", codeTag(output)));
  if (schedule) rows.push(row("runs", codeTag(schedule)));

  const notes: string[] = [];
  if (hypothesis) {
    notes.push(
      `<p class="hyp"><span class="hyplabel">Why we are trying it</span> ${esc(hypothesis)} <span class="dimcell">Written down before it ran, so the retirement loop can settle it later with numbers instead of opinions.</span></p>`,
    );
  }
  if (!inPipeline) {
    notes.push(
      `<p class="hyp"><span class="hyplabel">Does not run in a normal run</span> <span class="dimcell">It is set up in <code>${esc(REGISTRY_FILE)}</code>, but the run order in <code>src/agents/index.ts</code> leaves it out${
        schedule ? `, because it runs ${esc(schedule)} on its own` : ""
      }.</span></p>`,
    );
  }

  return `<section class="card unit">
  <header>
    <h2>${step}${esc(name)}</h2>
    ${kindPill(kind.badge)}
  </header>
  <p class="does">${does ? esc(does) : '<span class="empty">nothing written after <code>does:</code> — nobody can tell what this unit is for</span>'}</p>
  <table>${rows.join("")}</table>
  ${notes.join("\n  ")}
  <p class="kindwhy">${kind.why}</p>
</section>`;
}

// Plain code or model-backed is a claim about the code, so it is read off the code: a unit
// asks a model iff its module touches the one model interface (`ctx.llm`), and the prompt
// file it would use is right there in the pack. Nothing here is a lookup table.
function kindOf(name: string, pack: string): { model: boolean; badge: "model" | "code" | "none"; why: string } {
  const srcFile = join(AGENT_SRC_DIR, `${name}.ts`);
  const promptFile = join(pack, "prompts", `${name}.md`);
  const src = readText(srcFile);
  const hasPrompt = existsSync(promptFile);

  if (src === null) {
    return {
      model: hasPrompt,
      badge: hasPrompt ? "model" : "none",
      why: hasPrompt
        ? `There is a written prompt at <code>${esc(promptFile)}</code>, but no code yet at <code>${esc(srcFile)}</code> to send it.`
        : `Nothing is built: no code at <code>${esc(srcFile)}</code> and no prompt file. This is a line in the settings file and nothing more.`,
    };
  }
  const usesLlm = /\bctx\.llm\b/.test(src);
  if (!usesLlm) {
    return {
      model: false,
      badge: "code",
      why: `Runs the same way every time. <code>${esc(srcFile)}</code> never calls a model — it fetches pages, reads them, and does arithmetic.`,
    };
  }
  return {
    model: true,
    badge: "model",
    why: hasPrompt
      ? `<code>${esc(srcFile)}</code> asks a model, using the words in <code>${esc(promptFile)}</code>.`
      : `<code>${esc(srcFile)}</code> asks a model, but the prompt file it expects at <code>${esc(promptFile)}</code> is missing.`,
  };
}

// --- 3. how far the fleet may go on its own -------------------------------------------

const TIER_ORDER = ["fix", "propose", "human"];

// Two registers for each tier: a three-word plain name for the pill it sits beside in a
// unit card, and a full sentence for the column header in this section.
const TIER_SHORT: Record<string, string> = {
  fix: "does it, tells you after",
  propose: "drafts it, you approve",
  human: "you decide, every time",
};

const TIER_GLOSS: Record<string, string> = {
  fix: "The fleet just does these and writes what it did to the run log. Nobody is asked first.",
  propose: "The fleet writes the change and opens it as a pull request — a proposed edit sitting in one place, waiting. It only takes effect when a person approves it.",
  human: "Never done automatically. A person decides every time, however sure the fleet is.",
};

function tiersSection(reg: Record<string, unknown>): Section {
  const id = "brain-autonomy";
  const nav = "What it may do alone";
  const heading = "What the fleet may do on its own";
  const tiers = asRecord(reg["autonomy_tiers"]);
  const keys = [...TIER_ORDER.filter((k) => k in tiers), ...Object.keys(tiers).filter((k) => !TIER_ORDER.includes(k))];

  if (keys.length === 0) {
    return {
      id,
      nav,
      heading,
      body: `<p class="empty">There is no <code>autonomy_tiers</code> list in <code>${esc(REGISTRY_FILE)}</code>. With none set, nothing is written down about what the fleet may do unsupervised.</p>`,
    };
  }

  const columns = keys
    .map((key) => {
      const items = asStringArray(tiers[key]);
      const kindFor = key === "fix" ? "ok" : key === "propose" ? "model" : key === "human" ? "human" : "";
      const short = TIER_SHORT[key];
      const gloss = TIER_GLOSS[key] ?? "This is not one of the three lists the fleet knows about, so nothing reads it.";
      const list = items.length
        ? `<ul>${items.map((i) => `<li><span class="mono">${esc(i)}</span></li>`).join("")}</ul>`
        : `<p class="empty">nothing on this list</p>`;
      return `<div class="tier">
  <div class="tierhead"><span class="bpill" data-kind="${kindFor}">${esc(key)}</span><span class="num">${items.length}</span></div>
  ${short ? `<p class="tiername">${esc(short)}</p>` : ""}
  <p class="tiergloss">${esc(gloss)}</p>
  ${list}
  <p class="tierpath"><code>autonomy_tiers.${esc(key)}</code></p>
</div>`;
    })
    .join("\n");

  return {
    id,
    nav,
    heading,
    body: `<p class="sub" style="margin-bottom:14px">Three lists decide how far the fleet can go without asking you. This is the whole governance story, and it is deliberately dull: each list is just lines of text, so you can read the entire policy in ten seconds and see any change to it in a pull request.</p>
<div class="tiers">${columns}</div>
${changeLine([
      `Open <code>${esc(REGISTRY_FILE)}</code> and scroll to <code>autonomy_tiers:</code>. Move a line from one list to another and save — that is the entire mechanism.`,
      `To change one unit only, add an <code>autonomy:</code> line inside that unit's block under <code>agents:</code>. A unit that has no such line follows <code>defaults.autonomy</code>.`,
    ])}`,
  };
}

// --- 4. loops -------------------------------------------------------------------------

const LOOP_GLOSS: Record<string, string> = {
  eval: "Re-scores the fleet against the answer key on every run, and blocks the change if the score dropped.",
  review: "Watches how often a person accepts what the fleet wrote, and how heavily they had to edit it.",
  heal: "When a run fails, reads the log and proposes the fix.",
  improve: "Rewrites a unit's instructions based on what actually happened, and opens it as a pull request rather than changing the file behind your back.",
  outcome: "Takes real outcomes — deals that happened, deals that did not — and adjusts what each signal is worth.",
  retirement: "Works out what each unit found that no other unit found — that is what marginal_contribution means — and names the ones not earning their keep.",
};

// The interesting keys are the numeric ones: a number in a loop is a dial somebody can
// turn. Detecting them by type rather than by name means a new dial shows up here the
// day it is added to the registry, without this file changing.
function loopsSection(reg: Record<string, unknown>): Section {
  const id = "brain-loops";
  const nav = "Automatic habits";
  const heading = "What the fleet does to itself, automatically";
  const loops = asRecord(reg["loops"]);
  const names = Object.keys(loops);

  if (names.length === 0) {
    return {
      id,
      nav,
      heading,
      body: `<p class="empty">There is no <code>loops:</code> list in <code>${esc(REGISTRY_FILE)}</code>, so the fleet does nothing on its own between runs.</p>`,
    };
  }

  const rows = names
    .map((name) => {
      const loop = asRecord(loops[name]);
      const trigger = asString(loop["trigger"]) ?? "—";
      const knobs = Object.entries(loop)
        .filter(([, v]) => typeof v === "number")
        .map(
          ([k, v]) =>
            `<div class="knob"><span class="num">${String(v)}</span> <code>loops.${esc(name)}.${esc(k)}</code></div>`,
        );
      const rest = Object.entries(loop)
        .filter(([k, v]) => k !== "trigger" && typeof v !== "number")
        .map(([k, v]) => `<span class="kv"><span class="kvk">${esc(k)}</span> ${codeTag(scalar(v))}</span>`)
        .join(" ");
      const gloss = LOOP_GLOSS[name];
      return `<tr>
  <td><span class="mono">${esc(name)}</span></td>
  <td><span class="bpill">${esc(trigger)}</span></td>
  <td class="dimcell">${gloss ? esc(gloss) : "Nothing is written down about what this one does."}${rest ? `<div class="kvs">${rest}</div>` : ""}</td>
  <td>${knobs.length ? knobs.join("") : '<span class="dimcell">nothing to turn</span>'}</td>
</tr>`;
    })
    .join("");

  return {
    id,
    nav,
    heading,
    body: `<p class="sub" style="margin-bottom:14px">A loop is a habit: something happens, and the fleet reacts without being asked. Some of them have a number you can turn, and those are the ones worth knowing. A confidence gate decides how much gets held back for a person to read instead of published. A retirement threshold decides how little usefulness is too little.</p>
<table><tr><th>habit</th><th>when it runs</th><th>what it does</th><th>number you can turn</th></tr>${rows}</table>
${changeLine([
      `Open <code>${esc(REGISTRY_FILE)}</code> and find <code>loops:</code>. Each number above prints its own path — <code>loops.review.confidence_gate</code> means the <code>confidence_gate:</code> line inside the <code>review:</code> block. Raise it and more work waits for you; lower it and more gets published on its own.`,
    ])}`,
  };
}

// --- 5. ICP and scoring ---------------------------------------------------------------

function icpSection(pack: string): Section {
  const id = "brain-icp";
  const nav = "What counts as a good account";
  const heading = 'What counts as a good account';
  const file = join(pack, "icp.yaml");
  const loaded = readYamlResult(file);
  const icp = asRecord(loaded.value);
  const weights = readWeights();

  if (loaded.error !== null) {
    return {
      id,
      nav,
      heading,
      body: `<p><span class="bpill" data-kind="human">will not open</span> <span class="dimcell"><code>${esc(file)}</code> has a formatting error: ${esc(loaded.error)}</span></p>
${changeLine([`Open <code>${esc(file)}</code> at the line named above and fix the formatting. A value with a colon and a space in it needs quotes around it.`])}`,
    };
  }
  if (Object.keys(icp).length === 0 && weights === null) {
    return {
      id,
      nav,
      heading,
      body: `<p class="empty">There is no <code>${esc(file)}</code>, and no scoring numbers could be read out of <code>${esc(QUALIFY_SRC)}</code> either. Nothing here defines who is worth talking to.</p>`,
    };
  }

  const thesis = asString(icp["thesis"]);
  const grouped = asRecord(icp["signals"]);
  const listed: { name: string; group: string }[] = [];
  for (const group of Object.keys(grouped)) {
    for (const name of asStringArray(grouped[group])) listed.push({ name, group });
  }

  const scoreTable = weights === null
    ? `<p class="empty">The things worth checking are listed in <code>${esc(file)}</code>, but how much each one counts could not be read out of <code>${esc(QUALIFY_SRC)}</code> — that file is where the numbers actually live.</p>
<ul>${listed.map((s) => `<li><span class="mono">${esc(s.name)}</span> <span class="dimcell">${esc(s.group)}</span></li>`).join("")}</ul>`
    : weightTable(listed, weights, file);

  const segments = asRecord(icp["segments"]);
  const segRows = Object.keys(segments)
    .sort()
    .map((key) => {
      const seg = asRecord(segments[key]);
      const name = asString(seg["name"]) ?? "—";
      const example = asString(seg["example"]) ?? "—";
      const tell = asString(seg["tell"]) ?? "—";
      return `<tr><td><span class="mono">${esc(key)}</span></td><td>${esc(name)}</td><td class="dimcell">${esc(tell)}</td><td class="dimcell">${esc(example)}</td></tr>`;
    })
    .join("");

  return {
    id,
    nav,
    heading,
    body: `<p class="sub">Every company the fleet finds gets a score between 0 and 1. The score is a weighted checklist: each line below is a fact anyone can check in public, and its weight is how much that fact counts. Nothing here is a hunch — if it cannot be checked, it is not on the list.</p>
${thesis ? `<p class="sub" style="margin-bottom:14px"><span class="thesislabel">Who we are looking for</span> ${esc(thesis)}</p>` : ""}
${scoreTable}
<h3>The four kinds of company we sort them into</h3>
<p class="sub">Qualified companies land in one of these, so the brief can lead with the right angle.</p>
${segRows ? `<table><tr><th>letter</th><th>kind</th><th>how you recognize it</th><th>example</th></tr>${segRows}</table>` : `<p class="empty">No <code>segments</code> list in <code>${esc(file)}</code>, so qualified companies arrive unsorted.</p>`}
${changeLine([
      `Open <code>${esc(file)}</code> to change which facts count and how the four kinds are described.`,
      `The numbers live in <code>${esc(QUALIFY_SRC)}</code> — look for <code>WEIGHTS</code> and <code>QUALIFY_AT</code> near the top. Changing a weight moves every score, so run <code>legwork evals</code> afterwards and expect the answer-key numbers to move with it.`,
    ])}`,
  };
}

function weightTable(
  listed: { name: string; group: string }[],
  weights: { values: Record<string, number>; threshold: number | null },
  icpFile: string,
): string {
  const entries = Object.entries(weights.values);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  const max = entries.reduce((n, [, w]) => Math.max(n, w), 0) || 1;
  const groupOf = new Map(listed.map((s) => [s.name, s.group]));

  // Two ways the files can fall out of step are worth naming: a signal the code scores that
  // the ICP file never mentions, and a signal the ICP file claims that the code never scores.
  const unlisted = entries.filter(([name]) => !groupOf.has(name)).map(([name]) => name);
  const unweighted = listed.filter((s) => !(s.name in weights.values)).map((s) => s.name);

  const rows = entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, weight]) => {
      const group = groupOf.get(name);
      return `<tr>
  <td><span class="mono">${esc(name)}</span></td>
  <td class="dimcell">${group ? esc(group) : `<span class="bpill" data-kind="warn">not in icp.yaml</span>`}</td>
  <td class="num">${weight.toFixed(2)}</td>
  <td class="barcell"><span class="wbar"><span style="width:${((weight / max) * 100).toFixed(1)}%"></span></span></td>
</tr>`;
    })
    .join("");

  const off = Math.abs(total - 1) > 0.001;
  const totalRow = `<tr class="totalrow">
  <td><strong>total</strong></td>
  <td class="dimcell">${entries.length} facts, each with a weight</td>
  <td class="num">${total.toFixed(2)}</td>
  <td>${
    off
      ? `<span class="bpill" data-kind="human">adds up to ${total.toFixed(2)}, not 1.00 — so scores are not on the scale the pass mark assumes</span>`
      : `<span class="dimcell">adds up to 1.00, as it should</span>`
  }</td>
</tr>`;

  const drift: string[] = [];
  if (unlisted.length) {
    drift.push(
      `<p class="drift"><span class="bpill" data-kind="warn">out of step</span> Scored by the code but never mentioned in <code>${esc(icpFile)}</code>: ${unlisted
        .map(codeTag)
        .join(" ")}. Somebody changed one file and not the other.</p>`,
    );
  }
  if (unweighted.length) {
    drift.push(
      `<p class="drift"><span class="bpill" data-kind="warn">out of step</span> Listed in <code>${esc(icpFile)}</code> but never actually scored: ${unweighted
        .map(codeTag)
        .join(" ")}. The file promises something the code does not do.</p>`,
    );
  }

  const threshold =
    weights.threshold === null
      ? `<p class="sub">The pass mark could not be read out of <code>${esc(QUALIFY_SRC)}</code>.</p>`
      : `<p class="sub">A company passes at <span class="num">${weights.threshold.toFixed(2)}</span> or above <span class="dimcell">(<code>QUALIFY_AT</code> in <code>${esc(QUALIFY_SRC)}</code>)</span> — and only if it has an EAS config at all. That one is a hard requirement in front of the arithmetic: no config, no pass, whatever the rest of the checklist says.</p>`;

  return `<h3>The checklist, heaviest first</h3>
<table class="weights"><tr><th>fact we check</th><th>counts toward</th><th>weight</th><th></th></tr>${rows}${totalRow}</table>
${drift.join("\n")}
${threshold}`;
}

// The weights are the eval contract, so they live next to the scoring code rather than in
// YAML. Reading them out of the source keeps this panel honest instead of restating a
// number that may have moved.
function readWeights(): { values: Record<string, number>; threshold: number | null } | null {
  const src = readText(QUALIFY_SRC);
  if (src === null) return null;
  const block = /const\s+WEIGHTS\s*:[^=]*=\s*\{([\s\S]*?)\}/.exec(src);
  if (!block || !block[1]) return null;
  const values: Record<string, number> = {};
  for (const match of block[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?[\d.]+)/g)) {
    const key = match[1];
    const num = Number(match[2]);
    if (key && Number.isFinite(num)) values[key] = num;
  }
  if (Object.keys(values).length === 0) return null;
  const at = /const\s+QUALIFY_AT\s*=\s*(-?[\d.]+)/.exec(src);
  const threshold = at && Number.isFinite(Number(at[1])) ? Number(at[1]) : null;
  return { values, threshold };
}

// --- 6. prompts -------------------------------------------------------------------------

function promptsSection(pack: string, playbook: PlaybookStep[]): Section {
  const id = "brain-prompts";
  const nav = "What the model is told";
  const heading = "What the model is told, word for word";
  const dir = join(pack, "prompts");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return { id, nav, heading, body: `<p class="empty">There is no prompt folder at <code>${esc(dir)}</code>.</p>` };
  }
  if (files.length === 0) {
    return { id, nav, heading, body: `<p class="empty">No prompt files in <code>${esc(dir)}</code>.</p>` };
  }

  const items = files
    .map((file) => {
      const path = join(dir, file);
      const body = readText(path);
      if (body === null) {
        return `<details><summary>${esc(file)} — could not be read</summary><p class="empty">Something is wrong with <code>${esc(path)}</code>.</p></details>`;
      }
      // Same scheme brief.ts stamps into every run as `prompt_version`: sha256 of the file
      // bytes, first 8 hex. The fingerprint below is the one that lands in the run log.
      const version = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 8);
      const bytes = sizeOf(path);
      return `<details>
  <summary>${esc(file)} <span class="num">${esc(version)}</span> <span class="dimcell">${bytes === null ? "" : `${bytes} bytes · `}${countLines(body)} lines</span></summary>
  <pre class="promptsrc">${esc(body)}</pre>
</details>`;
    })
    .join("\n");

  return {
    id,
    nav,
    heading,
    body: `<p class="sub">The instructions the model is given are not buried in code. Each one is a plain text file you can open, read, and edit like a document. Open any of them below to see exactly what the fleet is asking for.</p>
<p class="sub" style="margin-bottom:14px">The eight characters beside each file are a fingerprint of its contents — change one word and the fingerprint changes. Every brief records the fingerprint of the file that wrote it, so a brief you read next month can be traced back to the exact instructions behind it.</p>
${items}
${changeLine(
      [
        `Open the file in <code>${esc(dir)}</code> and edit the words. Or let the fleet draft the edit for you: <code>legwork improve &lt;unit&gt;</code> writes its suggestion as a pull request instead of changing your file directly.`,
        `The fingerprint updates itself the moment the file changes; there is nothing else to keep in sync.`,
      ],
      playbook,
      [4],
    )}`,
  };
}

// --- 7. golden set ----------------------------------------------------------------------

const BOOTSTRAP_LABELERS = new Set(["bootstrap", "seed", "auto", ""]);

function goldenSection(pack: string, playbook: PlaybookStep[]): Section {
  const id = "brain-golden";
  const nav = "The answer key";
  const heading = "The answer key";
  const file = join(pack, "golden-set.jsonl");
  const text = readText(file);
  if (text === null) {
    return {
      id,
      nav,
      heading,
      body: `<p class="empty">There is no answer key at <code>${esc(file)}</code>. With nothing to check against, every change passes — including the ones that make the fleet worse.</p>`,
    };
  }

  const rows: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }

  if (rows.length === 0) {
    return {
      id,
      nav,
      heading,
      body: `<p class="empty"><code>${esc(file)}</code> has no usable rows in it${
        malformed ? ` (${malformed} line${malformed === 1 ? "" : "s"} could not be read)` : ""
      }, so there is nothing to check changes against.</p>`,
    };
  }

  const verdicts = tally(rows.map((r) => asString(r["verdict"]) ?? "(none)"));
  const labelers = tally(rows.map((r) => asString(r["labeled_by"]) ?? "(none)"));
  const human = rows.filter((r) => {
    const by = (asString(r["labeled_by"]) ?? "").toLowerCase();
    return by !== "" && !BOOTSTRAP_LABELERS.has(by);
  }).length;

  const verdictRows = verdicts
    .map(
      ([verdict, n]) =>
        `<tr><td><span class="mono">${esc(verdict)}</span></td><td class="num">${n}</td><td class="barcell"><span class="wbar"><span style="width:${(
          (n / rows.length) *
          100
        ).toFixed(1)}%"></span></span></td><td class="num">${Math.round((n / rows.length) * 100)}%</td></tr>`,
    )
    .join("");

  const labelerRows = labelers
    .map(([who, n]) => {
      const isHuman = who !== "(none)" && !BOOTSTRAP_LABELERS.has(who.toLowerCase());
      return `<tr><td><span class="mono">${esc(who)}</span></td><td>${
        isHuman ? `<span class="bpill" data-kind="ok">a person</span>` : `<span class="bpill">unchecked</span>`
      }</td><td class="num">${n}</td></tr>`;
    })
    .join("");

  return {
    id,
    nav,
    heading,
    body: `<p class="sub">An answer key is exactly what it sounds like: companies a person looked at by hand and marked right or wrong. Every change to the fleet is re-scored against these rows, and if the score drops the change is blocked.</p>
<p class="sub" style="margin-bottom:14px">A row the fleet labeled itself is not an answer. It is a starting guess, and it counts as unchecked until a person confirms it — which is why the second and third numbers below are worth watching.</p>
<div class="kpis">
  <div class="kpi"><div class="v">${rows.length}</div><div class="k">rows in the answer key</div></div>
  <div class="kpi"><div class="v">${human}</div><div class="k">checked by a person</div></div>
  <div class="kpi"><div class="v">${rows.length - human}</div><div class="k">still unchecked</div></div>
  <div class="kpi"><div class="v">${verdicts.length}</div><div class="k">different verdicts used</div></div>
</div>
<details>
  <summary>Open the breakdown — how the verdicts split, and who checked each row</summary>
  <h3>How the verdicts split</h3>
  <table><tr><th>verdict</th><th>rows</th><th></th><th>share</th></tr>${verdictRows}</table>
  <h3>Who checked them</h3>
  <table><tr><th>labeled_by</th><th></th><th>rows</th></tr>${labelerRows}</table>
</details>
${
      malformed
        ? `<p class="drift"><span class="bpill" data-kind="warn">${malformed} line${
            malformed === 1 ? "" : "s"
          } could not be read</span> and ${malformed === 1 ? "was" : "were"} skipped in <code>${esc(file)}</code>.</p>`
        : ""
    }
${changeLine(
      [
        `Open <code>${esc(file)}</code> and add a line at the bottom — one company per line, with your own name after <code>labeled_by</code>. Copy the line above it and change the values.`,
        `Then run <code>legwork evals</code>. Green means ship it. Red means read what the score says before changing anything else.`,
      ],
      playbook,
      [4],
    )}`,
  };
}

// --- shared bits ------------------------------------------------------------------------

interface PlaybookStep {
  n: number;
  text: string;
}

function readPlaybook(): PlaybookStep[] {
  const text = readText(PLAYBOOK_FILE);
  if (text === null) return [];
  const steps: PlaybookStep[] = [];
  for (const match of text.matchAll(/^(\d+)\.\s+(.+)$/gm)) {
    const n = Number(match[1]);
    const body = (match[2] ?? "").trim();
    if (Number.isFinite(n) && body) steps.push({ n, text: body });
  }
  return steps;
}

// The quiet line every section ends on: not a description, an instruction. Config is the
// control surface, so each one names the file and what to look for inside it; where the
// PLAYBOOK already covers the move, it names the step too and quotes its first clause so
// the reader knows which step without opening the file.
function changeLine(parts: string[], playbook: PlaybookStep[] = [], steps: number[] = []): string {
  const hits = steps
    .map((n) => playbook.find((s) => s.n === n))
    .filter((s): s is PlaybookStep => s !== undefined);
  let play = "";
  if (hits.length === 1 && hits[0]) {
    play = ` <span class="playref">PLAYBOOK step ${hits[0].n} — ${esc(firstClause(hits[0].text))}.</span>`;
  } else if (hits.length > 1) {
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (first && last) {
      play = ` <span class="playref">PLAYBOOK steps ${first.n}–${last.n}, starting at "${esc(firstClause(first.text))}".</span>`;
    }
  }
  return `<p class="changeline"><span class="changelabel">to change this</span> ${parts.join(" ")}${play}</p>`;
}

// A sentence ends at a period followed by whitespace; a period inside `registry.yaml` or
// `CLAUDE.md` does not, and cutting there would quote the step wrong.
function firstClause(s: string): string {
  const plain = s.replace(/`/g, "").trim();
  const cut = plain.search(/[.;](\s|$)/);
  const clause = (cut === -1 ? plain : plain.slice(0, cut)).trim();
  return clause.length > 90 ? `${clause.slice(0, 89)}…` : clause;
}

interface Inherited<T> {
  value: T | null;
  inherited: boolean;
}

function inherit<T>(own: T | null, fallback: T | null): Inherited<T> {
  if (own !== null) return { value: own, inherited: false };
  return { value: fallback, inherited: true };
}

function valueWithOrigin<T>(v: Inherited<T>, render: (value: T) => string): string {
  if (v.value === null) return `<span class="empty">not set here, and no default to fall back on</span>`;
  return `${render(v.value)}${v.inherited ? ` <span class="inh">from the defaults block</span>` : ` <span class="inh">set on this unit</span>`}`;
}

function autonomyPill(v: Inherited<string>): string {
  if (v.value === null) return `<span class="empty">not set</span>`;
  const kind = v.value === "fix" ? "ok" : v.value === "propose" ? "model" : v.value === "human" ? "human" : "";
  const short = TIER_SHORT[v.value];
  return `<span class="bpill" data-kind="${kind}">${esc(v.value)}</span>${short ? ` <span class="dimcell">${esc(short)}</span>` : ""}${
    v.inherited ? ` <span class="inh">from the defaults block</span>` : ` <span class="inh">set on this unit</span>`
  }`;
}

function row(label: string, value: string): string {
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

function codeTag(s: string): string {
  return `<code>${esc(s)}</code>`;
}

function scalar(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function countLines(s: string): number {
  return s.split("\n").length;
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

interface YamlResult {
  value: unknown;
  missing: boolean;
  error: string | null;
}

// A missing file and a file that will not parse are different problems with different
// fixes, so they never collapse into the same message.
function readYamlResult(path: string): YamlResult {
  const text = readText(path);
  if (text === null) return { value: null, missing: true, error: null };
  try {
    return { value: yaml.load(text) ?? null, missing: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: null, missing: false, error: message.split("\n")[0] ?? message };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// --- styles ---------------------------------------------------------------------------

// Appended to the shell's extraCss slot by the caller. Same tokens as everything else:
// no new colors, no new fonts, no decoration that is not carrying information. The 900px
// breakpoint is the shell's own, so the contents list collapses at the same width the
// two-column brief layout does.
export const brainStyles: string = `  .sysfold > summary { list-style:none; padding:0; }
  .sysfold > summary::-webkit-details-marker { display:none; }
  .sysfold > summary h2 { display:inline-flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:0; }
  .sysfold > summary h2::after { content:"+"; color:var(--faint); font-weight:400; font-size:18px; }
  .sysfold[open] > summary h2::after { content:"\\2212"; }
  .sysfold[open] > summary { margin-bottom:14px; }
  .dials { display:flex; flex-direction:column; gap:14px; max-width:640px; }
  .dial { display:flex; align-items:center; gap:12px; font-size:14.5px; flex-wrap:wrap; }
  .dial input { width:90px; background:var(--bg); border:1px solid var(--line-strong); border-radius:10px; padding:8px 10px; font:inherit; color:var(--text); }
  .editwrap { margin-top:10px; }
  .brainedit textarea { width:100%; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:12px 14px; font:12.5px/1.6 var(--mono); color:var(--text); margin:10px 0; }
  .gd-wrap { overflow-x:auto; }
  .guide { padding-left:0; list-style:none; counter-reset:beat; display:flex; flex-direction:column; gap:22px; margin:6px 0 10px; }
  .guide > li { counter-increment:beat; display:grid; grid-template-columns:34px minmax(0,1fr); gap:0 14px; }
  .guide > li::before { content:counter(beat); font-size:22px; font-weight:600; letter-spacing:-.02em; color:var(--dim); line-height:1.2; grid-row:1 / span 3; }
  .guide .g-say { font-size:16.5px; line-height:1.65; max-width:66ch; }
  .guide .g-row { display:flex; gap:12px; font-size:14px; color:var(--dim); margin-top:6px; line-height:1.55; }
  .guide .g-k { flex-shrink:0; width:62px; font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); padding-top:2px; }
  .guide .g-row code { font-size:12px; }
  .guide .linkish { font-size:14px; color:var(--accent); }
`+ `  .brainwrap { display:grid; grid-template-columns:186px minmax(0,1fr); gap:34px; align-items:start; }
  .brainbody { min-width:0; }
  .brainbody > .brainsec:first-child { margin-top:0; }
  .braintoc { position:sticky; top:20px; }
  .braintoc .toctitle { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:var(--faint); font-weight:600; margin-bottom:10px; }
  .braintoc ul { list-style:none; padding:0; margin:0; font-size:13px; border-left:1px solid var(--line); }
  .braintoc li { margin:0; }
  .braintoc a { display:block; padding:7px 0 7px 13px; margin-left:-1px; border-left:2px solid transparent; color:var(--dim); line-height:1.35; }
  .braintoc a:hover { color:var(--text); text-decoration:none; }
  .braintoc a[aria-current="true"] { color:var(--accent); border-left-color:var(--accent); }
  .brainclose { margin-top:6px; }
  @media (max-width: 900px) {
    .brainwrap { grid-template-columns:1fr; gap:20px; }
    .braintoc { position:static; border-bottom:1px solid var(--line); padding-bottom:12px; }
    .braintoc ul { display:flex; flex-wrap:wrap; gap:6px; border-left:0; }
    .braintoc a { padding:4px 11px; margin-left:0; border:1px solid var(--line); border-radius:999px; }
    .braintoc a[aria-current="true"] { border-color:var(--accent); background:var(--accent-soft); }
  }
  .runorder th:first-child, .runorder td:first-child { width:44px; text-align:left; color:var(--faint); }
  .runorder td:last-child { white-space:normal; }
  .unitdetails { margin:14px 0 0; }
  .unitdetails > summary { color:var(--accent); }
  .units { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:14px; margin-top:12px; }
  .units .card { margin-bottom:0; padding:18px 20px; }
  .unit header { gap:10px; padding-bottom:10px; margin-bottom:12px; }
  .unit h2 { font-size:15px; }
  .unit .step { font-family:var(--mono); font-size:11px; color:var(--faint); margin-right:8px; }
  .unit .does { font-size:14px; color:var(--text); margin-bottom:10px; }
  .unit table { font-size:13px; }
  .unit th { width:34%; white-space:nowrap; }
  .unit .kindwhy { color:var(--faint); font-size:12px; margin-top:10px; }
  .unit td .inh { display:block; }
  .hyp { font-size:13px; color:var(--text); margin-top:10px; }
  .hyplabel { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); font-weight:600; }
  .thesislabel { text-transform:uppercase; letter-spacing:.08em; font-size:11px; color:var(--faint); font-weight:600; margin-right:6px; }
  .mono { font-family:var(--mono); font-size:12.5px; }
  .inh { color:var(--faint); font-size:11.5px; }
  .bpill { display:inline-block; font-size:11.5px; padding:2px 9px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; white-space:nowrap; }
  .bpill[data-kind="ok"] { color:var(--ok); border-color:var(--ok); background:var(--ok-bg); }
  .bpill[data-kind="model"] { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
  .bpill[data-kind="human"] { color:var(--no); border-color:var(--no); background:var(--no-bg); white-space:normal; }
  .bpill[data-kind="warn"] { color:var(--warn); border-color:var(--warn); background:var(--warn-bg); white-space:normal; }
  .tiers { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }
  .tier { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .tierhead { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .tierhead .num { margin-left:auto; color:var(--faint); }
  .tiername { font-size:14px; font-weight:600; color:var(--text); margin-bottom:4px; }
  .tiergloss { font-size:13.5px; color:var(--dim); margin-bottom:10px; }
  .tier ul { padding-left:16px; font-size:13px; }
  .tierpath { margin-top:10px; font-size:11.5px; color:var(--faint); }
  .kvs { margin-top:6px; display:flex; flex-wrap:wrap; gap:10px; }
  .kv { font-size:12.5px; }
  .kvk { color:var(--faint); }
  .knob { margin:2px 0; font-size:12px; }
  .knob .num { display:inline-block; min-width:44px; text-align:left; color:var(--text); }
  .barcell { width:34%; }
  .wbar { display:block; height:8px; background:var(--bg-2); border:1px solid var(--line); border-radius:999px; overflow:hidden; }
  .wbar > span { display:block; height:100%; background:var(--accent); }
  .weights .totalrow td { border-top:1px solid var(--line-strong); }
  .drift { font-size:13px; color:var(--dim); margin-top:10px; }
  .promptsrc { background:var(--bg-2); border:1px solid var(--line); border-radius:8px; padding:12px 14px; font:12.5px/1.65 var(--mono); color:var(--text); white-space:pre-wrap; word-break:break-word; overflow-x:auto; margin:4px 0 12px; }
  .changeline { color:var(--dim); font-size:12.5px; margin-top:14px; border-top:1px solid var(--line); padding-top:10px; }
  .changelabel { text-transform:uppercase; letter-spacing:.08em; font-size:11px; color:var(--faint); font-weight:600; margin-right:6px; }
  .playref { color:var(--faint); }
`;
