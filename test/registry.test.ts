import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { effective, loadRegistry } from "../src/registry.js";
import { REPO_ROOT, withTempDir } from "./helpers/env.js";

const REAL_REGISTRY = join(REPO_ROOT, "registry.yaml");

function base(): Record<string, unknown> {
  return {
    pack: "packs/test",
    defaults: { model: "claude-haiku-4-5", cost_ceiling_usd: 0.5, autonomy: "propose" },
    agents: { alpha: { does: "a thing", output: "accounts.jsonl" } },
    loops: { eval: { trigger: "per_run" } },
    sources: { notify: { adapter: "stdout" } },
    autonomy_tiers: { human: ["deleting_data"] },
  };
}

async function withRegistry<T>(doc: unknown, fn: (path: string) => T): Promise<T> {
  return withTempDir((dir) => {
    const path = join(dir, "registry.yaml");
    writeFileSync(path, yaml.dump(doc));
    return fn(path);
  });
}

test("the shipped registry loads and every agent resolves an effective config", () => {
  const reg = loadRegistry(REAL_REGISTRY);
  assert.ok(reg.pack.length > 0, "pack must be set");
  assert.ok(Object.keys(reg.agents).length > 0, "the fleet must have agents");
  for (const name of Object.keys(reg.agents)) {
    const config = effective(reg, name);
    assert.equal(typeof config.model, "string");
    assert.ok(config.model.length > 0);
    assert.ok(config.costCeilingUsd > 0, `${name} needs a positive ceiling`);
    assert.ok(["fix", "propose", "human"].includes(config.autonomy));
  }
});

test("an unknown key on an agent is a typo, not a feature (strict schema)", async () => {
  const doc = base();
  (doc.agents as Record<string, Record<string, unknown>>).alpha!.modle = "claude-haiku-4-5";
  await withRegistry(doc, (path) => {
    assert.throws(
      () => loadRegistry(path),
      (err: Error) => /agents\.alpha/.test(err.message) && /invalid|Unrecognized/i.test(err.message),
    );
  });
});

test("a missing required field names the field and the file", async () => {
  const doc = base();
  delete (doc.agents as Record<string, Record<string, unknown>>).alpha!.output;
  await withRegistry(doc, (path) => {
    assert.throws(
      () => loadRegistry(path),
      (err: Error) => err.message.includes(path) && err.message.includes("agents.alpha.output"),
    );
  });
});

test("an unknown autonomy tier is rejected", async () => {
  const doc = base();
  (doc.defaults as Record<string, unknown>).autonomy = "yolo";
  await withRegistry(doc, (path) => {
    assert.throws(() => loadRegistry(path), /defaults\.autonomy/);
  });
});

test("effective() merges defaults with per-unit overrides", async () => {
  const doc = base();
  doc.agents = {
    inherits: { does: "x", output: "y" },
    overrides: {
      does: "x",
      output: "y",
      model: "claude-opus-5",
      cost_ceiling_usd: 2,
      autonomy: "human",
    },
  };
  await withRegistry(doc, (path) => {
    const reg = loadRegistry(path);
    assert.deepEqual(effective(reg, "inherits"), {
      model: "claude-haiku-4-5",
      costCeilingUsd: 0.5,
      autonomy: "propose",
    });
    assert.deepEqual(effective(reg, "overrides"), {
      model: "claude-opus-5",
      costCeilingUsd: 2,
      autonomy: "human",
    });
  });
});

test("effective() on an unknown agent explains itself", () => {
  const reg = loadRegistry(REAL_REGISTRY);
  assert.throws(() => effective(reg, "no-such-agent"), /no agent "no-such-agent"/);
});
