// One interface for model calls. Nothing else in the fleet imports a provider directly,
// so cost metering, capture, and the offline replay path stay in one place.
//
// Providers:
//   AnthropicLLM  — SDK + ANTHROPIC_API_KEY (the production path)
//   ClaudeCliLLM  — shells out to `claude -p`; runs on a Claude subscription instead of
//                   per-token billing (opt in: LEGWORK_LLM=cli)
//   ReplayLLM     — fixture playback keyed by request hash; what demo mode uses, so the
//                   demo shows authentic model output and stays deterministic and offline
// RecordingLLM wraps a live provider only for explicit capture into an ignored quarantine directory.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPLAY_DIR = "fixtures/llm";
const CAPTURE_DIR = "data/captures/llm";

export interface LLMRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LLMResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
}

export interface LLM {
  readonly kind: "api" | "cli" | "replay";
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class ReplayMissError extends Error {
  constructor(key: string) {
    super(`no replay fixture for request ${key} — template fallback will be used; explicit captures stay quarantined`);
  }
}

export function requestKey(req: LLMRequest): string {
  return createHash("sha256")
    .update(req.model)
    .update(" ")
    .update(req.system)
    .update(" ")
    .update(req.prompt)
    .digest("hex")
    .slice(0, 16);
}

export function makeLLM(mode: "live" | "fixture", captureLlm = false): LLM | null {
  if (mode === "fixture") {
    if (captureLlm) {
      const live = liveProvider();
      return live ? new RecordingLLM(live, process.env.LEGWORK_CAPTURE_DIR ?? CAPTURE_DIR) : null;
    }
    return new ReplayLLM();
  }
  // Live calls are never persisted implicitly. Explicit capture goes only to the
  // ignored quarantine directory and must be reviewed before fixture promotion.
  const live = liveProvider();
  if (!live) return null;
  return captureLlm ? new RecordingLLM(live, process.env.LEGWORK_CAPTURE_DIR ?? CAPTURE_DIR) : live;
}

function liveProvider(): LLM | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return new AnthropicLLM(apiKey);
  if (process.env.LEGWORK_LLM === "cli") return new ClaudeCliLLM();
  return null;
}

class AnthropicLLM implements LLM {
  readonly kind = "api" as const;
  constructor(private readonly apiKey: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Lazy import: the SDK is only loaded when a key is actually present.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      text,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    };
  }
}

class ClaudeCliLLM implements LLM {
  readonly kind = "cli" as const;

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // System and user content travel together on stdin; `-p` gives one non-interactive
    // turn and `--output-format json` returns { result, usage } we can meter.
    const input = req.system + "\n\n---\n\n" + req.prompt;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", ["-p", "--output-format", "json", "--model", req.model], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
      });
      child.stdin.write(input);
      child.stdin.end();
    });
    const parsed = JSON.parse(stdout) as {
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      is_error?: boolean;
    };
    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new Error("claude CLI returned an error result");
    }
    return {
      text: parsed.result.trim(),
      tokens_in: parsed.usage?.input_tokens ?? 0,
      tokens_out: parsed.usage?.output_tokens ?? 0,
    };
  }
}

// Exported for the test suite only: both take a fixture directory so a test can point
// them at a temp dir instead of the repo's fixtures/llm. Behavior and defaults unchanged.
export class ReplayLLM implements LLM {
  readonly kind = "replay" as const;
  constructor(private readonly dir = REPLAY_DIR) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const key = requestKey(req);
    const file = join(this.dir, key + ".json");
    if (!existsSync(file)) throw new ReplayMissError(key);
    const saved = JSON.parse(readFileSync(file, "utf8")) as LLMResponse;
    return { text: saved.text, tokens_in: saved.tokens_in, tokens_out: saved.tokens_out };
  }
}

export class RecordingLLM implements LLM {
  constructor(
    private readonly inner: LLM,
    private readonly dir = CAPTURE_DIR,
  ) {}

  get kind(): "api" | "cli" | "replay" {
    return this.inner.kind;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.complete(req);
    mkdirSync(this.dir, { recursive: true });
    const fixture = {
      model: req.model,
      text: response.text,
      tokens_in: response.tokens_in,
      tokens_out: response.tokens_out,
    };
    writeFileSync(join(this.dir, requestKey(req) + ".json"), JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    return response;
  }
}
