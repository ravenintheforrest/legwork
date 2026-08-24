// Fixture builders for the fleet's own types, plus a RunContext an agent will accept.
// Deliberately free of tuning: no weights, no segment letters, no golden-row counts —
// only shapes and invariants that survive a reweight.

import { StoreSignals } from "../../src/appstore.js";
import { CostMeter } from "../../src/costs.js";
import { GitHubClient } from "../../src/gh.js";
import type { LLM, LLMRequest, LLMResponse } from "../../src/llm.js";
import type { Account, Evidence, RunContext } from "../../src/types.js";

export const NOW = "2026-08-20T12:00:00.000Z";

export function evidence(claim: string, url: string, agent = "qualify"): Evidence {
  return { claim, url, agent, date: NOW.slice(0, 10) };
}

export function account(partial: Partial<Account> & { org: string }): Account {
  return {
    stage: "qualified",
    evidence: [],
    updated: NOW,
    ...partial,
  };
}

/** A model that always returns the same body. Never touches the network. */
export class StubLLM implements LLM {
  readonly kind = "api" as const;
  readonly requests: LLMRequest[] = [];
  constructor(private readonly body: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return { text: this.body, tokens_in: 10, tokens_out: 20 };
  }
}

/** A model that fails, to exercise the template fallback. */
export class FailingLLM implements LLM {
  readonly kind = "api" as const;
  async complete(): Promise<LLMResponse> {
    throw new Error("provider unavailable");
  }
}

export function ctx(opts: { llm?: LLM | null; mode?: "live" | "fixture"; pack?: string } = {}): RunContext {
  return {
    pack: opts.pack ?? "packs/expo",
    mode: opts.mode ?? "fixture",
    now: () => NOW,
    sinceDays: 7,
    gh: new GitHubClient({ mode: "fixture" }),
    store: new StoreSignals({ mode: "fixture" }),
    llm: opts.llm ?? null,
    costs: new CostMeter(Number.POSITIVE_INFINITY),
  };
}

/** Capture everything printed by `fn` (several modules report through console). */
export async function captureOutput<T>(fn: () => Promise<T> | T): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const value = await fn();
    return { value, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}
