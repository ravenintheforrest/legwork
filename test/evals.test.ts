// The eval gate. Scores are tuning and belong to another workstream, so nothing here
// asserts a weight, a segment letter, or a golden-row count. Instead the synthetic
// golden set names orgs the fixtures cannot possibly contain, which makes every
// correct/total in the table arithmetic rather than tuning.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runEvals } from "../src/evals.js";
import { REPO_ROOT, withTempDir } from "./helpers/env.js";
import { captureOutput } from "./helpers/fleet.js";

const REGISTRY = join(REPO_ROOT, "registry.yaml");
const REAL_GOLDEN = join(REPO_ROOT, "packs", "expo", "golden-set.jsonl");

// Three orgs that do not exist in any fixture. Their outcomes are therefore fixed:
// "exclude" is scored correct (absent and meant to be), the other two are scored
// against an account that is not there.
const GHOSTS = [
  { org: "ghost-org-excluded-xyz", verdict: "exclude" },
  { org: "ghost-org-qualified-xyz", verdict: "qualified" },
  { org: "ghost-org-unqualified-xyz", verdict: "unqualified" },
];

interface Row {
  label: string;
  score: string;
  ratio: number;
  correct: number;
  total: number;
}

function parseTable(out: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of out.split("\n")) {
    const match = /^(\S+\.\S+)\s+(\d+)\/(\d+)\s+([\d.]+)\s+/.exec(line.trim());
    if (!match) continue;
    rows.set(match[1]!, {
      label: match[1]!,
      score: `${match[2]}/${match[3]}`,
      correct: Number(match[2]),
      total: Number(match[3]),
      ratio: Number(match[4]),
    });
  }
  return rows;
}

async function evalRun(opts: { goldenPath: string; baselinePath: string }): Promise<{
  out: string;
  exitCode: number;
  rows: Map<string, Row>;
}> {
  const prior = process.exitCode;
  process.exitCode = 0;
  try {
    const { out } = await captureOutput(() =>
      runEvals({ registryPath: REGISTRY, goldenPath: opts.goldenPath, baselinePath: opts.baselinePath }),
    );
    return { out, exitCode: Number(process.exitCode ?? 0), rows: parseTable(out) };
  } finally {
    process.exitCode = prior;
  }
}

function writeGolden(dir: string, rows: unknown[]): string {
  const path = join(dir, "golden-set.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("the scorer counts correct/total exactly on a synthetic golden set", async () => {
  await withTempDir(async (dir) => {
    const goldenPath = writeGolden(dir, GHOSTS);
    const baselinePath = join(dir, "baseline.json");
    const { rows, out } = await evalRun({ goldenPath, baselinePath });

    // presence: only the "exclude" row is right, because none of the three exist.
    assert.equal(rows.get("discover.presence")?.score, "1/3", out);
    // verdict: "unqualified" is right by absence; "qualified" is wrong.
    assert.equal(rows.get("qualify.verdict")?.score, "1/2", out);
    // explanation: an absent account has no decision record to reconcile.
    assert.equal(rows.get("qualify.explanation")?.score, "0/2", out);
    // people: a row labeled qualified must have a person attached; a ghost has none.
    assert.equal(rows.get("people.presence")?.score, "0/1", out);
    // no row carried a domain or a segment, so those metrics have nothing to score.
    assert.equal(rows.get("resolve.domain")?.total, 0);
    assert.equal(rows.get("qualify.segment")?.total, 0);
  });
});

test("every printed ratio equals correct/total, and correct never exceeds total", async () => {
  await withTempDir(async (dir) => {
    const { rows, out } = await evalRun({
      goldenPath: REAL_GOLDEN,
      baselinePath: join(dir, "baseline.json"),
    });
    assert.ok(rows.size >= 6, `expected a metric table, got:\n${out}`);
    for (const row of rows.values()) {
      assert.ok(row.correct <= row.total, `${row.label}: ${row.score} is impossible`);
      const expected = row.total === 0 ? 1 : row.correct / row.total;
      assert.ok(
        Math.abs(row.ratio - expected) < 0.005,
        `${row.label}: printed ${row.ratio}, but ${row.score} is ${expected.toFixed(2)}`,
      );
    }
  });
});

test("a missing baseline is written, not treated as a regression", async () => {
  await withTempDir(async (dir) => {
    const goldenPath = writeGolden(dir, GHOSTS);
    const baselinePath = join(dir, "nested", "baseline.json");
    const { out, exitCode } = await evalRun({ goldenPath, baselinePath });
    assert.match(out, /no baseline found — wrote one/);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(baselinePath));
    const written = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
    assert.ok(Object.keys(written).length > 0);
    for (const value of Object.values(written)) assert.ok(value >= 0 && value <= 1);
  });
});

test("a score below baseline is a regression with a non-zero exit code, and restoring is clean", async () => {
  await withTempDir(async (dir) => {
    const goldenPath = writeGolden(dir, GHOSTS);
    const baselinePath = join(dir, "baseline.json");

    // 1. establish the honest baseline
    await evalRun({ goldenPath, baselinePath });
    const honest = readFileSync(baselinePath, "utf8");

    // 2. clean run against it
    const clean = await evalRun({ goldenPath, baselinePath });
    assert.match(clean.out, /no regressions/);
    assert.equal(clean.exitCode, 0);

    // 3. tamper: claim every metric used to be perfect
    const tampered = JSON.parse(honest) as Record<string, number>;
    for (const key of Object.keys(tampered)) tampered[key] = 1;
    writeFileSync(baselinePath, JSON.stringify(tampered, null, 2));

    const regressed = await evalRun({ goldenPath, baselinePath });
    const reported = regressed.out.split("\n").filter((l) => l.startsWith("REGRESSION:"));
    assert.ok(reported.length > 0, `expected regressions, got:\n${regressed.out}`);
    assert.equal(regressed.exitCode, 1, "a regression must fail the command, and therefore CI");
    for (const line of reported) {
      assert.match(line, /^REGRESSION: \S+ [\d.]+ < baseline [\d.]+$/);
    }

    // 4. restore
    writeFileSync(baselinePath, honest);
    const restored = await evalRun({ goldenPath, baselinePath });
    assert.match(restored.out, /no regressions/);
    assert.equal(restored.exitCode, 0);
  });
});

test("--update-baseline accepts the current scores", async () => {
  await withTempDir(async (dir) => {
    const goldenPath = writeGolden(dir, GHOSTS);
    const baselinePath = join(dir, "baseline.json");
    await evalRun({ goldenPath, baselinePath });
    writeFileSync(baselinePath, JSON.stringify({ discover: 1, qualify_verdict: 1 }, null, 2));

    const prior = process.exitCode;
    process.exitCode = 0;
    try {
      const { out } = await captureOutput(() =>
        runEvals({
          registryPath: REGISTRY,
          goldenPath,
          baselinePath,
          updateBaseline: true,
        }),
      );
      assert.match(out, /baseline updated/);
      assert.equal(Number(process.exitCode ?? 0), 0);
    } finally {
      process.exitCode = prior;
    }
    const after = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
    assert.equal(after.discover, 1 / 3);
  });
});

test("a missing golden set is a clear error, not a silent pass", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () =>
        runEvals({
          registryPath: REGISTRY,
          goldenPath: join(dir, "not-here.jsonl"),
          baselinePath: join(dir, "baseline.json"),
        }),
      /no golden set at/,
    );
  });
});
