import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ReplayLLM,
  RecordingLLM,
  ReplayMissError,
  requestKey,
  type LLM,
  type LLMRequest,
  type LLMResponse,
} from "../src/llm.js";
import { withTempDir } from "./helpers/env.js";

function req(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "claude-haiku-4-5",
    system: "you are a brief writer",
    prompt: "write a brief for acme",
    maxTokens: 1200,
    ...overrides,
  };
}

test("requestKey is stable for identical requests", () => {
  assert.equal(requestKey(req()), requestKey(req()));
  assert.match(requestKey(req()), /^[0-9a-f]{16}$/);
});

test("requestKey changes when the prompt, system, or model changes", () => {
  const base = requestKey(req());
  assert.notEqual(base, requestKey(req({ prompt: "write a brief for globex" })));
  assert.notEqual(base, requestKey(req({ system: "you are terse" })));
  assert.notEqual(base, requestKey(req({ model: "claude-opus-5" })));
});

test("requestKey ignores maxTokens — it does not change the response text", () => {
  assert.equal(requestKey(req()), requestKey(req({ maxTokens: 4000 })));
});

test("the key cannot be forged by shifting text across fields", () => {
  // The hash separates fields, so "ab"+"c" and "a"+"bc" must not collide.
  assert.notEqual(
    requestKey(req({ system: "ab", prompt: "c" })),
    requestKey(req({ system: "a", prompt: "bc" })),
  );
});

test("a replay hit returns the recorded fixture", async () => {
  await withTempDir(async (dir) => {
    const request = req();
    writeFileSync(
      join(dir, `${requestKey(request)}.json`),
      JSON.stringify({ model: request.model, text: "# Acme — account brief", tokens_in: 900, tokens_out: 400 }),
    );
    const llm = new ReplayLLM(dir);
    assert.equal(llm.kind, "replay");
    assert.deepEqual(await llm.complete(request), {
      text: "# Acme — account brief",
      tokens_in: 900,
      tokens_out: 400,
    });
  });
});

test("a replay miss throws ReplayMissError and names the missing key", async () => {
  await withTempDir(async (dir) => {
    const request = req({ prompt: "nothing was ever recorded for this" });
    const llm = new ReplayLLM(dir);
    await assert.rejects(
      () => llm.complete(request),
      (err: Error) => err instanceof ReplayMissError && err.message.includes(requestKey(request)),
    );
  });
});

test("RecordingLLM writes a fixture whose key round-trips through ReplayLLM", async () => {
  await withTempDir(async (dir) => {
    const fixtures = join(dir, "llm");
    mkdirSync(fixtures, { recursive: true });

    const inner: LLM = {
      kind: "api",
      async complete(): Promise<LLMResponse> {
        return { text: "recorded body", tokens_in: 11, tokens_out: 22 };
      },
    };
    const recorder = new RecordingLLM(inner, fixtures);
    assert.equal(recorder.kind, "api", "the recorder reports its inner provider's kind");

    const request = req({ prompt: "record me" });
    const live = await recorder.complete(request);
    assert.deepEqual(live, { text: "recorded body", tokens_in: 11, tokens_out: 22 });

    // The file lands under the request key...
    const file = join(fixtures, `${requestKey(request)}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(saved.model, request.model);
    assert.equal(saved.text, "recorded body");

    // ...and replay of the same request returns the same response, offline.
    assert.deepEqual(await new ReplayLLM(fixtures).complete(request), live);
  });
});

test("makeLLM in fixture mode is the offline replay path and needs no credentials", async () => {
  const { makeLLM } = await import("../src/llm.js");
  const saved = { key: process.env.ANTHROPIC_API_KEY, cli: process.env.LEGWORK_LLM };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LEGWORK_LLM;
  try {
    const llm = makeLLM("fixture");
    assert.ok(llm);
    assert.equal(llm.kind, "replay");
    // No provider available: live mode degrades to null (template fallback), never a crash.
    assert.equal(makeLLM("live"), null);
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.cli !== undefined) process.env.LEGWORK_LLM = saved.cli;
  }
});
