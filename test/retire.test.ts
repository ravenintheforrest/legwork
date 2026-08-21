// Retirement is marginal-contribution math over the fleet's own run history. The
// threshold is registry config (rule 8), so these cases move the threshold rather than
// the data and check the verdict follows.
//
// runRetire hardcodes memos/ and data/, and it belongs to no one this week, so each case
// runs chdir'd into a throwaway directory holding a synthetic registry and run log.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { runRetire } from "../src/retire.js";
import { inDir, withTempDir } from "./helpers/env.js";
import { NOW, account, captureOutput, evidence } from "./helpers/fleet.js";
import type { Account, RunRecord } from "../src/types.js";

function registryDoc(threshold: number): unknown {
  return {
    pack: "packs/expo",
    defaults: { model: "claude-haiku-4-5", cost_ceiling_usd: 0.5, autonomy: "propose" },
    agents: {
      discover: { does: "find repos depending on Expo", output: "candidates.jsonl" },
      "discover-gitlab": {
        does: "probe GitLab public projects",
        output: "candidates.jsonl",
        hypothesis: "public mobile repos on GitLab are rare",
      },
    },
    loops: { retirement: { trigger: "monthly", candidate_threshold: threshold } },
    sources: { notify: { adapter: "stdout" } },
    autonomy_tiers: { human: ["retiring_an_agent"] },
  };
}

function run(agent: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `r-test-${agent}`,
    agent,
    started: NOW,
    duration_ms: 100,
    inputs: 0,
    outputs: 1,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    mode: "fixture",
    outcome: "ok",
    ...overrides,
  };
}

/**
 * Five briefed accounts. `gitlabUnique` of them were discovered by discover-gitlab alone,
 * the rest by discover alone — so discover-gitlab's marginal share is gitlabUnique/5.
 */
function fleet(gitlabUnique: number): Account[] {
  return Array.from({ length: 5 }, (_, i) => {
    const sole = i < gitlabUnique ? "discover-gitlab" : "discover";
    return account({
      org: `org-${i}`,
      stage: "briefed",
      evidence: [evidence(`found by ${sole}`, `https://example.com/${i}`, sole)],
    });
  });
}

async function retireIn(
  opts: { threshold: number; accounts: Account[]; runs: RunRecord[]; agent: string },
): Promise<{ out: string; memo: string; dir: string }> {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, "registry.yaml"), yaml.dump(registryDoc(opts.threshold)));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "data", "accounts.jsonl"),
      opts.accounts.map((a) => JSON.stringify(a)).join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "data", "runs.jsonl"),
      opts.runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const { out } = await inDir(dir, () => captureOutput(() => runRetire(opts.agent)));
    const memoPath = join(dir, "memos", `retire-${opts.agent}.md`);
    assert.ok(existsSync(memoPath), "the memo is the artifact — it must be written");
    return { out, memo: readFileSync(memoPath, "utf8"), dir };
  });
}

test("an agent whose accounts all reach briefs is a keep", async () => {
  const { memo } = await retireIn({
    threshold: 0.5,
    accounts: fleet(0), // discover solely discovered all five
    runs: [run("discover"), run("discover-gitlab")],
    agent: "discover",
  });
  assert.match(memo, /verdict: \*\*KEEP\*\*/);
  assert.match(memo, /\*\*5 briefs would not exist without it\*\* \(of 5 total\)/);
  assert.match(memo, /marginal contribution: 100\.0%/);
});

test("an agent contributing nothing marginal is a retire, with the reasoning shown", async () => {
  const { memo, out } = await retireIn({
    threshold: 0.5,
    accounts: fleet(0), // discover-gitlab discovered none of them uniquely
    runs: [run("discover"), run("discover-gitlab")],
    agent: "discover-gitlab",
  });
  assert.match(memo, /verdict: \*\*RETIRE\*\*/);
  assert.match(memo, /\*\*0 briefs would not exist without it\*\* \(of 5 total\)/);
  assert.match(memo, /marginal contribution: 0\.0% vs\. retirement threshold 50%/);
  // Retiring is human-tier: the command recommends, a person merges the PR.
  assert.match(memo, /human-tier/);
  assert.match(out, /open a PR removing "discover-gitlab"/);
});

test("the threshold comes from the registry, not from the code", async () => {
  const accounts = fleet(2); // discover-gitlab uniquely discovered 2 of 5 briefed = 40%
  const runs = [run("discover"), run("discover-gitlab")];

  const strict = await retireIn({ threshold: 0.5, accounts, runs, agent: "discover-gitlab" });
  assert.match(strict.memo, /verdict: \*\*RETIRE\*\*/);
  assert.match(strict.memo, /marginal contribution: 40\.0% vs\. retirement threshold 50%/);

  const lenient = await retireIn({ threshold: 0.3, accounts, runs, agent: "discover-gitlab" });
  assert.match(lenient.memo, /verdict: \*\*KEEP\*\*/);
  assert.match(lenient.memo, /marginal contribution: 40\.0% vs\. retirement threshold 30%/);
});

test("the memo reports the hypothesis the registry recorded", async () => {
  const { memo } = await retireIn({
    threshold: 0.5,
    accounts: fleet(0),
    runs: [run("discover-gitlab")],
    agent: "discover-gitlab",
  });
  assert.match(memo, /## What we expected/);
  assert.match(memo, /public mobile repos on GitLab are rare/);
});

test("cost and run counts in the memo come from the run log", async () => {
  const { memo } = await retireIn({
    threshold: 0.5,
    accounts: fleet(5),
    runs: [
      run("discover", { cost_usd: 0.01, duration_ms: 1_000, outputs: 3 }),
      run("discover", { cost_usd: 0.02, duration_ms: 3_000, outputs: 4, outcome: "error", error: "boom" }),
      run("discover-gitlab", { duration_ms: 1_000 }),
    ],
    agent: "discover",
  });
  assert.match(memo, /- 2 runs \(0 live\), 1 ok, 1 failed/);
  assert.match(memo, /- 4\.0s total runtime — 80% of all pipeline time/);
  assert.match(memo, /- \$0\.0300 in model spend/);
  assert.match(memo, /- 7 records emitted across all runs/);
});

test("an agent with no run history is not judged", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "registry.yaml"), yaml.dump(registryDoc(0.05)));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "runs.jsonl"), JSON.stringify(run("discover")) + "\n");
    writeFileSync(join(dir, "data", "accounts.jsonl"), "");
    await inDir(dir, () => {
      assert.throws(() => runRetire("discover-gitlab"), /no run history for "discover-gitlab"/);
      assert.throws(() => runRetire("not-an-agent"), /no agent "not-an-agent"/);
    });
    assert.equal(existsSync(join(dir, "memos")), false, "a refused judgement writes no memo");
  });
});
