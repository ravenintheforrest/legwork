import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { isPublicIp } from "../src/netguard.js";
import { CachedFetch } from "../src/web.js";
import { FileLockError, withFileLockAsync } from "../src/filelock.js";
import { loadAccounts, saveAccounts } from "../src/store.js";
import { readRuns } from "../src/runlog.js";
import { runPipeline } from "../src/runner.js";
import type { Account, AgentDef } from "../src/types.js";
import type { LLMRequest, LLMResponse } from "../src/llm.js";
import { account, ctx } from "./helpers/fleet.js";
import { people } from "../src/agents/people.js";
import { loadDotEnv } from "../src/env.js";
import type { GitHubClient } from "../src/gh.js";
import { inDir, withTempDir, withWorkingCopy } from "./helpers/env.js";

test("private, loopback, link-local, documentation, and reserved addresses are refused", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.2.1", "198.51.100.2", "203.0.113.9", "224.0.0.1",
    "::1", "fc00::1", "fe80::1", "2001:db8::1",
  ]) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("redirects are revalidated and cannot reach a private address", async () => {
  await withTempDir(async (dir) => {
    const prior = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
    };
    try {
      const client = new CachedFetch(dir);
      await assert.rejects(() => client.json("https://8.8.8.8/start"), /private or reserved/);
      assert.equal(calls, 1, "the private redirect target must never be fetched");
    } finally {
      globalThis.fetch = prior;
    }
  });
});

test("fresh cache entries are reused and stale entries are revalidated", async () => {
  await withTempDir(async (dir) => {
    const url = "https://8.8.8.8/value";
    const file = join(dir, createHash("sha256").update(url).digest("hex") + ".json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ url, fetched_at: new Date().toISOString(), status: 200, body: { value: "fresh" } }));
    const client = new CachedFetch(dir);
    const prior = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ value: "revalidated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      assert.deepEqual(await client.json(url, {}, 60_000), { value: "fresh" });
      assert.equal(calls, 0);
      writeFileSync(file, JSON.stringify({ url, fetched_at: "2000-01-01T00:00:00.000Z", status: 200, body: { value: "stale" } }));
      assert.deepEqual(await client.json(url, {}, 60_000), { value: "revalidated" });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = prior;
    }
  });
});

test("a concurrent writer is refused and a stale lock is recoverable", async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, "accounts.lock");
    let release = () => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const held = withFileLockAsync(lock, async () => waiting);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => withFileLockAsync(lock, async () => undefined), FileLockError);
    release();
    await held;

    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, acquired: "2000-01-01T00:00:00.000Z" }));
    const result = await withFileLockAsync(lock, async () => "recovered", 1);
    assert.equal(result, "recovered");
    assert.equal(existsSync(lock), false);
  });
});

test(".env loads absent values but never overrides the process environment", async () => {
  await withTempDir((dir) => {
    const file = join(dir, ".env");
    writeFileSync(file, "LEGWORK_ENV_NEW=from-file\nLEGWORK_ENV_EXISTING=from-file\n");
    const beforeNew = process.env.LEGWORK_ENV_NEW;
    const beforeExisting = process.env.LEGWORK_ENV_EXISTING;
    delete process.env.LEGWORK_ENV_NEW;
    process.env.LEGWORK_ENV_EXISTING = "from-process";
    try {
      loadDotEnv(file);
      assert.equal(process.env.LEGWORK_ENV_NEW, "from-file");
      assert.equal(process.env.LEGWORK_ENV_EXISTING, "from-process");
    } finally {
      if (beforeNew === undefined) delete process.env.LEGWORK_ENV_NEW;
      else process.env.LEGWORK_ENV_NEW = beforeNew;
      if (beforeExisting === undefined) delete process.env.LEGWORK_ENV_EXISTING;
      else process.env.LEGWORK_ENV_EXISTING = beforeExisting;
    }
  });
});

test("live agents that do not use GitHub code search do not require GITHUB_TOKEN", async () => {
  await withTempDir(async (dir) => {
    const prior = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const agent: AgentDef = { name: "qualify", async run() { return []; } };
      const summary = await runPipeline({
        mode: "live", agent: "qualify", sinceDays: 7, dataDir: dir, agents: { qualify: agent }, llm: null,
      });
      assert.equal(summary.agents[0]?.outcome, "ok");
    } finally {
      if (prior !== undefined) process.env.GITHUB_TOKEN = prior;
    }
  });
});

test("people enrichment omits location and free-text bio unless explicitly opted in", async () => {
  const context = ctx();
  context.gh = {
    async contributors() {
      return [{ login: "dev", html_url: "https://github.com/dev", contributions: 12, type: "User" }];
    },
    async user() {
      return {
        login: "dev",
        html_url: "https://github.com/dev",
        name: "Dev",
        company: "Acme",
        blog: "https://dev.example",
        location: "Private City",
        bio: "Personal biography",
      };
    },
  } as unknown as GitHubClient;
  const prior = process.env.LEGWORK_INCLUDE_PERSONAL_PROFILE_FIELDS;
  delete process.env.LEGWORK_INCLUDE_PERSONAL_PROFILE_FIELDS;
  try {
    const [result] = await people.run([account({ org: "acme", repos: ["acme/app"] })], context);
    const claims = result?.evidence.map((item) => item.claim).join("\n") ?? "";
    assert.match(claims, /company 'Acme'/);
    assert.match(claims, /website https:\/\/dev\.example/);
    assert.doesNotMatch(claims, /Private City|Personal biography/);
  } finally {
    if (prior !== undefined) process.env.LEGWORK_INCLUDE_PERSONAL_PROFILE_FIELDS = prior;
  }
});

test("malformed JSONL is skipped while healthy account and run records remain readable", async () => {
  await withTempDir((dir) => {
    const accountsFile = join(dir, "accounts.jsonl");
    const runsFile = join(dir, "runs.jsonl");
    writeFileSync(accountsFile, JSON.stringify(account({ org: "alpha" })) + "\n{torn\n" + JSON.stringify(account({ org: "bravo" })) + "\n");
    writeFileSync(runsFile, '{"id":"one","agent":"discover","started":"x","duration_ms":1,"inputs":0,"outputs":0,"tokens_in":0,"tokens_out":0,"cost_usd":0,"outcome":"ok"}\nnot-json\n');
    assert.deepEqual(loadAccounts(accountsFile).map((item) => item.org), ["alpha", "bravo"]);
    assert.equal(readRuns(runsFile).length, 1);
  });
});

test("a live-style second full run refreshes known accounts and regenerates briefs", async () => {
  await withTempDir(async (dir) => {
    let briefs = 0;
    const steps = ["discover", "discover-jobs", "discover-issues", "discover-gitlab", "resolve", "enrich", "dedupe", "qualify", "intent", "people", "brief"];
    const agents: Record<string, AgentDef> = Object.fromEntries(steps.map((name) => [name, {
      name,
      async run(input: Account[]): Promise<Account[]> {
        if (name === "discover" && input.length === 0) return [account({ org: "alpha", stage: "discovered" })];
        if (name === "resolve") return input.filter((item) => item.stage === "discovered").map((item) => ({ ...item, stage: "resolved" as const }));
        if (name === "enrich") return input.filter((item) => item.stage === "resolved").map((item) => ({ ...item, stage: "enriched" as const }));
        if (name === "qualify") return input.filter((item) => item.stage === "enriched").map((item) => ({ ...item, stage: "qualified" as const }));
        if (name === "brief") {
          const next = input.filter((item) => item.stage === "qualified").map((item) => ({ ...item, stage: "briefed" as const }));
          briefs += next.length;
          return next;
        }
        return [];
      },
    }]));
    await runPipeline({ mode: "fixture", sinceDays: 7, dataDir: dir, agents, llm: null });
    await runPipeline({ mode: "fixture", sinceDays: 7, dataDir: dir, agents, llm: null, refreshKnown: true });
    assert.equal(briefs, 2);
    assert.equal(loadAccounts(join(dir, "accounts.jsonl"))[0]?.stage, "briefed");
  });
});

test("cost kill stops later model calls and records the killed outcome without partial briefs", async () => {
  await withWorkingCopy(async (dir) => {
    const registryFile = join(dir, "registry.yaml");
    const registry = yaml.load(readFileSync(registryFile, "utf8")) as { agents: Record<string, Record<string, unknown>> };
    registry.agents.brief!.model = "claude-haiku-4-5";
    registry.agents.brief!.cost_ceiling_usd = 0.000001;
    writeFileSync(registryFile, yaml.dump(registry));
    mkdirSync(join(dir, "data"), { recursive: true });
    saveAccounts([
      account({ org: "alpha", stage: "qualified", confidence: 0.9 }),
      account({ org: "bravo", stage: "qualified", confidence: 0.9 }),
    ], join(dir, "data", "accounts.jsonl"));
    let calls = 0;
    const llm = {
      kind: "api" as const,
      async complete(_req: LLMRequest): Promise<LLMResponse> {
        calls++;
        return { text: "# unused", tokens_in: 10, tokens_out: 10 };
      },
    };
    const summary = await inDir(dir, () => runPipeline({
      mode: "fixture", agent: "brief", sinceDays: 7, dataDir: "data", registryPath: "registry.yaml", llm,
    }));
    assert.equal(calls, 1);
    assert.equal(summary.agents[0]?.outcome, "killed_cost_ceiling");
    assert.equal(existsSync(join(dir, "briefs", "alpha.md")), false);
    assert.equal(loadAccounts(join(dir, "data", "accounts.jsonl")).every((item) => item.stage === "qualified"), true);
  });
});

test("retry attempts accumulate in one run cost meter", async () => {
  await withTempDir(async (dir) => {
    const failing: AgentDef = {
      name: "brief",
      async run(_input, ctx): Promise<Account[]> {
        ctx.costs.charge("claude-haiku-4-5", 10, 0);
        throw new Error("retry me");
      },
    };
    const summary = await runPipeline({
      mode: "fixture", agent: "brief", sinceDays: 7, dataDir: dir, agents: { brief: failing }, llm: null,
    });
    assert.equal(summary.agents[0]?.outcome, "error");
    assert.equal(summary.agents[0]?.tokens_in, 30);
  });
});
