// How it runs: the fleet's brain, made legible.
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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { PIPELINE } from "./agents/index.js";
import { loadRegistry } from "./registry.js";
import { esc } from "./reviewhtml.js";

const REGISTRY_FILE = "registry.yaml";
const QUALIFY_SRC = join("src", "agents", "qualify.ts");
const AGENT_SRC_DIR = join("src", "agents");
const PLAYBOOK_FILE = "PLAYBOOK.md";
const DEFAULT_PACK = join("packs", "expo");

// --- entry point ---------------------------------------------------------------------

export function renderBrain(opts: { served?: boolean } = {}): string {
  const served = opts.served === true;
  const raw = readYamlResult(REGISTRY_FILE);
  const reg = asRecord(raw.value);
  const pack = asString(reg["pack"]) ?? DEFAULT_PACK;
  const playbook = readPlaybook();

  return `
  <p class="lead">The fleet is config, not code. Everything below is read out of the files in this repo at render time — the registry, the ICP, the prompt files, the golden set. Nothing on this page is typed into the page. Each section ends with the exact file you edit to change it.</p>
  ${validitySection(raw)}
  ${pipelineSection(reg, pack, playbook)}
  ${tiersSection(reg)}
  ${loopsSection(reg)}
  ${icpSection(pack)}
  ${promptsSection(pack, playbook)}
  ${goldenSection(pack, playbook)}
  <p class="sub">${
    served
      ? "This desk runs on your machine, but config is still a file edit: change the file, re-run, reload. There is no editor here on purpose — a second way to write the config is a second source of truth."
      : "Editing is a file edit in the repo that generated this page: change the file, re-run <code>legwork report</code>, reload."
  }</p>
`;
}

// --- 0. does the registry still parse -------------------------------------------------

// The panel's own honesty check. If registry.yaml stopped validating, every number below
// is being read from a file the runner would refuse, and the reader needs to know first.
function validitySection(raw: YamlResult): string {
  if (raw.missing) {
    return `<section class="block"><h2>Config health</h2>
<p class="empty"><span class="bpill" data-kind="human">missing</span> No <code>${esc(REGISTRY_FILE)}</code> in this directory. Everything the registry defines is blank below.</p></section>`;
  }
  if (raw.error !== null) {
    return `<section class="block"><h2>Config health</h2>
<p><span class="bpill" data-kind="human">will not parse</span> <span class="dimcell"><code>${esc(REGISTRY_FILE)}</code> is not valid YAML, so the runner cannot start: ${esc(raw.error)}</span></p>
<p class="changeline"><span class="changelabel">to change this</span> Fix <code>${esc(REGISTRY_FILE)}</code> at the line above. A value containing <code>: </code> — a colon and a space — has to be quoted, which is the usual cause.</p></section>`;
  }
  let status = `<span class="bpill" data-kind="ok">validates</span> <span class="dimcell">${esc(REGISTRY_FILE)} parses and passes the runner's schema.</span>`;
  try {
    loadRegistry(REGISTRY_FILE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status = `<span class="bpill" data-kind="human">invalid</span> <span class="dimcell">${esc(message)} — the runner will refuse this file. Values below are read raw and may be incomplete.</span>`;
  }
  return `<section class="block"><h2>Config health</h2><p>${status}</p></section>`;
}

// --- 1. the pipeline ------------------------------------------------------------------

function pipelineSection(reg: Record<string, unknown>, pack: string, playbook: PlaybookStep[]): string {
  const agents = asRecord(reg["agents"]);
  const defaults = asRecord(reg["defaults"]);
  const names = Object.keys(agents);
  if (names.length === 0) {
    return `<section class="block"><h2>The pipeline</h2><p class="empty">No <code>agents:</code> block in <code>${esc(REGISTRY_FILE)}</code> — nothing configured to run.</p>
${changeLine([`Add an agent block to <code>${esc(REGISTRY_FILE)}</code>.`], playbook, [1, 2, 3])}</section>`;
  }

  // Pipeline order first (that is the order the runner executes), then anything in the
  // registry the runner has no slot for — usually a scheduled unit, sometimes a typo.
  const ordered = [...PIPELINE.filter((n) => n in agents), ...names.filter((n) => !PIPELINE.includes(n))];

  const cards = ordered
    .map((name, index) => unitCard(name, asRecord(agents[name]), defaults, pack, index))
    .join("\n");

  const modelCount = ordered.filter((n) => kindOf(n, pack).model).length;
  return `<section class="block"><h2>The pipeline — ${ordered.length} units, ${modelCount} of them ${modelCount === 1 ? "calls" : "call"} a model</h2>
<p class="sub" style="margin-bottom:14px">Units run in this order, each one a stateless reducer: records in, records out. Most of the fleet is ordinary deterministic software — HTTP, parsing, arithmetic — and says so on its badge. A model gets called only where judgment is actually required, and only from a prompt file that lives in git.</p>
<div class="units">${cards}</div>
${changeLine(
    [
      `<code>${esc(REGISTRY_FILE)}</code> → <code>agents.&lt;name&gt;</code> for what a unit does, what it may spend, and which model runs it.`,
      `Values a unit does not set are inherited from <code>defaults</code> in the same file.`,
    ],
    playbook,
    [1, 2, 3],
  )}
</section>`;
}

function unitCard(
  name: string,
  entry: Record<string, unknown>,
  defaults: Record<string, unknown>,
  pack: string,
  index: number,
): string {
  const step = String(index + 1).padStart(2, "0");
  const inPipeline = PIPELINE.includes(name);
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
  if (sources.length) rows.push(row("source adapters", sources.map(codeTag).join(" ")));
  if (signals.length) rows.push(row("signals", signals.map(codeTag).join(" ")));
  if (!sources.length && !signals.length) {
    rows.push(row("source adapters", `<span class="dimcell">none — works on records the units before it produced</span>`));
  }
  rows.push(
    row(
      "model",
      kind.model
        ? valueWithOrigin(model, (v) => `<span class="mono">${esc(v)}</span>`)
        : `<span class="dimcell">resolved to ${model.value ? `<span class="mono">${esc(model.value)}</span>` : "nothing"}${model.inherited ? " by inheritance" : ""}, ${
            kind.badge === "none"
              ? "and nothing spends it — there is no module to run"
              : "never used — this unit makes no model call"
          }</span>`,
    ),
  );
  rows.push(
    row(
      "cost ceiling",
      valueWithOrigin(ceiling, (v) => `<span class="mono">$${v.toFixed(2)}</span> per run, then the runner kills it`),
    ),
  );
  rows.push(row("autonomy", autonomyPill(autonomy)));
  if (output) rows.push(row("writes", codeTag(output)));
  if (schedule) rows.push(row("schedule", codeTag(schedule)));

  const notes: string[] = [];
  if (hypothesis) {
    notes.push(
      `<p class="hyp"><span class="hyplabel">Recorded hypothesis</span> ${esc(hypothesis)} <span class="dimcell">The retirement loop is what settles it.</span></p>`,
    );
  }
  if (!inPipeline) {
    notes.push(
      `<p class="hyp"><span class="hyplabel">Not in the run pipeline</span> <span class="dimcell">The registry defines it, but <code>PIPELINE</code> in <code>src/agents/index.ts</code> does not run it${schedule ? ` — it is scheduled ${esc(schedule)} instead` : ""}.</span></p>`,
    );
  }

  return `<section class="card unit">
  <header>
    <h2><span class="step">${step}</span>${esc(name)}</h2>
    <span class="bpill" data-kind="${kind.badge === "model" ? "model" : kind.badge === "code" ? "ok" : "warn"}">${
      kind.badge === "model" ? "calls a model" : kind.badge === "code" ? "deterministic code" : "no implementation"
    }</span>
  </header>
  <p class="does">${does ? esc(does) : '<span class="empty">no <code>does:</code> line — nobody can tell what this unit is for</span>'}</p>
  <table>${rows.join("")}</table>
  ${notes.join("\n  ")}
  <p class="kindwhy">${kind.why}</p>
</section>`;
}

// Deterministic or model-backed is a claim about the code, so it is read off the code:
// a unit calls a model iff its module touches the one LLM interface (`ctx.llm`), and the
// prompt file it would use is right there in the pack. Nothing here is a lookup table.
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
        ? `No module at <code>${esc(srcFile)}</code>, but a prompt file exists at <code>${esc(promptFile)}</code>.`
        : `No module at <code>${esc(srcFile)}</code> and no prompt file — this unit is a registry entry with nothing behind it yet.`,
    };
  }
  const usesLlm = /\bctx\.llm\b/.test(src);
  if (!usesLlm) {
    return {
      model: false,
      badge: "code",
      why: `<code>${esc(srcFile)}</code> never touches <code>ctx.llm</code>: HTTP, parsing, arithmetic.`,
    };
  }
  return {
    model: true,
    badge: "model",
    why: hasPrompt
      ? `<code>${esc(srcFile)}</code> calls <code>ctx.llm</code> with the prompt in <code>${esc(promptFile)}</code>.`
      : `<code>${esc(srcFile)}</code> calls <code>ctx.llm</code>, but no prompt file at <code>${esc(promptFile)}</code>.`,
  };
}

// --- 2. autonomy tiers ----------------------------------------------------------------

const TIER_ORDER = ["fix", "propose", "human"];

const TIER_GLOSS: Record<string, string> = {
  fix: "Runs unattended. The harness does it and writes it to the run log; nobody is asked first.",
  propose: "Lands as a pull request. The fleet drafts the change and a person merges it.",
  human: "Never automated. A person decides, every time, no matter how confident anything is.",
};

function tiersSection(reg: Record<string, unknown>): string {
  const tiers = asRecord(reg["autonomy_tiers"]);
  const keys = [...TIER_ORDER.filter((k) => k in tiers), ...Object.keys(tiers).filter((k) => !TIER_ORDER.includes(k))];
  if (keys.length === 0) {
    return `<section class="block"><h2>Autonomy tiers — who is allowed to act</h2>
<p class="empty">No <code>autonomy_tiers</code> block in <code>${esc(REGISTRY_FILE)}</code>. With no tiers configured there is no written rule about what the fleet may do on its own.</p></section>`;
  }

  const columns = keys
    .map((key) => {
      const items = asStringArray(tiers[key]);
      const kindFor = key === "fix" ? "ok" : key === "propose" ? "model" : key === "human" ? "human" : "";
      const gloss = TIER_GLOSS[key] ?? "No gloss for this tier; it is not one of the three the harness knows.";
      const list = items.length
        ? `<ul>${items.map((i) => `<li><span class="mono">${esc(i)}</span></li>`).join("")}</ul>`
        : `<p class="empty">nothing at this tier</p>`;
      return `<div class="tier">
  <div class="tierhead"><span class="bpill" data-kind="${kindFor}">${esc(key)}</span><span class="num">${items.length}</span></div>
  <p class="tiergloss">${esc(gloss)}</p>
  ${list}
  <p class="tierpath"><code>autonomy_tiers.${esc(key)}</code></p>
</div>`;
    })
    .join("\n");

  return `<section class="block"><h2>Autonomy tiers — who is allowed to act</h2>
<p class="sub" style="margin-bottom:14px">Three lists in one file decide what the fleet may do by itself. This is the governance story, and it is deliberately boring: a tier is an array of strings, so you can read the whole policy in ten seconds and diff it in a pull request.</p>
<div class="tiers">${columns}</div>
${changeLine(
    [
      `<code>${esc(REGISTRY_FILE)}</code> → <code>autonomy_tiers.&lt;tier&gt;</code>. Moving a capability between arrays is the entire mechanism.`,
      `Per-unit overrides live at <code>agents.&lt;name&gt;.autonomy</code>; a unit that sets none inherits <code>defaults.autonomy</code>.`,
    ],
  )}
</section>`;
}

// --- 3. loops -------------------------------------------------------------------------

const LOOP_GLOSS: Record<string, string> = {
  eval: "Scores each run against the hand-labeled golden set and fails the run on a regression.",
  review: "Watches how often humans accept output, and how hard they edit it.",
  heal: "Reads a failing run's compacted log and proposes the fix.",
  improve: "Redrafts an agent's prompt file from the operating record, as a pull request.",
  outcome: "Feeds real outcomes back into what the scoring signals are worth.",
  retirement: "Measures what each unit uniquely contributed and names the ones that did not earn their keep.",
};

// The interesting keys are the numeric ones: a number in a loop is a dial somebody can
// turn. Detecting them by type rather than by name means a new dial shows up here the
// day it is added to the registry, without this file changing.
function loopsSection(reg: Record<string, unknown>): string {
  const loops = asRecord(reg["loops"]);
  const names = Object.keys(loops);
  if (names.length === 0) {
    return `<section class="block"><h2>Loops — what the harness does on its own</h2>
<p class="empty">No <code>loops:</code> block in <code>${esc(REGISTRY_FILE)}</code>.</p></section>`;
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
  <td class="dimcell">${gloss ? esc(gloss) : "No gloss recorded for this loop."}${rest ? `<div class="kvs">${rest}</div>` : ""}</td>
  <td>${knobs.length ? knobs.join("") : '<span class="dimcell">no dial</span>'}</td>
</tr>`;
    })
    .join("");

  return `<section class="block"><h2>Loops — what the harness does on its own</h2>
<p class="sub" style="margin-bottom:14px">A loop is a trigger, a thing it does, and sometimes a number you can turn. The numbers are the ones worth knowing about: a confidence gate decides how much lands in front of a person, and a retirement threshold decides how little contribution is too little.</p>
<table><tr><th>loop</th><th>trigger</th><th>what it does</th><th>tuning dial</th></tr>${rows}</table>
${changeLine([`<code>${esc(REGISTRY_FILE)}</code> → <code>loops.&lt;name&gt;</code>. Each dial above prints the exact path to edit.`])}
</section>`;
}

// --- 4. ICP and scoring ---------------------------------------------------------------

function icpSection(pack: string): string {
  const file = join(pack, "icp.yaml");
  const loaded = readYamlResult(file);
  const icp = asRecord(loaded.value);
  const weights = readWeights();

  if (loaded.error !== null) {
    return `<section class="block"><h2>ICP and scoring</h2>
<p><span class="bpill" data-kind="human">will not parse</span> <span class="dimcell"><code>${esc(file)}</code> is not valid YAML: ${esc(loaded.error)}</span></p></section>`;
  }
  if (Object.keys(icp).length === 0 && weights === null) {
    return `<section class="block"><h2>ICP and scoring</h2>
<p class="empty">No <code>${esc(file)}</code> and no readable weights in <code>${esc(QUALIFY_SRC)}</code>.</p></section>`;
  }

  const thesis = asString(icp["thesis"]);
  const grouped = asRecord(icp["signals"]);
  const listed: { name: string; group: string }[] = [];
  for (const group of Object.keys(grouped)) {
    for (const name of asStringArray(grouped[group])) listed.push({ name, group });
  }

  const scoreTable = weights === null
    ? `<p class="empty">Signals are listed in <code>${esc(file)}</code>, but the weights could not be read from <code>${esc(QUALIFY_SRC)}</code> — that file is where the numbers actually live.</p>
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

  return `<section class="block"><h2>ICP and scoring — what "qualified" means</h2>
${thesis ? `<p class="sub" style="margin-bottom:14px">${esc(thesis)}</p>` : ""}
${scoreTable}
<h3>Segments</h3>
${segRows ? `<table><tr><th>segment</th><th>name</th><th>tell</th><th>example</th></tr>${segRows}</table>` : `<p class="empty">No <code>segments</code> block in <code>${esc(file)}</code>.</p>`}
${changeLine([
    `<code>${esc(file)}</code> for which signals count and how the segments are defined.`,
    `<code>${esc(QUALIFY_SRC)}</code> → <code>WEIGHTS</code> and <code>QUALIFY_AT</code> for the numbers. Changing a weight moves the eval scores, so re-run <code>legwork evals</code> and expect the golden set to move with it.`,
  ])}
</section>`;
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

  // Two directions of drift are worth naming: a signal the code weighs that the ICP file
  // never mentions, and a signal the ICP file claims that the code never scores.
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
  <td class="dimcell">${entries.length} weighted signals</td>
  <td class="num">${total.toFixed(2)}</td>
  <td>${off ? `<span class="bpill" data-kind="human">does not sum to 1.00 — scores are not on the scale the threshold assumes</span>` : `<span class="dimcell">sums to 1.00</span>`}</td>
</tr>`;

  const drift: string[] = [];
  if (unlisted.length) {
    drift.push(
      `<p class="drift"><span class="bpill" data-kind="warn">drift</span> Weighted in code but absent from <code>${esc(icpFile)}</code>: ${unlisted.map(codeTag).join(" ")}</p>`,
    );
  }
  if (unweighted.length) {
    drift.push(
      `<p class="drift"><span class="bpill" data-kind="warn">drift</span> Listed in <code>${esc(icpFile)}</code> but never scored: ${unweighted.map(codeTag).join(" ")}</p>`,
    );
  }

  const threshold =
    weights.threshold === null
      ? `<p class="sub">Qualification threshold not readable from <code>${esc(QUALIFY_SRC)}</code>.</p>`
      : `<p class="sub">An account qualifies at <span class="num">${weights.threshold.toFixed(2)}</span> or above <span class="dimcell">(<code>QUALIFY_AT</code> in <code>${esc(QUALIFY_SRC)}</code>)</span>, and only if it has an EAS config at all — one hard gate in front of the arithmetic.</p>`;

  return `<h3>Signal weights</h3>
<table class="weights"><tr><th>signal</th><th>group</th><th>weight</th><th></th></tr>${rows}${totalRow}</table>
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

// --- 5. prompts -------------------------------------------------------------------------

function promptsSection(pack: string, playbook: PlaybookStep[]): string {
  const dir = join(pack, "prompts");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return `<section class="block"><h2>Prompts — owned, versioned files</h2>
<p class="empty">No prompt directory at <code>${esc(dir)}</code>.</p></section>`;
  }
  if (files.length === 0) {
    return `<section class="block"><h2>Prompts — owned, versioned files</h2>
<p class="empty">No <code>.md</code> prompt files in <code>${esc(dir)}</code>.</p></section>`;
  }

  const items = files
    .map((file) => {
      const path = join(dir, file);
      const body = readText(path);
      if (body === null) {
        return `<details><summary>${esc(file)} — unreadable</summary><p class="empty">Could not read <code>${esc(path)}</code>.</p></details>`;
      }
      // Same scheme brief.ts stamps into every run as `prompt_version`: sha256 of the file
      // bytes, first 8 hex. The hash below is the one that lands in the run log.
      const version = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 8);
      const bytes = sizeOf(path);
      return `<details>
  <summary>${esc(file)} <span class="num">${esc(version)}</span> <span class="dimcell">${bytes === null ? "" : `${bytes} bytes · `}${countLines(body)} lines</span></summary>
  <pre class="promptsrc">${esc(body)}</pre>
</details>`;
    })
    .join("\n");

  return `<section class="block"><h2>Prompts — owned, versioned files</h2>
<p class="sub" style="margin-bottom:14px">No prompt is inlined in code. Each one is a file in the pack, and the 8-character hash beside it is the <code>prompt_version</code> stamped into every run that used it — so a brief you are reading a month from now can be traced back to the exact words that produced it.</p>
${items}
${changeLine(
    [
      `Edit the file in <code>${esc(dir)}</code> directly, or let the fleet draft the edit: <code>legwork improve &lt;agent&gt;</code> opens it as a pull request rather than writing it in place.`,
      `The hash changes the moment the bytes do; nothing else needs updating.`,
    ],
    playbook,
    [4],
  )}
</section>`;
}

// --- 6. golden set ----------------------------------------------------------------------

const BOOTSTRAP_LABELERS = new Set(["bootstrap", "seed", "auto", ""]);

function goldenSection(pack: string, playbook: PlaybookStep[]): string {
  const file = join(pack, "golden-set.jsonl");
  const text = readText(file);
  if (text === null) {
    return `<section class="block"><h2>Golden set — the ground truth</h2>
<p class="empty">No golden set at <code>${esc(file)}</code>. With no labels there is no regression gate: every run would pass.</p></section>`;
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
    return `<section class="block"><h2>Golden set — the ground truth</h2>
<p class="empty"><code>${esc(file)}</code> holds no usable rows${malformed ? ` (${malformed} unparseable line${malformed === 1 ? "" : "s"})` : ""}.</p></section>`;
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
        `<tr><td><span class="mono">${esc(verdict)}</span></td><td class="num">${n}</td><td class="barcell"><span class="wbar"><span style="width:${((n / rows.length) * 100).toFixed(1)}%"></span></span></td><td class="num">${Math.round((n / rows.length) * 100)}%</td></tr>`,
    )
    .join("");

  const labelerRows = labelers
    .map(([who, n]) => {
      const isHuman = who !== "(none)" && !BOOTSTRAP_LABELERS.has(who.toLowerCase());
      return `<tr><td><span class="mono">${esc(who)}</span></td><td>${isHuman ? `<span class="bpill" data-kind="ok">human</span>` : `<span class="bpill">bootstrap</span>`}</td><td class="num">${n}</td></tr>`;
    })
    .join("");

  return `<section class="block"><h2>Golden set — the ground truth</h2>
<p class="sub" style="margin-bottom:14px">Humans own ground truth. Every run is scored against these hand-checked rows, and a score below the baseline fails CI. A label written by the fleet is not ground truth — it is a starting point somebody still has to confirm.</p>
<div class="kpis">
  <div class="kpi"><div class="v">${rows.length}</div><div class="k">labeled rows</div></div>
  <div class="kpi"><div class="v">${human}</div><div class="k">human-labeled</div></div>
  <div class="kpi"><div class="v">${rows.length - human}</div><div class="k">bootstrap, awaiting a human</div></div>
  <div class="kpi"><div class="v">${verdicts.length}</div><div class="k">distinct verdicts</div></div>
</div>
<h3>Verdict distribution</h3>
<table><tr><th>verdict</th><th>rows</th><th></th><th>share</th></tr>${verdictRows}</table>
<h3>Who labeled them</h3>
<table><tr><th>labeled_by</th><th></th><th>rows</th></tr>${labelerRows}</table>
${malformed ? `<p class="drift"><span class="bpill" data-kind="warn">${malformed} unparseable line${malformed === 1 ? "" : "s"}</span> skipped in <code>${esc(file)}</code>.</p>` : ""}
${changeLine(
    [
      `Append a row to <code>${esc(file)}</code>: one JSON object per line, with your own name in <code>labeled_by</code>.`,
      `Then <code>legwork evals</code>. A green check is the ship signal; a red one means read the eval diff before touching anything else.`,
    ],
    playbook,
    [4],
  )}
</section>`;
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

// The quiet line every section ends on. Config is the control surface, so each section
// names its file; where the PLAYBOOK already covers the move, it names the step too and
// quotes its first clause so the reader knows which step without opening the file.
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
  if (v.value === null) return `<span class="empty">not configured, and no default to fall back to</span>`;
  return `${render(v.value)}${v.inherited ? ` <span class="inh">inherited from defaults</span>` : ` <span class="inh">set on this unit</span>`}`;
}

function autonomyPill(v: Inherited<string>): string {
  if (v.value === null) return `<span class="empty">not configured</span>`;
  const kind = v.value === "fix" ? "ok" : v.value === "propose" ? "model" : v.value === "human" ? "human" : "";
  return `<span class="bpill" data-kind="${kind}">${esc(v.value)}</span>${
    v.inherited ? ` <span class="inh">inherited from defaults</span>` : ` <span class="inh">set on this unit</span>`
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
// no new colors, no new fonts, no decoration that is not carrying information.
export const brainStyles: string = `  .units { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:14px; }
  .units .card { margin-bottom:0; padding:18px 20px; }
  .unit header { gap:10px; padding-bottom:10px; margin-bottom:12px; }
  .unit h2 { font-size:15px; }
  .unit .step { font-family:var(--mono); font-size:11px; color:var(--faint); margin-right:8px; }
  .unit .does { font-size:14px; color:var(--text); margin-bottom:10px; }
  .unit table { font-size:13px; }
  .unit th { width:34%; white-space:nowrap; }
  .unit .kindwhy { color:var(--faint); font-size:12px; margin-top:10px; }
  .hyp { font-size:13px; color:var(--text); margin-top:10px; }
  .hyplabel { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); font-weight:600; }
  .mono { font-family:var(--mono); font-size:12.5px; }
  .inh { color:var(--faint); font-size:11.5px; }
  .bpill { display:inline-block; font-size:11.5px; padding:2px 9px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-weight:500; white-space:nowrap; }
  .bpill[data-kind="ok"] { color:var(--ok); border-color:var(--ok); background:var(--ok-bg); }
  .bpill[data-kind="model"] { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
  .bpill[data-kind="human"] { color:var(--no); border-color:var(--no); background:var(--no-bg); white-space:normal; }
  .bpill[data-kind="warn"] { color:var(--warn); border-color:var(--warn); background:var(--warn-bg); }
  .tiers { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }
  .tier { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .tierhead { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .tierhead .num { margin-left:auto; color:var(--faint); }
  .tiergloss { font-size:13.5px; color:var(--text); margin-bottom:10px; }
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
