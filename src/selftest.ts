// `legwork selftest` — the harness proving its own claims, in one command.
//
// The pitch is that agents become trustworthy when something operates them. This is that
// something turned on itself: the citations gate, the eval gate, the demo's determinism,
// the retirement math, the review loop and every endpoint on the desk, checked end to end
// in about ten seconds, offline, with no credentials. It doubles as a demo beat.
//
// Two rules it must never break:
//   1. nothing runs against the repo's live artifacts. Every check that writes runs
//      inside a throwaway copy of the repo, and the last check hashes data/, briefs/,
//      memos/ and site/ before and after to prove it.
//   2. no network, no API key, no GITHUB_TOKEN. Child processes get a scrubbed env.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { brief } from "./agents/brief.js";
import { StoreSignals } from "./appstore.js";
import { CostCeilingError, CostMeter, PRICES_PER_MTOK } from "./costs.js";
import { GitHubClient } from "./gh.js";
import { ReplayLLM, RecordingLLM, ReplayMissError, requestKey, type LLM, type LLMResponse } from "./llm.js";
import { effective, loadRegistry } from "./registry.js";
import { loadAccounts, mergeAccounts, saveAccounts } from "./store.js";
import type { Account, Evidence, RunContext } from "./types.js";

// Resolves against this module, not the cwd — same reasoning as fleetdata.ts.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = realpathSync(tmpdir());
const SEALED = ["data", "briefs", "memos", "site"] as const;
const COPY_PARTS = ["src", "packs", "fixtures", "registry.yaml", "tsconfig.json", "package.json"];
const NOW = "2026-08-20T12:00:00.000Z";
const FABRICATED = "https://fabricated.example.com/not-in-evidence";
const TEST_MODEL = "claude-haiku-4-5";

// --- tiny assertion + temp plumbing -------------------------------------------------

class CheckFailed extends Error {}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new CheckFailed(`${message} (got ${String(actual)}, want ${String(expected)})`);
}

function assertTemp(dir: string): string {
  const real = realpathSync(dir);
  if (real !== TMP_ROOT && !real.startsWith(TMP_ROOT + "/")) {
    throw new CheckFailed(`refusing to operate outside the temp root: ${dir}`);
  }
  return real;
}

const scratch: string[] = [];

function tempDir(prefix = "legwork-selftest-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A runnable copy of the repo, minus every live artifact tree. */
function workingCopy(parts: readonly string[] = COPY_PARTS): string {
  const dir = tempDir("legwork-copy-");
  for (const part of parts) cpSync(join(REPO_ROOT, part), join(dir, part), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function cleanup(): void {
  for (const dir of scratch.splice(0)) {
    try {
      assertTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leftover temp directory is not worth failing the run over
    }
  }
}

async function inDir<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  assertTemp(dir);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

function offlineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SLACK_WEBHOOK_URL", "LEGWORK_LLM"]) {
    delete env[key];
  }
  return env;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(dir: string, args: string[]): CliResult {
  assertTemp(dir);
  const result = spawnSync(join(dir, "node_modules", ".bin", "tsx"), [join("src", "cli.ts"), ...args], {
    cwd: dir,
    env: offlineEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hashTree(path: string): string {
  if (!existsSync(path)) return "absent";
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(path, full));
    }
  };
  walk(path);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(file).update("\0");
    digest.update(createHash("sha256").update(readFileSync(join(path, file))).digest("hex")).update("\n");
  }
  return `${files.length} files ${digest.digest("hex")}`;
}

function sealedHashes(): Record<string, string> {
  return Object.fromEntries(SEALED.map((tree) => [tree, hashTree(join(REPO_ROOT, tree))]));
}

// --- fleet fixtures ------------------------------------------------------------------

function evidence(claim: string, url: string, agent = "qualify"): Evidence {
  return { claim, url, agent, date: NOW.slice(0, 10) };
}

const EAS_MAIN = "https://github.com/acme/mobile/blob/main/eas.json";
const EAS_SHA = "https://github.com/acme/mobile/blob/9f2c1ab/eas.json";
const STORE_URL = "https://apps.apple.com/us/app/acme/id1234567890";
const CAREERS = "https://acme.example.com/careers";

function acme(evidenceList?: Evidence[]): Account {
  return {
    org: "acme",
    company: "Acme",
    stage: "qualified",
    confidence: 0.95,
    updated: NOW,
    evidence: evidenceList ?? [
      evidence("eas.json in the app repo", EAS_MAIN, "discover"),
      evidence("eas build profiles", EAS_SHA, "qualify"),
      evidence("App Store listing", STORE_URL, "qualify"),
      evidence("React Native roles open", CAREERS, "enrich"),
    ],
  };
}

class StubLLM implements LLM {
  readonly kind = "api" as const;
  constructor(private readonly body: string) {}
  async complete(): Promise<LLMResponse> {
    return { text: this.body, tokens_in: 10, tokens_out: 20 };
  }
}

function modelBody(urls: string[], drop?: string): string {
  const sections: [string, string[]][] = [
    ["## Who", ["Acme ships a consumer mobile app."]],
    ["## Production Expo signals", urls.map((url, i) => `- signal ${i + 1} ([source](${url}))`)],
    ["## Who to talk to", ["- Someone on the mobile team."]],
    ["## Suggested opener", ["Public evidence that Acme builds with Expo."]],
  ];
  return [
    "# Acme — account brief",
    "",
    ...sections.flatMap(([heading, lines]) => (heading === drop ? [] : [heading, ...lines, ""])),
  ].join("\n");
}

function briefContext(llm: LLM | null, mode: "live" | "fixture" = "live"): RunContext {
  return {
    pack: "packs/expo",
    mode,
    now: () => NOW,
    sinceDays: 7,
    gh: new GitHubClient({ mode: "fixture" }),
    store: new StoreSignals({ mode: "fixture" }),
    llm,
    costs: new CostMeter(Number.POSITIVE_INFINITY),
  };
}

/** A copy holding only what the brief agent reads, with its model pinned to a priced one. */
function gateCopy(): string {
  const dir = workingCopy(["packs", "registry.yaml"]);
  const path = join(dir, "registry.yaml");
  const doc = yaml.load(readFileSync(path, "utf8")) as { agents: Record<string, Record<string, unknown>> };
  doc.agents.brief!.model = TEST_MODEL;
  doc.agents.brief!.cost_ceiling_usd = 100;
  writeFileSync(path, yaml.dump(doc));
  return dir;
}

interface BriefDecision {
  org: string;
  brief_mode: string;
  llm: { reject_reason: string | null } | null;
}

function briefLocation(dir: string, org: string): string {
  for (const sub of ["briefs", join("briefs", "queue")]) {
    if (existsSync(join(dir, sub, `${org}.decision.json`))) return join(dir, sub);
  }
  throw new CheckFailed(`no brief written for ${org}`);
}

async function writeBrief(
  llm: LLM | null,
  target = acme(),
  mode: "live" | "fixture" = "live",
): Promise<{ decision: BriefDecision; body: string }> {
  const dir = gateCopy();
  const out = await inDir(dir, () => quietly(() => brief.run([target], briefContext(llm, mode))));
  eq(out.length, 1, "the brief agent must emit the account it briefed");
  const location = briefLocation(dir, target.org);
  return {
    decision: JSON.parse(readFileSync(join(location, `${target.org}.decision.json`), "utf8")) as BriefDecision,
    body: readFileSync(join(location, `${target.org}.md`), "utf8"),
  };
}

/** Several modules narrate to the terminal; selftest owns its own output. */
async function quietly<T>(fn: () => Promise<T> | T): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

// --- the desk ------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("no port available"));
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

interface Desk {
  base: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

async function startDesk(dir: string): Promise<Desk> {
  const port = await freePort();
  const child = spawn(
    join(dir, "node_modules", ".bin", "tsx"),
    [join("src", "cli.ts"), "serve", "--port", String(port), "--no-open"],
    { cwd: dir, env: offlineEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout?.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (log += c.toString()));

  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new CheckFailed(`serve exited early (${child.exitCode}): ${log.slice(0, 300)}`);
    try {
      const res = await fetch(base + "/", { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        await res.text();
        return { base, child, stop };
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new CheckFailed(`serve never came up: ${log.slice(0, 300)}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function ask(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // not JSON — the console page, for instance
  }
  return { status: res.status, json, text };
}

// --- the checks ------------------------------------------------------------------------

interface Check {
  name: string;
  run: () => Promise<void>;
}

const CHECKS: Check[] = [
  {
    name: "registry loads and every agent routes to a priced model",
    async run() {
      const reg = loadRegistry(join(REPO_ROOT, "registry.yaml"));
      ok(Object.keys(reg.agents).length > 0, "the fleet has no agents");
      for (const agent of Object.keys(reg.agents)) {
        const config = effective(reg, agent);
        ok(config.costCeilingUsd > 0, `${agent} has no cost ceiling`);
        ok(PRICES_PER_MTOK[config.model], `${agent} routes to unpriced model "${config.model}"`);
      }
      let threw = false;
      try {
        effective(reg, "no-such-agent");
      } catch {
        threw = true;
      }
      ok(threw, "an unknown agent must be rejected");
    },
  },
  {
    name: "account store roundtrips, sorts stably, and upserts by org",
    async run() {
      const file = join(tempDir(), "accounts.jsonl");
      const seed: Account[] = ["mike", "alpha", "zulu"].map((org) => ({
        org,
        stage: "discovered",
        evidence: [],
        updated: NOW,
      }));
      saveAccounts(seed, file);
      const first = readFileSync(file, "utf8");
      saveAccounts([...seed].reverse(), file);
      eq(readFileSync(file, "utf8"), first, "input order must not change the file");
      eq(loadAccounts(file).map((a) => a.org).join(","), "alpha,mike,zulu", "output must be sorted by org");
      ok(!existsSync(`${file}.tmp`), "the write-then-rename temp file must not survive");

      const merged = mergeAccounts(seed, [{ org: "mike", stage: "qualified", evidence: [], updated: NOW }]);
      eq(merged.length, 3, "an upsert must not add a row");
      eq(merged.find((a) => a.org === "mike")?.stage, "qualified", "an upsert must replace the record");
    },
  },
  {
    name: "cost ceiling kills past the boundary, not at it",
    async run() {
      const price = PRICES_PER_MTOK[TEST_MODEL]!;
      const meter = new CostMeter(0.25);
      meter.charge(TEST_MODEL, (1e6 / price.in) * 0.25, 0);
      ok(Math.abs(meter.costUsd - 0.25) < 1e-9, "spending exactly the ceiling must be allowed");
      let killed: unknown = null;
      try {
        meter.charge(TEST_MODEL, 1, 0);
      } catch (err) {
        killed = err;
      }
      ok(killed instanceof CostCeilingError, "one token past the ceiling must be a CostCeilingError");
      let refused = false;
      try {
        new CostMeter(10).charge("model-nobody-priced", 1, 1);
      } catch {
        refused = true;
      }
      ok(refused, "an unpriced model must refuse rather than bill blind");
    },
  },
  {
    name: "llm replay is deterministic, offline, and keyed by the request",
    async run() {
      const dir = tempDir();
      const request = { model: TEST_MODEL, system: "sys", prompt: "prompt", maxTokens: 100 };
      eq(requestKey(request), requestKey({ ...request }), "identical requests must share a key");
      ok(requestKey(request) !== requestKey({ ...request, prompt: "other" }), "the prompt must change the key");
      ok(requestKey(request) !== requestKey({ ...request, system: "other" }), "the system must change the key");
      ok(requestKey(request) !== requestKey({ ...request, model: "claude-opus-5" }), "the model must change the key");

      let missed = false;
      try {
        await new ReplayLLM(dir).complete(request);
      } catch (err) {
        missed = err instanceof ReplayMissError;
      }
      ok(missed, "a replay miss must throw ReplayMissError");

      const inner: LLM = { kind: "api", async complete() { return { text: "body", tokens_in: 1, tokens_out: 2 }; } };
      await new RecordingLLM(inner, dir).complete(request);
      const replayed = await new ReplayLLM(dir).complete(request);
      eq(replayed.text, "body", "a recorded fixture must replay verbatim");
    },
  },
  {
    name: "citations gate accepts a brief citing only the account's evidence",
    async run() {
      const { decision, body } = await writeBrief(new StubLLM(modelBody([EAS_MAIN, STORE_URL, CAREERS])));
      eq(decision.brief_mode, "model", "a clean model brief must ship as a model brief");
      eq(decision.llm?.reject_reason, null, "a clean brief has no reject reason");
      ok(body.includes("## Suggested opener"), "the shipped brief must carry its sections");
    },
  },
  {
    name: "citations gate REJECTS a URL absent from the evidence, and it never ships",
    async run() {
      const { decision, body } = await writeBrief(new StubLLM(modelBody([EAS_MAIN, STORE_URL, FABRICATED])));
      eq(decision.brief_mode, "template", "a fabricated citation must fall back to the template");
      ok(
        (decision.llm?.reject_reason ?? "").startsWith("uncited URL not in evidence:"),
        `unexpected reject reason: ${decision.llm?.reject_reason}`,
      );
      ok(decision.llm!.reject_reason!.includes(FABRICATED), "the reason must name the offending URL");
      ok(!body.includes(FABRICATED), "the fabricated URL must never reach the published brief");
      ok(body.includes("## Production Expo signals"), "the fallback must be a real brief");

      // A near-miss of a real receipt is still a miss.
      const near = `${EAS_MAIN}?plain=1`;
      const nearMiss = await writeBrief(new StubLLM(modelBody([EAS_MAIN, STORE_URL, near])));
      eq(nearMiss.decision.brief_mode, "template", "a near-miss URL must also be rejected");
    },
  },
  {
    name: "brief gate rejects a missing section and thin receipts",
    async run() {
      const missing = await writeBrief(
        new StubLLM(modelBody([EAS_MAIN, STORE_URL, CAREERS], "## Suggested opener")),
      );
      eq(missing.decision.llm?.reject_reason, "missing section: ## Suggested opener", "missing section not caught");
      const thin = await writeBrief(new StubLLM(modelBody([EAS_MAIN, STORE_URL])));
      eq(thin.decision.llm?.reject_reason, "fewer than 3 receipts", "thin receipts not caught");
    },
  },
  {
    name: "receipt URLs canonicalize: two refs of one file collapse, other hosts do not",
    async run() {
      const claim = "eas.json declares build profiles";
      const { body } = await writeBrief(
        null,
        acme([
          evidence(claim, EAS_MAIN, "discover"),
          evidence(claim, EAS_SHA, "qualify"),
          evidence("App Store listing", STORE_URL, "qualify"),
          evidence("hiring React Native engineers", CAREERS, "enrich"),
        ]),
      );
      const bullets = body.split("\n").filter((line) => line.startsWith(`- ${claim} (`));
      eq(bullets.length, 1, "branch and sha refs of one file must collapse to one receipt");
      ok(body.includes(CAREERS), "a non-github URL must render exactly as supplied");
    },
  },
  {
    name: "fixture briefs are labeled as fixtures, live briefs are not",
    async run() {
      const body = modelBody([EAS_MAIN, STORE_URL, CAREERS]);
      const live = await writeBrief(new StubLLM(body), acme(), "live");
      ok(!live.body.includes("FIXTURE DATA"), "a live brief must carry no fixture banner");
      const fixture = await writeBrief(new StubLLM(body), acme(), "fixture");
      ok(fixture.body.includes("FIXTURE DATA"), "a fixture brief must say so");
    },
  },
  {
    name: "retirement math follows the registry threshold",
    async run() {
      const { runRetire } = await import("./retire.js");
      const registry = (threshold: number): string =>
        yaml.dump({
          pack: "packs/expo",
          defaults: { model: TEST_MODEL, cost_ceiling_usd: 0.5, autonomy: "propose" },
          agents: {
            discover: { does: "find repos", output: "candidates.jsonl" },
            "discover-gitlab": { does: "probe gitlab", output: "candidates.jsonl" },
          },
          loops: { retirement: { trigger: "monthly", candidate_threshold: threshold } },
          sources: { notify: { adapter: "stdout" } },
          autonomy_tiers: { human: ["retiring_an_agent"] },
        });
      // Five briefed accounts; discover-gitlab solely discovered two of them = 40%.
      const accounts = Array.from({ length: 5 }, (_, i) => ({
        org: `org-${i}`,
        stage: "briefed" as const,
        updated: NOW,
        evidence: [evidence("found", `https://example.com/${i}`, i < 2 ? "discover-gitlab" : "discover")],
      }));
      const runs = ["discover", "discover-gitlab"].map((agent) => ({
        id: `r-${agent}`,
        agent,
        started: NOW,
        duration_ms: 100,
        inputs: 0,
        outputs: 1,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        mode: "fixture" as const,
        outcome: "ok" as const,
      }));

      const verdict = async (threshold: number): Promise<string> => {
        const dir = tempDir();
        writeFileSync(join(dir, "registry.yaml"), registry(threshold));
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "accounts.jsonl"), accounts.map((a) => JSON.stringify(a)).join("\n") + "\n");
        writeFileSync(join(dir, "data", "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
        await inDir(dir, () => quietly(() => runRetire("discover-gitlab")));
        return readFileSync(join(dir, "memos", "retire-discover-gitlab.md"), "utf8");
      };

      const strict = await verdict(0.5);
      ok(/verdict: \*\*RETIRE\*\*/.test(strict), "40% marginal contribution must retire under a 50% threshold");
      ok(/marginal contribution: 40\.0%/.test(strict), "the memo must show the marginal contribution");
      const lenient = await verdict(0.3);
      ok(/verdict: \*\*KEEP\*\*/.test(lenient), "the same agent must be kept under a 30% threshold");
    },
  },
  {
    name: "review loop publishes on approve and records every decision",
    async run() {
      const dir = workingCopy();
      const accounts: Account[] = [
        { org: "alpha", stage: "briefed", confidence: 0.4, evidence: [], updated: NOW, review: { status: "queued", date: NOW } },
        { org: "bravo", stage: "briefed", confidence: 0.6, evidence: [], updated: NOW, review: { status: "queued", date: NOW } },
      ];
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "accounts.jsonl"), accounts.map((a) => JSON.stringify(a)).join("\n") + "\n");
      mkdirSync(join(dir, "briefs", "queue"), { recursive: true });
      for (const org of ["alpha", "bravo"]) {
        writeFileSync(join(dir, "briefs", "queue", `${org}.md`), `# ${org}\n`);
        writeFileSync(join(dir, "briefs", "queue", `${org}.slack.txt`), `*${org}*\n`);
      }

      eq(cli(dir, ["review", "--approve", "alpha"]).status, 0, "approving a queued brief must succeed");
      ok(existsSync(join(dir, "briefs", "alpha.md")), "approval must publish the brief");
      ok(!existsSync(join(dir, "briefs", "queue", "alpha.md")), "approval must clear the queue entry");

      eq(cli(dir, ["review", "--reject", "bravo"]).status, 0, "rejecting a queued brief must succeed");
      ok(!existsSync(join(dir, "briefs", "bravo.md")), "a rejected brief must stay unpublished");

      const state = loadAccounts(join(dir, "data", "accounts.jsonl"));
      eq(state.find((a) => a.org === "alpha")?.review?.status, "approved", "approve must flip the account");
      eq(state.find((a) => a.org === "bravo")?.review?.status, "rejected", "reject must flip the account");
      const ledger = readFileSync(join(dir, "data", "reviews.jsonl"), "utf8").trim().split("\n");
      eq(ledger.length, 2, "the review ledger is append-only");

      const refused = cli(dir, ["review", "--approve", "not-an-org"]);
      eq(refused.status, 1, "a decision on something unqueued must be refused");
    },
  },
  {
    name: "legwork demo is byte-identical run to run, offline",
    async run() {
      const dir = workingCopy();
      const first = cli(dir, ["demo"]);
      eq(first.status, 0, `demo failed: ${first.stderr.slice(0, 200)}`);
      const accountsA = readFileSync(join(dir, "data", "accounts.jsonl"), "utf8");
      const briefsA = hashTree(join(dir, "briefs"));
      ok(!briefsA.startsWith("0 files"), "the demo must write briefs");

      eq(cli(dir, ["demo"]).status, 0, "the second demo run must also succeed");
      eq(readFileSync(join(dir, "data", "accounts.jsonl"), "utf8"), accountsA, "accounts.jsonl drifted between runs");
      eq(hashTree(join(dir, "briefs")), briefsA, "briefs/ drifted between runs");

      for (const line of readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n")) {
        const record = JSON.parse(line) as { agent: string; outcome: string; mode: string };
        eq(record.mode, "fixture", `${record.agent} did not run in fixture mode`);
        eq(record.outcome, "ok", `${record.agent} did not finish cleanly`);
      }
    },
  },
  {
    name: "eval gate fails the command on a regression and passes once restored",
    async run() {
      const dir = workingCopy();
      const golden = join(dir, "packs", "expo", "golden-set.jsonl");
      const original = readFileSync(golden, "utf8");

      const clean = cli(dir, ["evals"]);
      eq(clean.status, 0, `evals should be clean on a fresh checkout: ${clean.stdout.slice(-300)}`);
      ok(/no regressions/.test(clean.stdout), "a clean run must say so");

      writeFileSync(
        golden,
        original.trimEnd() + "\n" + JSON.stringify({ org: "ghost-org-selftest-probe", verdict: "qualified" }) + "\n",
      );
      const regressed = cli(dir, ["evals"]);
      eq(regressed.status, 1, "a regression must set a non-zero exit code");
      ok(/^REGRESSION: /m.test(regressed.stdout), "a regression must be named");

      writeFileSync(golden, original);
      eq(cli(dir, ["evals"]).status, 0, "restoring the golden set must clear the regression");
    },
  },
  {
    name: "operator desk answers every endpoint and survives every bad request",
    async run() {
      const dir = workingCopy();
      eq(cli(dir, ["demo"]).status, 0, "the desk needs state to serve");
      const desk = await startDesk(dir);
      try {
        const home = await ask(desk.base, "GET", "/");
        eq(home.status, 200, "GET / must serve the console");

        const state = await ask(desk.base, "GET", "/api/state");
        eq(state.status, 200, "GET /api/state must succeed");
        const panels = state.json.html as Record<string, string>;
        for (const panel of ["overview", "queue", "briefs", "evals", "memos", "runs"]) {
          eq(typeof panels?.[panel], "string", `/api/state is missing the ${panel} panel`);
        }

        const started = await ask(desk.base, "POST", "/api/run", { mode: "fixture" });
        eq(started.status, 200, "POST /api/run must start a fixture run");
        const deadline = Date.now() + 60_000;
        let status = await ask(desk.base, "GET", "/api/run/status");
        while (status.json.running === true && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 100));
          status = await ask(desk.base, "GET", "/api/run/status");
        }
        eq(status.json.running, false, "the run never reported completion");
        eq(status.json.error, undefined, `the fixture run failed: ${status.text.slice(0, 200)}`);
        ok(
          (status.json.lines as string[]).some((line) => line.includes("done · fixture run finished")),
          "the run transcript must end cleanly",
        );

        eq((await ask(desk.base, "POST", "/api/run", { mode: "sideways" })).status, 400, "bad mode must be 400");
        eq((await ask(desk.base, "POST", "/api/run", { mode: "live" })).status, 400, "live without a token must be 400");
        eq((await ask(desk.base, "POST", "/api/review", { org: "x" })).status, 400, "a bad decision must be 400");
        eq(
          (await ask(desk.base, "POST", "/api/review", { org: "not-an-org", decision: "approve" })).status,
          400,
          "reviewing something unqueued must be 400",
        );
        eq((await ask(desk.base, "POST", "/api/retire", {})).status, 400, "retire without an agent must be 400");

        const firstRun = JSON.parse(
          readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n")[0]!,
        ) as { agent: string };
        const retired = await ask(desk.base, "POST", "/api/retire", { agent: firstRun.agent });
        eq(retired.status, 200, "retire must return a memo");
        ok(String(retired.json.memo).includes("# Retirement memo"), "the memo must be the artifact");

        const evals = await ask(desk.base, "POST", "/api/evals");
        eq(evals.status, 200, "POST /api/evals must succeed");
        eq(typeof evals.json.regressions, "boolean", "evals must report whether it regressed");

        eq((await ask(desk.base, "POST", "/api/notify", {})).status, 400, "notify without an org must be 400");
        eq(
          (await ask(desk.base, "POST", "/api/notify", { org: "not-an-org" })).status,
          404,
          "notifying an unpublished brief must be 404",
        );
        const published = readdirSync(join(dir, "briefs")).find((f) => f.endsWith(".slack.txt"));
        ok(published, "the demo must publish at least one brief");
        const notified = await ask(desk.base, "POST", "/api/notify", {
          org: published.replace(".slack.txt", ""),
        });
        eq(notified.status, 200, "notify must succeed for a published brief");
        eq(notified.json.result, "printed", "with no webhook configured, notify prints");

        eq((await ask(desk.base, "GET", "/api/nope")).status, 404, "an unknown path must be 404");
        eq((await ask(desk.base, "GET", "/api/run")).status, 404, "GET on a POST-only route must be 404");
        eq((await ask(desk.base, "POST", "/api/run", "{not json")).status, 400, "malformed JSON must be 400");
        eq((await ask(desk.base, "POST", "/api/review", "[1,2]")).status, 400, "a non-object body must be 400");

        eq((await ask(desk.base, "GET", "/api/state")).status, 200, "the desk must survive every bad request");
      } finally {
        await desk.stop();
      }
    },
  },
];

// --- runner ----------------------------------------------------------------------------

export interface SelftestOptions {
  only?: string;
}

export async function runSelftest(opts: SelftestOptions = {}): Promise<number> {
  const selected = opts.only
    ? CHECKS.filter((c) => c.name.toLowerCase().includes(opts.only!.toLowerCase()))
    : CHECKS;
  if (selected.length === 0) {
    console.log(`no check matches "${opts.only}"`);
    return 1;
  }

  console.log("legwork selftest — the harness checking itself. Offline, no credentials.");
  console.log("Nothing here runs against data/, briefs/, memos/ or site/; the last row proves it.");
  console.log("");

  const sealedBefore = sealedHashes();
  const started = Date.now();
  const rows: { name: string; result: string; ms: number; detail?: string }[] = [];

  try {
    for (const check of selected) {
      const at = Date.now();
      try {
        await check.run();
        rows.push({ name: check.name, result: "pass", ms: Date.now() - at });
      } catch (err) {
        const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
        rows.push({ name: check.name, result: "FAIL", ms: Date.now() - at, detail });
      }
    }
  } finally {
    cleanup();
  }

  // The seal is the last check, and it is about this very run.
  const sealedAfter = sealedHashes();
  const moved = SEALED.filter((tree) => sealedBefore[tree] !== sealedAfter[tree]);
  rows.push({
    name: "live artifacts untouched (data/, briefs/, memos/, site/)",
    result: moved.length === 0 ? "pass" : "FAIL",
    ms: 0,
    ...(moved.length === 0 ? {} : { detail: `mutated: ${moved.join(", ")}` }),
  });

  const width = Math.max(...rows.map((r) => r.name.length), "check".length);
  console.log(`${"check".padEnd(width)}  result  duration`);
  console.log(`${"-".repeat(width)}  ------  --------`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${row.result.padEnd(6)}  ${`${row.ms}ms`.padStart(8)}`);
    if (row.detail) console.log(`${" ".repeat(width)}  → ${row.detail}`);
  }

  const failed = rows.filter((r) => r.result !== "pass");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  if (failed.length === 0) {
    console.log(`PASS · ${rows.length} checks · ${seconds}s`);
    for (const tree of SEALED) console.log(`  ${tree}/  ${sealedAfter[tree]}`);
    return 0;
  }
  console.log(`FAIL · ${failed.length} of ${rows.length} checks · ${seconds}s`);
  return 1;
}
