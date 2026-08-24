// What starts a run — the answer, read out of the repo instead of written down here.
//
// The fleet could already be started from the CLI, from the buttons on `legwork serve`, and
// from CI, and until this file existed none of it was listed anywhere. That is a
// discoverability bug, not a missing feature: the buttons were there, unlabelled as to what
// they reach and what they cost.
//
// So nothing below is prose about the repo. The CLI verbs and their descriptions are parsed
// out of src/cli.ts; the CI events are parsed out of every .github/workflows/*.yml with the
// same js-yaml the registry loader uses; the declared-but-unwired schedules are read out of
// registry.yaml; last-run facts are derived from data/runs.jsonl. Delete a verb or a workflow
// and its row disappears. Every file that will not read or will not parse degrades to a
// visible "unknown" naming the path it wanted — a trigger list that lies is worse than none.
//
// This file is also where the toolbar's buttons are defined, so the list and the buttons
// cannot drift apart: report.ts renders the toolbar from the same array it renders the list
// from, which is what makes the list an explanation of the buttons rather than a copy.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { PIPELINE } from "./agents/index.js";
import { readRuns } from "./runlog.js";
import { esc } from "./reviewhtml.js";
import type { RunRecord } from "./types.js";

const CLI_FILE = join("src", "cli.ts");
const REGISTRY_FILE = "registry.yaml";
const WORKFLOW_DIR = join(".github", "workflows");
const PACKAGE_FILE = "package.json";

/** manual: a person starts it. ci: GitHub starts it. scheduled: a clock starts it. declared: config says it happens; nothing runs it. */
export type TriggerKind = "manual" | "scheduled" | "ci" | "declared";

export interface TriggerLastRun {
  when: string;
  outcome: string;
  detail: string;
}

/** The console button this trigger already has, when it has one. */
export interface TriggerButton {
  attrs: string;
  label: string;
  note: string;
}

export interface Trigger {
  id: string;
  label: string;
  kind: TriggerKind;
  /** One plain sentence: what starting this actually does. */
  does: string;
  /** Exact command to type, or "button in the console". */
  invoke: string;
  /** The command in isolation, when there is one to copy. */
  command: string | null;
  /** Does starting it reach the network? */
  network: "live" | "offline" | "unknown";
  /** Plain status. For `declared`, this says outright that nothing runs it. */
  status: string;
  /** The file this row was discovered from. */
  source: string;
  /** Roughly how long it takes — measured off the run log where the log knows. */
  eta: string;
  lastRun: TriggerLastRun | null;
  /** Why there is no last run, when there is none. */
  lastRunNote: string | null;
  button: TriggerButton | null;
}

// --- public API -----------------------------------------------------------------------

export function listTriggers(): Trigger[] {
  const runs = readRunsSafely();
  const clusters = clusterRuns(runs);
  const cli = readCliVerbs();
  const workflows = readWorkflows();
  return [
    ...manualTriggers(cli, clusters),
    ...ciTriggers(workflows),
    ...declaredTriggers(runs, workflows),
  ];
}

export function renderTriggers(opts: { served?: boolean } = {}): string {
  const served = opts.served === true;
  let triggers: Trigger[];
  try {
    triggers = listTriggers();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `<section class="block" id="triggers"><h2>What starts a run</h2>
<p class="empty">Could not read the files that define this: ${esc(message)}</p></section>`;
  }

  const manual = triggers.filter((t) => t.kind === "manual").length;
  const scheduled = triggers.filter((t) => t.kind === "scheduled").length;
  const declared = triggers.filter((t) => t.kind === "declared").length;
  const buttons = triggers.filter((t) => t.button !== null).length;

  const rows = triggers.map((t) => triggerRow(t, served)).join("\n");
  const runnableHere = served
    ? `${buttons} of the manual ones are the cards under "Start a search" on the overview — same names, so the row explains the card.`
    : `This is the static copy, so there are no buttons: type the command. Run <code>legwork serve</code> and the same list gets cards you can press.`;

  return `<section class="block" id="triggers"><h2>What starts a run — ${triggers.length} ways</h2>
<p class="sub" style="margin-bottom:14px">Read out of <code>src/cli.ts</code>, <code>${esc(WORKFLOW_DIR)}/</code> and <code>${esc(REGISTRY_FILE)}</code> at render time, not written down here. ${
    manual > 0 ? `Nothing on this machine starts itself: the ${manual} manual rows are things you type or click. ` : ""
  }${
    scheduled > 0
      ? `${scheduled} run${scheduled === 1 ? "s" : ""} on GitHub's clock, not yours. `
      : `No clock anywhere runs this fleet. `
  }${runnableHere}${
    declared > 0
      ? ` The ${declared} amber row${declared === 1 ? "" : "s"} declare${declared === 1 ? "s" : ""} a cadence in config that nothing in this repo executes.`
      : ""
  }</p>
<table class="triggers"><tr><th>trigger</th><th>what starting it does</th><th>how to start it</th><th>last run</th></tr>
${rows}</table>
<p class="changeline"><span class="changelabel">to change this</span> Verbs live in <code>${esc(CLI_FILE)}</code>, CI events in <code>${esc(WORKFLOW_DIR)}/*.yml</code>, declared cadences in <code>${esc(REGISTRY_FILE)}</code>. This list is generated from those three, so a row appears or disappears with the file.${
    hasDevScript() ? ` From a fresh clone, before <code>npm link</code>, every <code>legwork x</code> below is <code>npm run dev -- x</code>.` : ""
  }</p>
</section>`;
}

// Appended to the shell's extraCss slot by report.ts. Existing tokens only — no new
// colors, no new fonts; the pills and the change line are brain.ts's, reused as-is.
export const triggerStyles: string = `  .triggers { table-layout:fixed; }
  .triggers td { padding-top:11px; padding-bottom:11px; padding-right:16px; }
  .triggers th:first-child, .triggers td:first-child { width:19%; }
  .triggers th:nth-child(2), .triggers td:nth-child(2) { width:32%; }
  .triggers th:nth-child(3), .triggers td:nth-child(3) { width:26%; }
  .triggers code { word-break:break-word; }
  .triggers .label { display:block; margin-top:6px; font-weight:500; }
  .triggers .src { display:block; font-family:var(--mono); font-size:11px; color:var(--faint); margin-top:3px; }
  .triggers .how code { display:inline-block; margin-bottom:4px; }
  .triggers .cost { display:block; font-size:11.5px; color:var(--faint); }
  .triggers .notwired { display:block; color:var(--dim); font-size:12.5px; margin-top:6px; }
  .triggers .btnref { font-weight:500; }
  .toolbar button { text-align:left; line-height:1.35; padding:8px 14px; }
  .toolbar .blabel { display:block; }
  .toolbar .bnote { display:block; font-size:11px; color:var(--faint); font-weight:400; }
`;

// --- rendering ------------------------------------------------------------------------

function triggerRow(t: Trigger, served: boolean): string {
  const kindPill =
    t.kind === "declared"
      ? `<span class="bpill" data-kind="warn">declared</span>`
      : t.kind === "manual"
        ? `<span class="bpill">manual</span>`
        : `<span class="bpill" data-kind="model">${esc(t.kind)}</span>`;

  const how =
    served && t.button
      ? `<span class="btnref">${esc(t.button.label)}</span> button, above<br><code>${esc(t.command ?? "")}</code>`
      : t.command
        ? `<code>${esc(t.command)}</code>`
        : `<span class="dimcell">${esc(t.invoke)}</span>`;

  // A declared row has no network answer because nothing runs it; saying "network unknown"
  // there would read as a defect in this page rather than a fact about the config.
  const cost =
    t.kind === "declared"
      ? esc(t.eta)
      : `${t.network === "live" ? "calls live sources" : t.network === "offline" ? "offline" : "network unknown"} · ${esc(t.eta)}`;

  const last = t.lastRun
    ? `<span class="dot ${t.lastRun.outcome === "ok" ? "ok" : "err"}"></span>${esc(t.lastRun.when)}<span class="cost">${esc(t.lastRun.outcome)} · ${esc(t.lastRun.detail)}</span>`
    : `<span class="dimcell">unknown</span><span class="cost">${esc(t.lastRunNote ?? "not derivable from data/runs.jsonl")}</span>`;

  return `<tr>
  <td class="who">${kindPill}<span class="label">${esc(t.label)}</span><span class="src">${esc(t.source)}</span></td>
  <td class="dimcell">${esc(t.does)}${
    t.kind === "declared" || t.network === "unknown"
      ? `<span class="notwired">${esc(t.status)}</span>`
      : ""
  }</td>
  <td class="how">${how}<span class="cost">${cost}</span></td>
  <td>${last}</td>
</tr>`;
}

// --- 1. the CLI verbs that start work ---------------------------------------------------

interface CliVerb {
  name: string;
  description: string;
  /** The work-starting entry point the verb's action calls, if any. */
  entry: string | null;
  /** True when the verb hardcodes fixture mode (offline by construction). */
  fixtureOnly: boolean;
}

// A verb "starts work" iff its action body calls one of these. That is the discovery rule:
// the list follows the wiring in cli.ts, not a list of verb names kept in step by hand.
const WORK_ENTRIES = ["runPipeline", "runEvals", "runSoak", "startServer"];

function readCliVerbs(): Map<string, CliVerb> {
  const found = new Map<string, CliVerb>();
  const src = readText(CLI_FILE);
  if (src === null) return found;

  // Split on the command declarations themselves: everything up to the next one is that
  // verb's chain, including its .action(...) body.
  const marks: { name: string; at: number }[] = [];
  const re = /program\s*\.command\(\s*"([a-z-]+)"\s*\)/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    marks.push({ name: m[1] as string, at: m.index });
  }
  marks.forEach((mark, i) => {
    const block = src.slice(mark.at, i + 1 < marks.length ? (marks[i + 1] as { at: number }).at : src.length);
    const desc = /\.description\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(block);
    const entry = WORK_ENTRIES.find((fn) => block.includes(`${fn}(`)) ?? null;
    found.set(mark.name, {
      name: mark.name,
      description: desc ? unescapeJs(desc[1] as string) : "",
      entry,
      fixtureOnly: /mode:\s*"fixture"/.test(block),
    });
  });
  return found;
}

// Console buttons are defined here so the toolbar and this list share one definition.
// `attrs` is the wiring servedScript() already listens for; changing it changes both.
interface ManualSpec {
  verb: string;
  label: string;
  command: string;
  network: "live" | "offline";
  mode: "fixture" | "live" | null;
  buttonAttrs: string | null;
  /** Shown when the run log has nothing to measure. Final text, not a duration. */
  fallbackEta: string;
  /** Replaces the generic status line when the generic one would be misleading. */
  statusNote: string | null;
  /** Why this verb has no distinguishable history, when it has none. */
  noHistoryNote: string | null;
}

const MANUAL: ManualSpec[] = [
  {
    verb: "demo",
    label: "Run demo",
    command: "legwork demo",
    network: "offline",
    mode: "fixture",
    buttonAttrs: 'data-run="fixture"',
    fallbackEta: "seconds",
    statusNote: null,
    noHistoryNote: null,
  },
  {
    verb: "run",
    label: "Run live (90d)",
    command: "legwork run --since 90d",
    network: "live",
    mode: "live",
    buttonAttrs: 'data-run="live" data-since="90"',
    fallbackEta: "minutes",
    statusNote: null,
    noHistoryNote: null,
  },
  {
    verb: "evals",
    label: "Re-run evals",
    command: "legwork evals",
    network: "offline",
    mode: null,
    buttonAttrs: 'id="op-evals"',
    fallbackEta: "seconds",
    statusNote:
      "Runs when you run it. It scores the fixture agents in memory — it never touches data/, so it cannot break the fleet's state.",
    noHistoryNote: "evals runs in memory and writes nothing to data/runs.jsonl",
  },
  {
    verb: "serve",
    label: "Open the operator desk",
    command: "legwork serve",
    network: "offline",
    mode: null,
    buttonAttrs: null,
    fallbackEta: "starts instantly",
    statusNote:
      "This is the surface the buttons live on. The server itself is local (127.0.0.1) and offline; whether a run reaches the network depends on which button you press.",
    noHistoryNote: "serving is not a run, so it writes nothing to data/runs.jsonl",
  },
  {
    verb: "soak",
    label: "Soak the live units",
    command: "legwork soak --since 90d",
    network: "live",
    mode: null,
    buttonAttrs: null,
    fallbackEta: "minutes",
    statusNote: null,
    noHistoryNote:
      "soak's units log as mode `live`, indistinguishable from `legwork run` — read the live row above",
  },
];

function manualTriggers(cli: Map<string, CliVerb>, clusters: RunCluster[]): Trigger[] {
  return MANUAL.map((spec) => {
    const verb = cli.get(spec.verb);
    const known = verb !== undefined && verb.entry !== null;
    const does = known && verb.description !== "" ? sentence(verb.description) : "";
    const last = spec.mode ? lastCluster(clusters, spec.mode) : null;
    // Sub-two-second spans are dominated by process startup, which the log never sees, so
    // reporting them as the duration would understate what a person actually waits.
    const eta = last && last.durationMs >= 2000 ? `${humanMs(last.durationMs)} last time` : spec.fallbackEta;

    return {
      id: `cli-${spec.verb}`,
      label: spec.label,
      kind: "manual" as const,
      does: known
        ? does
        : `Unknown — no \`${spec.verb}\` verb that starts work was found in ${CLI_FILE}.`,
      invoke: spec.buttonAttrs ? `${spec.command} — or the "${spec.label}" button in the console` : spec.command,
      command: spec.command,
      network: known ? spec.network : ("unknown" as const),
      status: known
        ? (spec.statusNote ??
          `Runs when you run it. ${spec.network === "live" ? "It reaches the network, so it needs credentials and a working connection." : "No credentials, no network."}`)
        : `${CLI_FILE} no longer wires \`${spec.verb}\` to any of ${WORK_ENTRIES.join(", ")}. Either the verb moved or this row is stale.`,
      source: CLI_FILE,
      eta,
      lastRun: last
        ? { when: last.when, outcome: last.outcome, detail: `${last.units} units · ${humanMs(last.durationMs)}` }
        : null,
      lastRunNote:
        spec.noHistoryNote ?? (spec.mode ? `no ${spec.mode} run in data/runs.jsonl yet` : `${spec.verb} writes nothing to data/runs.jsonl`),
      button: spec.buttonAttrs
        ? {
            attrs: spec.buttonAttrs,
            label: spec.label,
            note: `${spec.network === "live" ? "calls live sources" : "offline"} · ${eta}`,
          }
        : null,
    };
  });
}

// --- 2. CI ------------------------------------------------------------------------------

interface WorkflowStep {
  name: string | null;
  run: string | null;
  uses: string | null;
}

interface Workflow {
  file: string;
  name: string;
  /** event name -> raw config */
  events: [string, unknown][];
  steps: WorkflowStep[];
  /** every `run:` string in every job step */
  commands: string[];
  usesPages: boolean;
  /** does anything here commit the run log back, so CI runs could show up in it */
  writesBack: boolean;
  error: string | null;
}

function readWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOW_DIR)) return [];
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    return [];
  }
  return files.map((f) => readWorkflow(join(WORKFLOW_DIR, f)));
}

function readWorkflow(file: string): Workflow {
  const empty: Workflow = { file, name: file, events: [], steps: [], commands: [], usesPages: false, writesBack: false, error: null };
  const text = readText(file);
  if (text === null) return { ...empty, error: "could not be read" };

  let doc: unknown;
  try {
    doc = yaml.load(text) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...empty, error: (message.split("\n")[0] ?? message).trim() };
  }

  const root = asRecord(doc);
  // js-yaml 4 keeps `on:` a string key (YAML 1.2 dropped the 1.1 boolean aliases), but a
  // 1.1-era parser would hand it back under `true`. Accept both rather than show nothing.
  const onBlock = root["on"] ?? root["true"];
  const events: [string, unknown][] = Array.isArray(onBlock)
    ? onBlock.filter((e): e is string => typeof e === "string").map((e) => [e, null] as [string, unknown])
    : typeof onBlock === "string"
      ? [[onBlock, null]]
      : Object.entries(asRecord(onBlock));

  const parsed: WorkflowStep[] = [];
  let usesPages = false;
  for (const job of Object.values(asRecord(root["jobs"]))) {
    const steps = asRecord(job)["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const s = asRecord(step);
      const uses = typeof s["uses"] === "string" ? s["uses"] : null;
      if (uses !== null && uses.includes("deploy-pages")) usesPages = true;
      parsed.push({
        name: typeof s["name"] === "string" ? s["name"] : null,
        run: typeof s["run"] === "string" ? s["run"].trim() : null,
        uses,
      });
    }
  }
  const commands = parsed.map((s) => s.run).filter((r): r is string => r !== null);

  return {
    file,
    name: typeof root["name"] === "string" ? root["name"] : file,
    events,
    steps: parsed,
    commands,
    usesPages,
    // Committing something is not committing the run log. Only a step that names the log
    // could put a CI run into it, and claiming otherwise would misread every CI row.
    writesBack: commands.some((c) => /git\s+(commit|add)/.test(c) && /runs\.jsonl/.test(c)),
    error: events.length === 0 && Object.keys(root).length === 0 ? "has no readable content" : null,
  };
}

function ciTriggers(workflows: Workflow[]): Trigger[] {
  const out: Trigger[] = [];
  for (const wf of workflows) {
    if (wf.error !== null) {
      out.push(unknownWorkflowTrigger(wf));
      continue;
    }
    if (wf.events.length === 0) {
      out.push({ ...unknownWorkflowTrigger(wf), status: `No \`on:\` block found in ${wf.file}, so nothing in this repo says when it fires.` });
      continue;
    }
    const does = workflowDoes(wf);
    const network = workflowNetwork(wf);
    for (const [event, config] of wf.events) {
      if (event === "schedule") {
        out.push(...cronTriggers(wf, config, does, network));
        continue;
      }
      out.push({
        id: `ci-${slug(wf.file)}-${event}`,
        label: `${wf.name}: ${eventLabel(event, config)}`,
        kind: "ci",
        does,
        invoke: eventInvoke(event, wf),
        command: eventCommand(event),
        network,
        status: `Fires in GitHub Actions, not here.`,
        source: wf.file,
        eta: "minutes, on GitHub's runners",
        lastRun: null,
        lastRunNote: wf.writesBack
          ? "CI writes back to the run log; the last CI run may be any row in it"
          : "CI runs are not written back to data/runs.jsonl, so this log cannot show them",
        button: null,
      });
    }
  }
  return out;
}

function cronTriggers(wf: Workflow, config: unknown, does: string, network: Trigger["network"]): Trigger[] {
  const entries = Array.isArray(config) ? config : [];
  const crons = entries
    .map((e) => asRecord(e)["cron"])
    .filter((c): c is string => typeof c === "string");
  if (crons.length === 0) {
    return [
      {
        id: `ci-${slug(wf.file)}-schedule`,
        label: `${wf.name}: on a schedule`,
        kind: "scheduled",
        does,
        invoke: `GitHub Actions runs it`,
        command: null,
        network,
        status: `A \`schedule:\` block is present in ${wf.file} but no \`cron:\` value could be read from it.`,
        source: wf.file,
        eta: "unknown",
        lastRun: null,
        lastRunNote: "no cron expression to describe",
        button: null,
      },
    ];
  }
  return crons.map((cron, i) => ({
    id: `ci-${slug(wf.file)}-cron-${i}`,
    label: `${wf.name}: ${humanCron(cron)}`,
    kind: "scheduled" as const,
    does,
    invoke: `GitHub Actions runs it on \`${cron}\``,
    command: null,
    network,
    status: `Runs on GitHub's clock, not on your machine, and ${
      network === "offline" ? "against fixtures — it calls no live source." : "against live sources."
    }`,
    source: wf.file,
    eta: "minutes, on GitHub's runners",
    lastRun: null,
    lastRunNote: wf.writesBack
      ? "CI writes back to the run log; the last CI run may be any row in it"
      : "CI runs are not written back to data/runs.jsonl, so this log cannot show them",
    button: null,
  }));
}

function unknownWorkflowTrigger(wf: Workflow): Trigger {
  return {
    id: `ci-${slug(wf.file)}`,
    label: `${wf.file} — unreadable`,
    kind: "ci",
    does: "Unknown — this workflow file could not be parsed, so what it starts is not knowable from here.",
    invoke: "unknown",
    command: null,
    network: "unknown",
    status: `${wf.file} ${wf.error ?? "could not be parsed"}. Fix the file and this row will describe itself.`,
    source: wf.file,
    eta: "unknown",
    lastRun: null,
    lastRunNote: "the workflow could not be read",
    button: null,
  };
}

const DOES_CAP = 6;

// What a workflow does, in the workflow's own words: a named step is authored English and
// beats anything guessed from its shell; an unnamed step is described by the npm script it
// runs. Setup steps (checkout, node, npm ci) are not work and are dropped.
function workflowDoes(wf: Workflow): string {
  const labels: string[] = [];
  for (const step of wf.steps) {
    if (step.name !== null) {
      labels.push(lowerFirst(step.name));
      continue;
    }
    if (step.run === null) continue;
    const npm = normalizeNpm(step.run);
    if (npm !== null) labels.push(npm);
  }
  const list = [...new Set(labels)];
  if (list.length === 0) return `Runs the ${wf.name} workflow on GitHub's runners.`;
  const shown = list.slice(0, DOES_CAP).join(", ");
  const more = list.length > DOES_CAP ? ` (+${list.length - DOES_CAP} more)` : "";
  return `Runs ${shown}${more}${wf.usesPages ? ", then publishes site/ to Pages" : ""}.`;
}

// `npm run dev -- demo` is the demo; `npm ci` is setup, not work. A shell block that is not
// an npm invocation gets no label — a truncated line of bash describes nothing.
function normalizeNpm(cmd: string): string | null {
  for (const raw of cmd.split("\n")) {
    const line = raw.trim();
    if (/^npm\s+ci\b/.test(line) || /^npm\s+install\b/.test(line)) continue;
    const dev = /^npm\s+run\s+dev\s+--\s+(\S+)/.exec(line);
    if (dev) return dev[1] as string;
    const run = /^npm\s+run\s+(\S+)/.exec(line);
    if (run) return run[1] as string;
    const bare = /^npm\s+(test|start)\b/.exec(line);
    if (bare) return bare[1] as string;
  }
  return null;
}

// Offline unless some step can start a live run: `run`/`soak` without --fixture. Judged
// line by line, because one shell block often holds both branches of an if.
function workflowNetwork(wf: Workflow): Trigger["network"] {
  if (wf.commands.length === 0) return "unknown";
  const live = wf.commands
    .flatMap((c) => c.split("\n"))
    .some((line) => /(dev\s+--|legwork)\s+(run|soak)\b/.test(line) && !/--fixture\b/.test(line));
  return live ? "live" : "offline";
}

function eventLabel(event: string, config: unknown): string {
  if (event === "push") {
    const branches = asStringArray(asRecord(config)["branches"]);
    return branches.length ? `on push to ${branches.join(", ")}` : "on every push";
  }
  if (event === "pull_request") return "on every pull request";
  if (event === "workflow_dispatch") return "when a human presses Run workflow";
  return `on ${event}`;
}

function eventInvoke(event: string, wf: Workflow): string {
  if (event === "workflow_dispatch") return `GitHub → Actions → ${wf.name} → Run workflow`;
  if (event === "push") return "git push";
  if (event === "pull_request") return "open or update a pull request";
  return `the ${event} event on GitHub`;
}

function eventCommand(event: string): string | null {
  if (event === "push") return "git push";
  return null;
}

// --- 3. declared in registry.yaml, executed by nothing -----------------------------------

const CALENDAR = ["daily", "weekly", "monthly", "hourly", "nightly", "quarterly"];

function declaredTriggers(runs: RunRecord[], workflows: Workflow[]): Trigger[] {
  const text = readText(REGISTRY_FILE);
  if (text === null) {
    return [
      {
        id: "declared-missing",
        label: "registry cadences — unknown",
        kind: "declared",
        does: "Unknown — registry.yaml is not in this directory.",
        invoke: "unknown",
        command: null,
        network: "unknown",
        status: `No \`${REGISTRY_FILE}\` here, so nothing can be said about declared schedules.`,
        source: REGISTRY_FILE,
        eta: "unknown",
        lastRun: null,
        lastRunNote: "registry.yaml is missing",
        button: null,
      },
    ];
  }

  let reg: Record<string, unknown>;
  try {
    reg = asRecord(yaml.load(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        id: "declared-unparseable",
        label: "registry cadences — unknown",
        kind: "declared",
        does: "Unknown — registry.yaml will not parse.",
        invoke: "unknown",
        command: null,
        network: "unknown",
        status: `${REGISTRY_FILE} is not valid YAML: ${(message.split("\n")[0] ?? message).trim()}`,
        source: REGISTRY_FILE,
        eta: "unknown",
        lastRun: null,
        lastRunNote: "registry.yaml will not parse",
        button: null,
      },
    ];
  }

  const out: Trigger[] = [];

  // 3a. a unit that declares its own cadence
  for (const [name, entry] of Object.entries(asRecord(reg["agents"]))) {
    const schedule = asString(asRecord(entry)["schedule"]);
    if (schedule === null) continue;
    const inPipeline = PIPELINE.includes(name);
    const invokedByCi = workflows.some((wf) => wf.commands.some((c) => c.includes(name)));
    const mine = runs.filter((r) => r.agent === name);
    const last = mine[mine.length - 1];
    out.push({
      id: `declared-agent-${slug(name)}`,
      label: `${name} — "${schedule}"`,
      kind: "declared",
      does: sentence(asString(asRecord(entry)["does"]) ?? `the ${name} unit`),
      invoke: inPipeline ? `legwork run --agent ${name}` : "nothing runs it",
      command: inPipeline ? `legwork run --agent ${name}` : null,
      network: "unknown",
      status: notWired(name, `\`schedule: ${schedule}\` on \`agents.${name}\``, inPipeline, invokedByCi),
      source: REGISTRY_FILE,
      eta: "never measured",
      lastRun: last
        ? { when: last.started.slice(0, 16).replace("T", " "), outcome: last.outcome, detail: `${last.inputs}→${last.outputs}` }
        : null,
      lastRunNote: `\`${name}\` has never appeared in data/runs.jsonl`,
      button: null,
    });
  }

  // 3b. a loop that declares a cadence. per_run / run_error / manual loops are reactions to
  // a run, not ways to start one, so they are not rows here.
  for (const [name, entry] of Object.entries(asRecord(reg["loops"]))) {
    const loop = asRecord(entry);
    const trigger = asString(loop["trigger"]);
    if (trigger === null || !CALENDAR.includes(trigger)) continue;
    const cmd = asString(loop["cmd"]);
    const invokedByCi = workflows.some((wf) => wf.commands.some((c) => cmd !== null && c.includes(cmd)));
    out.push({
      id: `declared-loop-${slug(name)}`,
      label: `${name} loop — "${trigger}"`,
      kind: "declared",
      does: `The ${name} loop, as registry.yaml describes it: ${describeLoop(loop)}.`,
      invoke: cmd ?? "nothing runs it",
      command: cmd,
      network: "unknown",
      status: cmd
        ? `Declared \`trigger: ${trigger}\` on \`loops.${name}\`. Nothing schedules it: no cron in ${WORKFLOW_DIR} and no timer in this repo runs \`${cmd}\`${invokedByCi ? "" : " at all"}. The command exists — the cadence does not.`
        : `Declared \`trigger: ${trigger}\` on \`loops.${name}\` with no \`cmd\`. Nothing in this repo executes it; the entry records the intent.`,
      source: REGISTRY_FILE,
      eta: "never measured",
      lastRun: null,
      lastRunNote: "the run log records unit runs, not loops",
      button: null,
    });
  }

  return out;
}

function notWired(name: string, what: string, inPipeline: boolean, invokedByCi: boolean): string {
  const parts = [`Declared but not wired: ${what} is config only.`];
  parts.push(
    inPipeline
      ? `\`${name}\` is in PIPELINE (src/agents/index.ts), so it runs when \`legwork run\` runs — but on your command, never on the declared cadence.`
      : `\`${name}\` is not in PIPELINE (src/agents/index.ts), so \`legwork run\` skips it.`,
  );
  parts.push(
    invokedByCi
      ? `A workflow step names it, so CI may run it.`
      : `No workflow in ${WORKFLOW_DIR} runs it either. Nothing executes this schedule.`,
  );
  return parts.join(" ");
}

function describeLoop(loop: Record<string, unknown>): string {
  const bits = Object.entries(loop)
    .filter(([k]) => k !== "trigger")
    .map(([k, v]) => `${k} ${scalar(v)}`);
  return bits.length ? bits.join(", ") : "no further configuration";
}

// --- the run log ------------------------------------------------------------------------

interface RunCluster {
  mode: string;
  when: string;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  units: number;
  outcome: string;
}

function readRunsSafely(): RunRecord[] {
  try {
    return readRuns();
  } catch {
    return [];
  }
}

// The run log is one line per unit with no id tying a pipeline pass together, so a "run"
// has to be recovered. The reliable signal is PIPELINE order: the runner walks the units in
// order, so a record whose unit sits at or before the previous record's position is the
// start of a new pass. Mode changes and long gaps also break a pass. This is a heuristic and
// it is only ever used to answer "when did this last run, and did it finish" — never to
// invent a run that is not in the log.
const CLUSTER_GAP_MS = 60 * 1000;

function clusterRuns(runs: RunRecord[]): RunCluster[] {
  const sorted = runs
    .filter((r) => typeof r.started === "string" && Number.isFinite(Date.parse(r.started)))
    .slice()
    .sort((a, b) => Date.parse(a.started) - Date.parse(b.started));

  const rank = (agent: string) => {
    const i = PIPELINE.indexOf(agent);
    return i === -1 ? PIPELINE.length : i;
  };

  const out: RunCluster[] = [];
  let lastRank = Number.POSITIVE_INFINITY;
  for (const r of sorted) {
    const mode = r.mode ?? "unknown";
    const startedMs = Date.parse(r.started);
    const endedMs = startedMs + (Number.isFinite(r.duration_ms) ? r.duration_ms : 0);
    const open = out[out.length - 1];
    const continues =
      open !== undefined &&
      open.mode === mode &&
      rank(r.agent) > lastRank &&
      startedMs - open.endedMs <= CLUSTER_GAP_MS;
    lastRank = rank(r.agent);
    if (open && continues) {
      open.endedMs = Math.max(open.endedMs, endedMs);
      open.durationMs = open.endedMs - open.startedMs;
      open.units += 1;
      if (r.outcome !== "ok" && open.outcome === "ok") open.outcome = r.outcome;
      continue;
    }
    out.push({
      mode,
      when: r.started.slice(0, 16).replace("T", " "),
      startedMs,
      endedMs,
      durationMs: endedMs - startedMs,
      units: 1,
      outcome: r.outcome,
    });
  }
  return out;
}

function lastCluster(clusters: RunCluster[], mode: string): RunCluster | null {
  for (let i = clusters.length - 1; i >= 0; i -= 1) {
    const c = clusters[i];
    if (c && c.mode === mode) return c;
  }
  return null;
}

// --- small helpers ----------------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Only the shapes this repo actually uses get a sentence; anything else keeps its cron.
function humanCron(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const at = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")} UTC`;
  if (!min || !hour || !dom || !mon || !dow) return `cron ${cron}`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return `cron ${cron}`;
  if (dom === "*" && mon === "*" && dow === "*") return `daily at ${at(hour, min)}`;
  if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return `weekly, ${DAYS[Number(dow) % 7]} at ${at(hour, min)}`;
  if (mon === "*" && dow === "*" && /^\d+$/.test(dom)) return `monthly on day ${dom} at ${at(hour, min)}`;
  return `cron ${cron}`;
}

function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

// Step names are authored as titles ("Run the fleet"); inside a list they read as clauses.
function lowerFirst(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t === "") return t;
  // An acronym or an identifier ("GitHub", "npm ci", "CI gate") keeps its case.
  const first = t.split(" ")[0] ?? "";
  if (/[A-Z]/.test(first.slice(1))) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t === "") return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function unescapeJs(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function hasDevScript(): boolean {
  const text = readText(PACKAGE_FILE);
  if (text === null) return false;
  try {
    return typeof asRecord(asRecord(JSON.parse(text))["scripts"])["dev"] === "string";
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function scalar(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
