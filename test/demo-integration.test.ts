// End-to-end, in a throwaway working copy of the repo. Three properties matter:
// the demo is byte-identical run to run (it is the show-and-tell insurance policy),
// the citations gate holds when the bad URL arrives from a real replay fixture rather
// than from a stub, and the eval gate actually fails the command.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCli, withWorkingCopy, type CliResult } from "./helpers/env.js";
import { hashTree } from "./helpers/treehash.js";
import type { Account } from "../src/types.js";

const FABRICATED = "https://fabricated.example.com/not-in-evidence";

interface Decision {
  org: string;
  brief_mode: string;
  llm: { provider: string; reject_reason: string | null } | null;
}

function briefDir(dir: string, org: string): string {
  for (const sub of ["briefs", join("briefs", "queue")]) {
    if (existsSync(join(dir, sub, `${org}.decision.json`))) return join(dir, sub);
  }
  throw new Error(`no brief written for ${org}`);
}

function decisions(dir: string): Decision[] {
  const out: Decision[] = [];
  for (const sub of ["briefs", join("briefs", "queue")]) {
    const path = join(dir, sub);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path).filter((f) => f.endsWith(".decision.json"))) {
      out.push(JSON.parse(readFileSync(join(path, file), "utf8")) as Decision);
    }
  }
  return out;
}

function accountsIn(dir: string): Account[] {
  return readFileSync(join(dir, "data", "accounts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Account);
}

test("legwork demo is byte-identical run to run", async () => {
  await withWorkingCopy((dir) => {
    const first = runCli(dir, ["demo"]);
    assert.equal(first.status, 0, first.stderr);
    const accountsA = readFileSync(join(dir, "data", "accounts.jsonl"), "utf8");
    const briefsA = hashTree(join(dir, "briefs"));

    const second = runCli(dir, ["demo"]);
    assert.equal(second.status, 0, second.stderr);

    assert.equal(
      readFileSync(join(dir, "data", "accounts.jsonl"), "utf8"),
      accountsA,
      "data/accounts.jsonl must be identical",
    );
    assert.equal(hashTree(join(dir, "briefs")), briefsA, "every file in briefs/ must be identical");
    assert.ok(!briefsA.startsWith("0 files"), "the demo must actually write briefs");

    // The run log is a log: it grows. That is the one file allowed to differ.
    const runs = readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n");
    assert.ok(runs.length >= 2, "the run log accumulates across runs");
    assert.match(first.stdout, /No credentials, no network, same output every time\./);
  });
});

test("every demo run finishes clean, in fixture mode, under its cost ceiling", async () => {
  await withWorkingCopy((dir) => {
    assert.equal(runCli(dir, ["demo"]).status, 0);
    const runs = readFileSync(join(dir, "data", "runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(runs.length > 0);
    for (const record of runs) {
      assert.equal(record.mode, "fixture");
      assert.equal(record.outcome, "ok", `${String(record.agent)} did not finish cleanly`);
      assert.ok(typeof record.cost_usd === "number");
    }
  });
});

// --- the citations gate, driven through a real replay fixture -----------------------

/**
 * Guarantee a model-replay brief exists, whatever state the shipped fixtures are in.
 *
 * A replay fixture is keyed by the hash of the request, and brief.ts prints that hash on
 * a miss ("no replay fixture for request <key>"). So if the shipped fixtures are stale —
 * which they are whenever a prompt or the pipeline changes — we mint one: take the key
 * from the miss, and record a well-formed brief that cites only that account's own
 * evidence. Either way the test then exercises the same production path.
 */
function ensureReplayBrief(dir: string, first: CliResult): string | null {
  const existing = decisions(dir).find((d) => d.brief_mode === "model-replay");
  if (existing) return existing.org;

  const misses = new Map<string, string>();
  for (const line of first.stderr.split("\n")) {
    const match = /brief model path unavailable for (\S+): no replay fixture for request ([0-9a-f]+)/.exec(line);
    if (match) misses.set(match[1]!, match[2]!);
  }
  if (misses.size === 0) return null;

  for (const account of accountsIn(dir)) {
    const key = misses.get(account.org);
    if (!key) continue;
    const allowed = account.evidence.map((e) => e.url);
    // The agent injects its own "why this score" receipts; they must be citable too.
    const injected = (account.qualification?.signals ?? [])
      .map((s) => s.evidence_url)
      .filter((url): url is string => typeof url === "string");
    if (allowed.length < 3 || injected.some((url) => !allowed.includes(url))) continue;

    const body = [
      `# ${account.company ?? account.org} — account brief`,
      "",
      "## Who",
      `${account.company ?? account.org} ships a mobile app. ([source](${allowed[0]}))`,
      "",
      "## Production Expo signals",
      ...allowed.slice(0, 3).map((url, i) => `- signal ${i + 1} ([source](${url}))`),
      "",
      "## Who to talk to",
      `- Someone on the mobile team. ([source](${allowed[1]}))`,
      "",
      "## Suggested opener",
      `Public evidence that they build with Expo. ([source](${allowed[2]}))`,
      "",
    ].join("\n");

    const fixtureDir = join(dir, "fixtures", "llm");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, `${key}.json`),
      JSON.stringify({ model: "recorded", text: body, tokens_in: 900, tokens_out: 500 }, null, 2) + "\n",
    );
    return account.org;
  }
  return null;
}

/** The replay fixture whose recorded text carries this brief's receipts. */
function fixturesFor(dir: string, urls: string[]): string[] {
  const fixtureDir = join(dir, "fixtures", "llm");
  const matches = readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => {
      const saved = JSON.parse(readFileSync(join(fixtureDir, file), "utf8")) as { text?: string };
      return typeof saved.text === "string" && urls.some((url) => saved.text!.includes(url));
    })
    .map((file) => join(fixtureDir, file));
  assert.ok(matches.length > 0, "no replay fixture matched the brief's receipts");
  return matches;
}

test("the citations gate end to end: a corrupted replay fixture is caught, and restoring is clean", async (t) => {
  await withWorkingCopy((dir) => {
    const first = runCli(dir, ["demo"]);
    assert.equal(first.status, 0, first.stderr);

    const org = ensureReplayBrief(dir, first);
    if (org === null) {
      t.skip("no account could carry a model brief in this fixture set");
      return;
    }
    // Re-run so the (possibly just-minted) fixture is the one that produced the brief.
    assert.equal(runCli(dir, ["demo"]).status, 0);
    const before = decisions(dir).find((d) => d.org === org)!;
    assert.equal(before.brief_mode, "model-replay", "the model path must be live for this test");
    assert.equal(before.llm?.reject_reason, null);

    const originalBrief = readFileSync(join(briefDir(dir, org), `${org}.md`), "utf8");
    const urls = [...originalBrief.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(urls.length >= 3, "a shipped model brief carries at least three receipts");

    // Tamper: swap one receipt for a URL the account's evidence has never seen. The
    // fixture filename is the request hash, so editing the response body does not move it.
    const originals = new Map(fixturesFor(dir, urls).map((file) => [file, readFileSync(file, "utf8")]));
    let changed = 0;
    for (const [file, original] of originals) {
      const saved = JSON.parse(original) as { text: string };
      const corrupted = saved.text.replace(/\]\((https?:[^)]+)\)/, `](${FABRICATED})`);
      if (corrupted !== saved.text) {
        changed++;
        writeFileSync(file, JSON.stringify({ ...saved, text: corrupted }, null, 2) + "\n");
      }
    }
    assert.ok(changed > 0, "at least one replay fixture must actually change");

    assert.equal(runCli(dir, ["demo"]).status, 0);
    const after = decisions(dir).find((d) => d.org === org)!;
    assert.equal(after.brief_mode, "template", "a fabricated citation must not ship");
    assert.equal(after.llm?.reject_reason, `uncited URL not in evidence: ${FABRICATED}`);
    const fallback = readFileSync(join(briefDir(dir, org), `${org}.md`), "utf8");
    assert.ok(!fallback.includes(FABRICATED), "the fabricated URL never reaches the brief");
    assert.ok(fallback.includes("## Production Expo signals"), "the fallback is a real brief");

    // Restore: back to exactly where we started.
    for (const [file, original] of originals) writeFileSync(file, original);
    assert.equal(runCli(dir, ["demo"]).status, 0);
    const restored = decisions(dir).find((d) => d.org === org)!;
    assert.equal(restored.brief_mode, "model-replay");
    assert.equal(restored.llm?.reject_reason, null);
    assert.equal(
      readFileSync(join(briefDir(dir, org), `${org}.md`), "utf8"),
      originalBrief,
      "restoring the fixture restores the brief byte for byte",
    );
  });
});

// --- the eval gate -------------------------------------------------------------------

test("the eval gate fails the command when a metric drops below baseline, and passes once restored", async () => {
  await withWorkingCopy((dir) => {
    const golden = join(dir, "packs", "expo", "golden-set.jsonl");
    const original = readFileSync(golden, "utf8");

    const clean = runCli(dir, ["evals"]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /no regressions/);

    // Tamper the scored world, not the yardstick: one labeled account the fleet cannot
    // find. discover.presence must fall, whatever the current weights say.
    writeFileSync(
      golden,
      original.trimEnd() +
        "\n" +
        JSON.stringify({ org: "ghost-org-regression-probe", verdict: "qualified" }) +
        "\n",
    );
    const regressed = runCli(dir, ["evals"]);
    assert.equal(regressed.status, 1, "a regression must set a non-zero exit code");
    assert.match(regressed.stdout, /^REGRESSION: /m);

    writeFileSync(golden, original);
    const restored = runCli(dir, ["evals"]);
    assert.equal(restored.status, 0);
    assert.match(restored.stdout, /no regressions/);
  });
});

test("a tampered baseline claiming an unreachable score is reported as a regression", async () => {
  await withWorkingCopy((dir) => {
    const baseline = join(dir, "packs", "expo", "evals-baseline.json");
    const original = readFileSync(baseline, "utf8");

    const doctored = JSON.parse(original) as Record<string, number>;
    for (const key of Object.keys(doctored)) doctored[key] = 1.01; // no ratio can reach this
    writeFileSync(baseline, JSON.stringify(doctored, null, 2) + "\n");

    const regressed = runCli(dir, ["evals"]);
    assert.equal(regressed.status, 1);
    const reported = regressed.stdout.split("\n").filter((l) => l.startsWith("REGRESSION:"));
    assert.equal(reported.length, Object.keys(doctored).length, "every metric must be flagged");
    for (const line of reported) assert.match(line, /^REGRESSION: \S+ [\d.]+ < baseline 1\.01$/);

    writeFileSync(baseline, original);
    const restored = runCli(dir, ["evals"]);
    assert.equal(restored.status, 0);
    assert.match(restored.stdout, /no regressions/);
  });
});
