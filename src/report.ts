// The fleet console: one static page generated from the files the fleet already keeps —
// run log, accounts, briefs, memos, eval baseline. Nothing here is live state; it is a
// window onto the files, regenerated on demand (`legwork report`) or by CI on every run.
//
// Why static: the operator surface is the terminal and the record of truth is git.
// A page that reads those and stages decisions (review cards → one CLI command) gives
// non-terminal humans the comfortable view without creating a second control plane.
//
// The same renderer has a served mode (`legwork serve`), which keeps the page and adds
// the buttons that call the local server. Static stays the Pages artifact and the fallback:
// no fetch, nothing that needs a process running — every place a served button sits, the
// static page shows the command instead.
//
// The overview is written for the person who has to act, not the person who built it:
// one sentence on where things stand, four numbers, three verbs, and health as sentences
// with one action each. The tables are still here, one click down, for the operator.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./registry.js";
import { readRuns } from "./runlog.js";
import { loadAccounts } from "./store.js";
import { readReviews } from "./review.js";
import { brainStyles, renderBrain } from "./brain.js";
import { listTriggers, renderTriggers, triggerStyles, type Trigger } from "./triggers.js";
import { countWord, keptRatio, signalWords } from "./briefview.js";
import {
  esc,
  mdToHtml,
  queueHeadline,
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

// The seven panel bodies, on their own, so `/api/state` can swap them in place without a
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
    overview: overviewPanel({ served, agents: Object.keys(registry.agents), runs, accounts, reviews, queued }),
    queue: `
  <p class="lead">Waiting for a person. Read it, then decide; the scoring and the full brief are one click down on each card.${served ? "" : " Decisions are staged here; the command bar records them."}</p>
  ${renderQueueCards(queued, { served })}
${served ? "" : `  ${stageBar()}\n`}`,
    briefs: `
  <p class="lead">Every account the fleet has touched, where it got to, and why. Companies first, by score; briefs open in place.</p>
  ${accountsSection(accounts)}
`,
    evals: `
  <p class="lead">The answer key, re-scored on every change. A drop below the baseline fails the build. This is regression, not live accuracy.</p>
  ${evalsSection(registry.pack)}
`,
    memos: `
  <p class="lead">Units judged on their own run history: what it cost, what only it produced, how far that traveled, and the verdict.</p>
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

// The whole page. `served: false` (the default) is the Pages artifact; `served: true` adds
// the operator affordances.
export function renderConsole(opts: { served?: boolean; requestToken?: string } = {}): string {
  const served = opts.served === true;
  const runs = readRuns();
  const accounts = loadAccounts();
  const queued = accounts.filter((a) => a.review?.status === "queued");
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

  const published = accounts.filter((a) => a.stage === "briefed" && (!a.review || a.review.status === "approved")).length;
  const memoCount = existsSync("memos") ? readdirSync("memos").filter((f) => f.endsWith(".md")).length : 0;
  const panels = renderPanels({ served });
  const mode = accounts.find((a) => a.mode)?.mode ?? (accounts.length ? "unknown" : "empty");
  const badge = mode === "live" ? `<span class="modebadge" data-mode="live" title="accounts in data/ came from live sources">LIVE</span>` : mode === "fixture" ? `<span class="modebadge" data-mode="fixture" title="accounts in data/ are authored samples; receipts may not resolve">SAMPLE DATA</span>` : "";
  const body = `<div class="top"><a class="brand" href="#overview" data-tab-go="overview">legwork</a>${badge}<span class="spacer"></span><button class="theme" id="theme">dark mode</button></div>
<nav class="tabs" aria-label="sections">
  <button data-tab="overview">Home</button>
  <button data-tab="queue">Review<span class="count">${queued.length}</span></button>
  <button data-tab="briefs">Accounts<span class="count">${accounts.filter((a) => a.kind === "org").length}</span></button>
  <button data-tab="evals">Evals</button>
  <button data-tab="memos">Memos<span class="count">${memoCount}</span></button>
  <button data-tab="runs">Runs<span class="count">${runs.length}</span></button>
  <button data-tab="brain">How it runs</button>
</nav>
<div class="panel" id="overview">${panels.overview}</div>

<div class="panel" id="queue">${panels.queue}</div>

<div class="panel" id="briefs">${panels.briefs}</div>

<div class="panel" id="evals">${panels.evals}</div>

<div class="panel" id="memos">${panels.memos}</div>

<div class="panel" id="runs">${panels.runs}</div>

<div class="panel" id="brain">${panels.brain}</div>

<footer class="page">legwork · generated ${generatedAt} from the fleet's own files · ${
    served ? `actions on this page run here, on your machine · <button class="linkish" id="op-refresh">re-read the files</button>` : "the terminal acts; this page shows"
  } · <a href="https://github.com/ravenintheforrest/legwork">repo</a></footer>`;

  const tokenBootstrap = `window.__LEGWORK_TOKEN__=${JSON.stringify(opts.requestToken ?? "")};\n`;
  return served
    ? shell("legwork fleet console", body, tokenBootstrap + servedScript("/api/state?v=2"), servedStyles() + brainStyles + triggerStyles)
    : shell("legwork fleet console", body, stageScript(), brainStyles + triggerStyles);
}

// v2 survives as an artifact beside the current console until nobody misses it.
export function writeConsole(): string {
  mkdirSync(SITE_DIR, { recursive: true });
  const file = join(SITE_DIR, "v2.html");
  writeFileSync(file, renderConsole({ served: false }));
  return file;
}

// --- overview ----------------------------------------------------------------------

interface OverviewInput {
  served: boolean;
  agents: string[];
  runs: RunRecord[];
  accounts: Account[];
  reviews: { decision: string; confidence: number }[];
  queued: Account[];
}

function overviewPanel(input: OverviewInput): string {
  const { served, agents, runs, accounts, reviews, queued } = input;
  let triggers: Trigger[] = [];
  try {
    triggers = listTriggers();
  } catch {
    triggers = []; // renderTriggers() below reports the failure in its own words
  }

  const briefed = accounts.filter((a) => a.stage === "briefed").length;
  const companies = accounts.filter((a) => a.kind === "org").length;
  const people = accounts.filter((a) => a.kind === "user").length;
  const unmatched = accounts.filter((a) => !a.kind).length;
  const totalCost = runs.reduce((n, r) => n + r.cost_usd, 0);
  const approved = reviews.filter((r) => r.decision === "approved").length;

  // The two verbs under the headline: review what is waiting, or go find more. Static
  // pages cannot run anything, so the second verb is the command to type.
  const reviewBtn = queued.length > 0 ? `<button class="pill primary" data-tab-go="queue">Review ${queued.length === 1 ? "it" : "them"}</button>` : "";
  const lookBtn = served
    ? `<button class="pill${queued.length > 0 ? "" : " primary"}" data-run="live" data-since="90">Look for more</button>`
    : `<span class="how">To look for more, run <code>legwork run --since 90d</code> in the repo.</span>`;

  const liveEta = etaSentence(triggers.find((t) => t.id === "cli-run")?.eta ?? "minutes");
  const start = served
    ? `<button class="startcard" data-run="live" data-since="90"><span class="t">Look for companies</span><span class="d">Searches the web for real ones. ${esc(liveEta)}</span></button>
    <button class="startcard" data-run="fixture"><span class="t">Replay the sample</span><span class="d">Same steps on saved examples. Instant, and never fails.</span></button>
    <button class="startcard" id="op-evals"><span class="t">Check it still works</span><span class="d">Re-scores everything against the answer key.</span></button>`
    : `<div class="startcard"><span class="t">Look for companies</span><span class="d">Searches the web for real ones. ${esc(liveEta)}</span><code>legwork run --since 90d</code></div>
    <div class="startcard"><span class="t">Replay the sample</span><span class="d">Same steps on saved examples. Instant, and never fails.</span><code>legwork demo</code></div>
    <div class="startcard"><span class="t">Check it still works</span><span class="d">Re-scores everything against the answer key.</span><code>legwork evals</code></div>`;

  const ci = triggers.filter((t) => t.kind === "ci").length;
  const scheduled = triggers.filter((t) => t.kind === "scheduled").length;
  const onItsOwn =
    ci + scheduled > 0
      ? `It also starts on its own: ${plural(ci, "trigger")} from CI and ${plural(scheduled, "schedule")}.`
      : "Nothing starts it on its own; every run is one of these.";

  return `
  <section class="hero">
    <h1 class="headline">${queueHeadline(queued.length)}</h1>
    <div class="actions">${reviewBtn}${lookBtn}</div>
  </section>

  <div class="statrow">
    <div class="stat"><div class="v">${companies}</div><div class="k">companies found</div></div>
    <div class="stat"><div class="v">${briefed}</div><div class="k">briefs written</div></div>
    <div class="stat"><div class="v">${esc(keptRatio(approved, reviews.length))}</div><div class="k">${reviews.length ? "you kept" : "decisions so far"}</div></div>
    <div class="stat"><div class="v">$${totalCost.toFixed(2)}</div><div class="k">spent, all time</div></div>
  </div>
  ${funnelBlock(accounts)}

  <section class="block" id="start">
    <h2>Start a search</h2>
    <div class="startgrid">
    ${start}
    </div>${
      served
        ? `
    <div class="oprow"><span class="chip" id="op-status" data-state="idle">idle</span></div>
    <pre class="logpane" id="op-log" data-empty="1"></pre>`
        : ""
    }
    <p class="alsoline">${onItsOwn} <a href="#overview" data-open-details="triggers-detail">See all the ways it starts</a></p>
    <details class="detail-block" id="triggers-detail"><summary>All the ways it starts</summary>
    ${renderTriggers({ served })}
    </details>
  </section>

  <section class="block" id="fleet">
    <h2>How it's holding up</h2>
    <div class="health">
    ${healthRows(agents, runs, triggers, served)}
    </div>
    <details class="detail-block" id="fleet-detail"><summary>Every step, in detail</summary>
    ${fleetTable(agents, runs, served)}
    </details>${served ? `\n    <div id="retire-out"></div>` : ""}
  </section>
`;
}

// Where the leads went, as rows a person can read, so "5 briefs" is never puzzled out of
// "85 leads". The same counts as the funnel, with the reason for each drop and the companies
// closest to the bar — because those are the next briefs, and what they lack is what the
// fleet should go find.
export function funnelBlock(accounts: Account[]): string {
  if (accounts.length === 0) return "";
  const people = accounts.filter((a) => a.kind === "user");
  const unmatched = accounts.filter((a) => !a.kind);
  const companies = accounts.filter((a) => a.kind === "org");
  const scored = companies.filter((a) => a.qualification);
  const prodOf = (a: Account) => a.qualification?.signals.find((s) => s.name === "production_evidence")?.value ?? 0;
  const noProd = scored.filter((a) => prodOf(a) === 0);
  const briefed = companies.filter((a) => a.stage === "briefed");
  const held = scored.filter((a) => prodOf(a) === 1 && a.stage !== "briefed").sort((x, y) => (y.qualification!.score) - (x.qualification!.score));
  const queued = briefed.filter((a) => a.review?.status === "queued").length;
  const threshold = scored[0]?.qualification?.threshold;
  const bySource = (list: Account[]) => {
    const m = new Map<string, number>();
    for (const a of list) {
      const s = sourceLabel(a);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${v} ${k}`).join(", ");
  };
  const names = (list: Account[], n: number) => list.slice(0, n).map((a) => esc(a.company ?? a.org)).join(", ") + (list.length > n ? `, +${list.length - n}` : "");

  const rows: string[] = [];
  if (people.length) rows.push(row("none", `<strong>${people.length}</strong> ${people.length === 1 ? "was an individual" : "were individuals"}, not companies — a person's side project never becomes an account (${esc(bySource(people))})`));
  if (unmatched.length) rows.push(row("none", `<strong>${unmatched.length}</strong> never resolved to a company — no GitHub org, domain, or homepage we could match (${esc(bySource(unmatched))})`));
  if (noProd.length) rows.push(row("none", `<strong>${noProd.length}</strong> ${noProd.length === 1 ? "company" : "companies"} with no production evidence — found, but no proof they build on Expo (${names(noProd, 4)})`));
  if (held.length) rows.push(row("warn", `<strong>${held.length}</strong> ${held.length === 1 ? "company has" : "companies have"} the evidence but score${held.length === 1 ? "s" : ""} under ${threshold !== undefined ? threshold.toFixed(2) : "the bar"} — real leads, thin on store or team signals`, `<button class="act" data-open-details="closest-detail">Closest to the bar</button>`));
  rows.push(row(briefed.length ? "ok" : "none", `<strong>${briefed.length}</strong> brief${briefed.length === 1 ? "" : "s"}${briefed.length ? ` — ${queued} waiting for you, ${briefed.length - queued} published` : ""}`, briefed.length ? `<button class="act" data-tab-go="queue">Review</button>` : ""));

  const closest = held.slice(0, 8).map((a) => {
    const missing = (a.qualification!.signals.filter((s) => s.value === 0 && s.name !== "production_evidence" && s.name !== "regulated_industry").map((s) => signalWords(s.name)));
    return `<tr><td>${esc(a.company ?? a.org)}</td><td class="dimcell">${esc(sourceLabel(a))}</td><td class="num">${a.qualification!.score.toFixed(2)}</td><td class="dimcell">${esc(missing.slice(0, 3).join(" · ") || "—")}</td></tr>`;
  }).join("");

  return `<section class="block" id="funnel">
    <h2>Where the ${accounts.length} leads went</h2>
    <p class="sub" style="margin-bottom:14px">A lead is any public trace a source turned up. It becomes a company when it resolves to an org, a domain, or a homepage; a brief when there is production evidence and enough signal to be worth an AE's two minutes.</p>
    <div class="health">
    ${rows.join("\n    ")}
    </div>${held.length ? `
    <details class="detail-block" id="closest-detail"><summary>Closest to the bar — what they still lack</summary>
    <table><tr><th>company</th><th>found by</th><th>score</th><th>not found yet</th></tr>${closest}</table>
    <p class="sub" style="margin-top:10px">"Not found" is not "no": these are the signals the public web did not show, which is also the list of what the next source should go get.</p>
    </details>` : ""}
  </section>`;
}

export function sourceLabel(a: Account): string {
  const names = new Set<string>();
  for (const e of a.evidence) {
    if (e.agent === "discover") names.add("code search");
    else if (e.agent === "discover-jobs") names.add("job boards");
    else if (e.agent === "discover-issues") names.add("Expo issues");
    else if (e.agent === "discover-gitlab") names.add("GitLab");
  }
  return [...names].join(" + ") || "—";
}

// "4m 12s last time" → "Took 4m 12s last time."; "minutes" → "Takes minutes."
function etaSentence(eta: string): string {
  return /last time$/.test(eta) ? `Took ${eta}.` : `Takes ${eta}.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Health as sentences a person can act on, one action each. The conditions are the ones
// the fleet already tracks — last outcome per unit, units that never produce, schedules
// declared in config that nothing runs — read off the same files as the tables below.
export function healthRows(agents: string[], runs: RunRecord[], triggers: Trigger[], served: boolean): string {
  const rows: string[] = [];
  const names = [...new Set([...agents, ...runs.map((r) => r.agent)])];

  if (runs.length === 0) {
    rows.push(row("none", "No runs yet — start one above and this fills in."));
  } else {
    const failed = names.filter((name) => {
      const mine = runs.filter((r) => r.agent === name);
      return mine.length > 0 && mine[mine.length - 1]!.outcome !== "ok";
    });
    if (failed.length === 0) rows.push(row("ok", "Every step finished cleanly on the last run"));
    else {
      // Say when it failed: "improve, 2 days ago" is history to read, not a fire to fight.
      const named = failed.map((f) => {
        const mine = runs.filter((r) => r.agent === f);
        const at = mine[mine.length - 1]!;
        return `<strong>${esc(f)}</strong> (${esc(ago(at.started, at.duration_ms))})`;
      });
      rows.push(
        row(
          "warn",
          `${countWord(failed.length)} step${failed.length === 1 ? "" : "s"}, ${named.join(", ")}, did not finish ${failed.length === 1 ? "its" : "their"} last run`,
          `<button class="act" data-tab-go="runs">See the run log</button>`,
        ),
      );
    }

    const last = runs[runs.length - 1]!;
    rows.push(row("ok", `Last run finished ${esc(ago(last.started, last.duration_ms))}${last.mode ? ` · ${esc(last.mode)}` : ""}`));
  }

  // A unit that has run enough times to judge and has never produced a record is the
  // retirement case writing itself; `legwork retire` writes it down.
  for (const name of names) {
    const mine = runs.filter((r) => r.agent === name);
    if (mine.length < 5 || mine.some((r) => r.outputs > 0)) continue;
    const memo = join("memos", `retire-${name}.md`);
    const act = served
      ? `<button class="act" data-retire="${esc(name)}">Read the case to drop it</button>`
      : existsSync(memo)
        ? `<button class="act" data-tab-go="memos">Read the case to drop it</button>`
        : `<code>legwork retire ${esc(name)}</code>`;
    rows.push(row("warn", `One step, <strong>${esc(name)}</strong>, has found nothing useful in ${mine.length} runs`, act));
  }

  const declared = triggers.filter((t) => t.kind === "declared").length;
  if (declared > 0) {
    rows.push(
      row(
        "warn",
        `${countWord(declared)} schedule${declared === 1 ? " is" : "s are"} written down that nothing actually runs`,
        `<button class="act" data-open-details="triggers-detail">Which ones</button>`,
      ),
    );
  }

  return rows.join("\n    ");
}

function row(dot: "ok" | "warn" | "err" | "none", text: string, action = ""): string {
  return `<div class="row"><span class="dot ${dot}"></span><span>${text}</span>${action}</div>`;
}

function ago(startedIso: string, durationMs: number): string {
  const ended = Date.parse(startedIso) + (Number.isFinite(durationMs) ? durationMs : 0);
  if (Number.isNaN(ended)) return `at ${startedIso}`;
  const mins = Math.max(0, Math.round((Date.now() - ended) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${plural(mins, "minute")} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

// --- sections -----------------------------------------------------------------------

export function fleetTable(agents: string[], runs: RunRecord[], served: boolean): string {
  const names = [...new Set([...agents, ...runs.map((r) => r.agent)])];
  const registryAgents = safeAgents();
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
        <td class="dimcell">${esc(registryAgents[name]?.does ?? "")}</td>
        <td class="num">${mine.length}</td>
        <td class="num">${errors}</td>
        <td>${last ? esc(last.started.slice(0, 16).replace("T", " ")) : "—"}</td>
        <td>${esc(state)}</td>
        <td class="num">$${cost.toFixed(4)}</td>${served ? `\n        <td class="rowact"><button data-retire="${esc(name)}">retire</button></td>` : ""}
      </tr>`;
    })
    .join("");

  return `<table><tr><th>step</th><th>does</th><th>runs</th><th>failed</th><th>last run</th><th>last outcome</th><th>spend</th>${served ? "<th></th>" : ""}</tr>${rows}</table>
<p class="sub" style="margin-top:10px">Amber: last run ok, but it has failed before.${served ? " Retire writes the memo and opens it below; the PR is still yours to open." : ""}</p>`;
}

function safeAgents(): Record<string, { does: string }> {
  try {
    return loadRegistry().agents as Record<string, { does: string }>;
  } catch {
    return {};
  }
}

export function evalsSection(pack: string): string {
  const file = join(pack, "evals-baseline.json");
  if (!existsSync(file)) return `<section class="block" id="evals"><h2>Evals</h2><p class="empty">no baseline yet — run <code>legwork evals</code>.</p></section>`;
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  const rows = Object.entries(baseline)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.toFixed(2)}</td></tr>`)
    .join("");
  return `<section class="block" id="evals"><h2>The regression gate's baseline</h2>
<table><tr><th>metric</th><th>baseline</th></tr>${rows}</table>
</section>`;
}

function accountsSection(accounts: Account[]): string {
  if (accounts.length === 0) return `<section class="block" id="accounts"><h2>Accounts</h2><p class="empty">none yet — run a search.</p></section>`;
  const statusOf = (a: Account): { text: string; dot: "ok" | "warn" | "none" | "err" } => {
    if (a.kind === "user") return { text: "individual, excluded", dot: "none" };
    if (a.stage === "briefed") return a.review?.status === "queued" ? { text: "brief · waiting for review", dot: "warn" } : a.review?.status === "rejected" ? { text: "brief · not a fit", dot: "err" } : { text: "brief · published", dot: "ok" };
    if (!a.kind) return { text: "not resolved to a company", dot: "none" };
    if (a.qualification) return a.qualification.signals.find((s) => s.name === "production_evidence")?.value ? { text: "held · under the bar", dot: "none" } : { text: "held · no production evidence", dot: "none" };
    return { text: a.stage, dot: "none" };
  };
  const rank = (a: Account) => (a.stage === "briefed" ? 3 : a.kind === "org" ? 2 : a.kind === "user" ? 0 : 1);
  const sorted = [...accounts].sort((x, y) => rank(y) - rank(x) || (y.qualification?.score ?? 0) - (x.qualification?.score ?? 0) || (x.company ?? x.org).localeCompare(y.company ?? y.org));
  const rows = sorted.map((a) => {
    const st = statusOf(a);
    const briefFile = a.stage === "briefed" ? (a.review?.status === "queued" ? join("briefs", "queue", `${a.org}.md`) : join("briefs", `${a.org}.md`)) : null;
    const brief = briefFile && existsSync(briefFile) ? readFileSync(briefFile, "utf8") : null;
    const name = esc(a.company ?? a.org);
    return `<tr>
      <td>${brief ? `<details class="acct"><summary>${name}</summary><div class="memo">${mdToHtml(brief)}</div></details>` : name}${a.domain ? `<div class="dimcell" style="font-size:12.5px">${esc(a.domain)}</div>` : ""}</td>
      <td><span class="dot ${st.dot}"></span>${esc(st.text)}</td>
      <td class="dimcell">${esc(sourceLabel(a))}</td>
      <td class="num">${a.qualification ? a.qualification.score.toFixed(2) : "—"}</td>
      <td>${esc(a.segment ?? "—")}</td>
      <td class="dimcell">${esc((a.updated ?? "").slice(0, 10))}</td>
    </tr>`;
  }).join("");
  return `<section class="block" id="accounts"><h2>${accounts.filter((a) => a.kind === "org").length} companies · ${accounts.length} leads</h2>
<table class="accounts"><tr><th>company</th><th>where it got to</th><th>found by</th><th>score</th><th>segment</th><th>last changed</th></tr>${rows}</table>
</section>`;
}

export function memosSection(): string {
  if (!existsSync("memos")) return `<section class="block" id="memos"><h2>Retirement memos</h2><p class="empty">none yet.</p></section>`;
  const files = readdirSync("memos").filter((f) => f.endsWith(".md")).sort();
  const items = files
    .map((f) => `<div class="memo">${mdToHtml(readFileSync(join("memos", f), "utf8"))}</div>`)
    .join("\n");
  return `<section class="block" id="memos"><h2>Retirement memos</h2>${items || '<p class="empty">none yet.</p>'}</section>`;
}

export function runsSection(runs: RunRecord[]): string {
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
  return `<section class="block" id="runs"><h2>The last 25 runs</h2>
<table><tr><th>started</th><th>step</th><th>mode</th><th>outcome</th><th>in→out</th><th>time</th><th>spend</th><th>error</th></tr>${rows}</table>
</section>`;
}
