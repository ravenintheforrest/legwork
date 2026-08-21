// The citations gate. Rule 6 says "no source, no sentence"; this file is the proof.
//
// `validateModelBrief` is private to src/agents/brief.ts, which another workstream owns,
// so every case here drives the real agent end to end: a stub model returns a body, the
// agent decides, and the assertion reads the artifact the agent wrote. Nothing is
// asserted about weights, segments, or golden-set size — only about the gate.
//
// The agent writes to a relative `briefs/`, so each case runs chdir'd into a throwaway
// working copy. The suite never sees the repo's own briefs/.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { brief } from "../src/agents/brief.js";
import { PRICES_PER_MTOK } from "../src/costs.js";
import { REPO_ROOT, assertTemp, inDir, removeTemp, workingCopy } from "./helpers/env.js";
import { FailingLLM, StubLLM, account, captureOutput, ctx, evidence } from "./helpers/fleet.js";

const PARTS = ["packs", "registry.yaml"] as const;

const EAS_MAIN = "https://github.com/acme/mobile/blob/main/eas.json";
const EAS_SHA = "https://github.com/acme/mobile/blob/9f2c1ab/eas.json";
const STORE = "https://apps.apple.com/us/app/acme/id1234567890";
const CAREERS = "https://acme.example.com/careers";
const FABRICATED = "https://fabricated.example.com/press-release";

// A body with every section the gate requires. Callers choose which URLs it cites.
function body(urls: string[], opts: { drop?: string } = {}): string {
  const sections: Record<string, string[]> = {
    "## Who": ["Acme builds a consumer mobile app."],
    "## Production Expo signals": urls.map((url, i) => `- signal ${i + 1} ([source](${url}))`),
    "## Who to talk to": ["- Someone on the mobile team."],
    "## Suggested opener": ["Public evidence that Acme builds with Expo."],
  };
  return [
    "# Acme — account brief",
    "",
    ...Object.entries(sections).flatMap(([heading, lines]) =>
      heading === opts.drop ? [] : [heading, ...lines, ""],
    ),
  ].join("\n");
}

function acme(evidenceList = [
  evidence("eas.json in the app repo", EAS_MAIN, "discover"),
  evidence("eas build profiles", EAS_SHA, "qualify"),
  evidence("App Store listing", STORE, "qualify"),
  evidence("React Native roles open", CAREERS, "enrich"),
]) {
  return account({
    org: "acme",
    company: "Acme",
    domain: "acme.example.com",
    stage: "qualified",
    segment: "A",
    confidence: 0.95,
    evidence: evidenceList,
  });
}

/**
 * A working copy whose registry routes `brief` to a priced model. The routing itself is
 * another workstream's to tune; pinning it here keeps the gate under test instead of the
 * price table.
 */
function gateCopy(): string {
  const dir = workingCopy(PARTS);
  const registryPath = join(dir, "registry.yaml");
  const doc = yaml.load(readFileSync(registryPath, "utf8")) as {
    agents: Record<string, Record<string, unknown>>;
  };
  doc.agents.brief!.model = "claude-haiku-4-5";
  doc.agents.brief!.cost_ceiling_usd = 100;
  writeFileSync(registryPath, yaml.dump(doc));
  return dir;
}

interface Decision {
  org: string;
  brief_mode: string;
  review_gate: number;
  llm: { provider: string; reject_reason: string | null } | null;
}

/** The decision record, wherever the confidence gate routed it. */
function decisionFor(dir: string, org: string): { decision: Decision; briefPath: string } {
  for (const sub of ["briefs", join("briefs", "queue")]) {
    const file = join(dir, sub, `${org}.decision.json`);
    if (existsSync(file)) {
      return {
        decision: JSON.parse(readFileSync(file, "utf8")) as Decision,
        briefPath: join(dir, sub, `${org}.md`),
      };
    }
  }
  throw new Error(`no decision.json written for ${org}`);
}

/** Run the brief agent against a stub model inside a disposable working copy. */
async function runGate(
  llm: StubLLM | FailingLLM | null,
  opts: { mode?: "live" | "fixture"; account?: ReturnType<typeof acme> } = {},
): Promise<{ decision: Decision; brief: string; dir: string }> {
  const dir = gateCopy();
  try {
    const target = opts.account ?? acme();
    const out = await inDir(dir, () =>
      captureOutput(() => brief.run([target], ctx({ llm, mode: opts.mode ?? "live" }))),
    );
    assert.equal(out.value.length, 1, "the agent must emit the account it briefed");
    assert.equal(out.value[0]!.stage, "briefed");
    const { decision, briefPath } = decisionFor(dir, target.org);
    return { decision, brief: readFileSync(briefPath, "utf8"), dir };
  } finally {
    removeTemp(dir);
  }
}

test("a well-formed brief citing only the account's evidence is accepted", async () => {
  const { decision, brief: text } = await runGate(new StubLLM(body([EAS_MAIN, STORE, CAREERS])));
  assert.equal(decision.brief_mode, "model");
  assert.equal(decision.llm?.reject_reason, null);
  assert.ok(text.includes("## Suggested opener"));
  assert.ok(text.includes(EAS_MAIN));
});

test("THE GATE: a URL absent from the account's evidence is rejected and never ships", async () => {
  const { decision, brief: text } = await runGate(
    new StubLLM(body([EAS_MAIN, STORE, FABRICATED])),
  );
  assert.equal(decision.brief_mode, "template", "a rejected model brief falls back to the template");
  assert.match(decision.llm?.reject_reason ?? "", /^uncited URL not in evidence: /);
  assert.ok(
    decision.llm!.reject_reason!.includes(FABRICATED),
    "the reason must name the offending URL",
  );
  assert.ok(!text.includes(FABRICATED), "the fabricated URL must not reach the published brief");
  assert.ok(!text.includes("fabricated.example.com"));
  // The fallback is a real brief, not a blank one.
  assert.ok(text.includes("## Production Expo signals"));
  assert.ok(text.includes(EAS_MAIN) || text.includes(EAS_SHA));
});

test("THE GATE: one fabricated URL among many valid ones still fails the whole brief", async () => {
  const { decision } = await runGate(
    new StubLLM(body([EAS_MAIN, EAS_SHA, STORE, CAREERS, FABRICATED])),
  );
  assert.equal(decision.brief_mode, "template");
  assert.ok(decision.llm!.reject_reason!.includes(FABRICATED));
});

test("THE GATE: a near-miss variant of a cited URL is not close enough", async () => {
  // Same host, same repo, same file — one query parameter different. The gate matches
  // evidence URLs exactly; anything looser lets a model invent a line and a fragment.
  const nearMiss = `${EAS_MAIN}?plain=1`;
  const { decision } = await runGate(new StubLLM(body([EAS_MAIN, STORE, nearMiss])));
  assert.equal(decision.brief_mode, "template");
  assert.ok(decision.llm!.reject_reason!.includes(nearMiss));
});

test("THE GATE: an account with no evidence cannot have a model brief accepted", async () => {
  const { decision } = await runGate(new StubLLM(body([EAS_MAIN, STORE, CAREERS])), {
    account: account({ org: "acme", company: "Acme", stage: "qualified", confidence: 0.95, evidence: [] }),
  });
  assert.equal(decision.brief_mode, "template");
  assert.match(decision.llm?.reject_reason ?? "", /uncited URL not in evidence/);
});

test("a brief missing a required section is rejected before its citations are read", async () => {
  const { decision } = await runGate(
    new StubLLM(body([EAS_MAIN, STORE, CAREERS], { drop: "## Suggested opener" })),
  );
  assert.equal(decision.brief_mode, "template");
  assert.equal(decision.llm?.reject_reason, "missing section: ## Suggested opener");
});

test("fewer than three receipts is rejected", async () => {
  const { decision } = await runGate(new StubLLM(body([EAS_MAIN, STORE])));
  assert.equal(decision.brief_mode, "template");
  assert.equal(decision.llm?.reject_reason, "fewer than 3 receipts");
});

test("the fixture banner is injected in fixture mode only", async () => {
  const accepted = body([EAS_MAIN, STORE, CAREERS]);
  const live = await runGate(new StubLLM(accepted), { mode: "live" });
  assert.equal(live.decision.brief_mode, "model");
  assert.ok(!live.brief.includes("FIXTURE DATA"), "a live brief carries no fixture banner");

  const fixture = await runGate(new StubLLM(accepted), { mode: "fixture" });
  assert.equal(fixture.decision.brief_mode, "model");
  assert.ok(fixture.brief.includes("FIXTURE DATA"), "a fixture brief must say so");
  // The banner goes under the title, not above it.
  assert.match(fixture.brief.split("\n")[0]!, /^# /);
});

test("a failing provider falls back to the template and says so, without crashing", async () => {
  const { decision, brief: text } = await runGate(new FailingLLM());
  assert.equal(decision.brief_mode, "template");
  assert.equal(decision.llm, null);
  assert.ok(text.includes("## Production Expo signals"));
});

test("with no model at all the brief is the deterministic template", async () => {
  const first = await runGate(null);
  const second = await runGate(null);
  assert.equal(first.decision.brief_mode, "template");
  assert.equal(first.brief, second.brief, "the template path must be byte-deterministic");
});

// --- receipt-URL canonicalization (observed through the template renderer) -----------

test("branch and commit-sha refs of the same file collapse to one bullet", async () => {
  const claim = "eas.json declares build profiles";
  const { brief: text } = await runGate(null, {
    account: acme([
      evidence(claim, EAS_MAIN, "discover"),
      evidence(claim, EAS_SHA, "qualify"),
      evidence("App Store listing", STORE, "qualify"),
    ]),
  });
  const bullets = text.split("\n").filter((line) => line.startsWith(`- ${claim} (`));
  assert.equal(bullets.length, 1, "the same claim behind two github refs is one receipt");
  // First seen wins and renders its original URL — qualify's receipts are ordered first.
  assert.ok(bullets[0]!.includes(EAS_SHA), `expected the first-seen url, got: ${bullets[0]}`);
});

test("the same claim at genuinely different github paths stays two bullets", async () => {
  const claim = "expo config present";
  const other = "https://github.com/acme/mobile/blob/main/app.json";
  const { brief: text } = await runGate(null, {
    account: acme([
      evidence(claim, EAS_MAIN, "qualify"),
      evidence(claim, other, "qualify"),
      evidence("App Store listing", STORE, "qualify"),
    ]),
  });
  const bullets = text.split("\n").filter((line) => line.startsWith(`- ${claim} (`));
  assert.equal(bullets.length, 2);
});

test("a non-GitHub URL is left untouched and never collapsed", async () => {
  const claim = "hiring React Native engineers";
  const gitlab = "https://gitlab.com/acme/mobile/-/blob/main/eas.json";
  const { brief: text } = await runGate(null, {
    account: acme([
      evidence(claim, CAREERS, "enrich"),
      evidence("eas.json on GitLab", gitlab, "discover"),
      evidence("App Store listing", STORE, "qualify"),
    ]),
  });
  assert.ok(text.includes(CAREERS), "the careers URL renders exactly as supplied");
  assert.ok(text.includes(gitlab), "a gitlab blob URL is not a github ref and is not rewritten");
});

test("the store's two-claims-one-URL pair both survive", async () => {
  const { brief: text } = await runGate(null, {
    account: acme([
      evidence("4.6 stars across 12k ratings", STORE, "qualify"),
      evidence("shipped 9 updates in 90 days", STORE, "qualify"),
      evidence("eas.json in the app repo", EAS_MAIN, "discover"),
    ]),
  });
  assert.ok(text.includes("4.6 stars across 12k ratings"));
  assert.ok(text.includes("shipped 9 updates in 90 days"));
});

test("the working-copy guard refuses to run anywhere but a temp directory", () => {
  assert.throws(() => assertTemp(REPO_ROOT), /refusing to operate outside the temp root/);
  assert.ok(PRICES_PER_MTOK["claude-haiku-4-5"], "the pinned test model must stay priced");
});
