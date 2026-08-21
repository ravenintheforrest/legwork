import assert from "node:assert/strict";
import test from "node:test";
import { CostCeilingError, CostMeter, PRICES_PER_MTOK } from "../src/costs.js";

const MODEL = "claude-haiku-4-5";
const PRICE = PRICES_PER_MTOK[MODEL]!;

test("the meter accumulates tokens and dollars", () => {
  const meter = new CostMeter(1);
  meter.charge(MODEL, 1_000, 2_000);
  meter.charge(MODEL, 500, 0);
  assert.equal(meter.tokensIn, 1_500);
  assert.equal(meter.tokensOut, 2_000);
  const expected = (1_500 / 1e6) * PRICE.in + (2_000 / 1e6) * PRICE.out;
  assert.ok(Math.abs(meter.costUsd - expected) < 1e-12);
});

test("the kill fires past the ceiling, not at it", () => {
  // Spend exactly the ceiling: allowed. The rule is `>`, so the boundary itself is legal.
  const exact = (1e6 / PRICE.in) * 0.25; // input tokens worth exactly $0.25
  const meter = new CostMeter(0.25);
  meter.charge(MODEL, exact, 0);
  assert.ok(Math.abs(meter.costUsd - 0.25) < 1e-9, "landing on the ceiling must not throw");

  assert.throws(() => meter.charge(MODEL, 1, 0), CostCeilingError);
});

test("a cost kill reports both numbers so the operator can retune the ceiling", () => {
  const meter = new CostMeter(0.001);
  assert.throws(
    () => meter.charge(MODEL, 1_000_000, 1_000_000),
    (err: Error) =>
      err instanceof CostCeilingError &&
      err.name === "CostCeilingError" &&
      /cost ceiling exceeded/.test(err.message) &&
      /\$0\.001?0?/.test(err.message),
  );
});

test("charges before the ceiling are recorded even though the last one throws", () => {
  const meter = new CostMeter(0.01);
  meter.charge(MODEL, 1_000, 1_000);
  const before = meter.costUsd;
  assert.throws(() => meter.charge(MODEL, 10_000_000, 0), CostCeilingError);
  assert.ok(meter.costUsd > before, "the overrunning charge is still metered before the kill");
});

test("an unpriced model refuses rather than billing blind", () => {
  const meter = new CostMeter(10);
  assert.throws(() => meter.charge("some-model-nobody-priced", 1, 1), /no price for model/);
  assert.equal(meter.costUsd, 0);
});

test("every model the registry can route to has a price", async () => {
  const { loadRegistry, effective } = await import("../src/registry.js");
  const { REPO_ROOT } = await import("./helpers/env.js");
  const { join } = await import("node:path");
  const reg = loadRegistry(join(REPO_ROOT, "registry.yaml"));
  for (const agent of Object.keys(reg.agents)) {
    const { model } = effective(reg, agent);
    assert.ok(PRICES_PER_MTOK[model], `${agent} routes to "${model}", which has no price`);
  }
});
