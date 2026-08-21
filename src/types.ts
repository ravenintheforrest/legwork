// Core state model. One account record carries its pipeline stage (12-Factor F5);
// agents are stateless reducers over these records (F12).

import type { GitHubClient } from "./gh.js";
import type { StoreSignals } from "./appstore.js";
import type { LLM } from "./llm.js";
import type { CostMeter } from "./costs.js";

export type Stage = "discovered" | "resolved" | "enriched" | "qualified" | "briefed";
export type Segment = "A" | "B" | "C" | "D";

export interface Account {
  org: string;                 // canonical key (github org or domain)
  domain?: string;
  company?: string;
  stage: Stage;
  segment?: Segment;
  confidence?: number;         // 0..1 — gates auto-publish vs review queue
  evidence: Evidence[];        // receipts: no source, no sentence
  updated: string;             // ISO date
  repos?: string[];            // github full_names, sorted — set by discover
  kind?: "org" | "user";       // set by resolve; user accounts never qualify
  review?: ReviewState;        // present once a brief entered the HITL gate
  qualification?: QualificationDecision; // inspectable score contract; never a black-box number
}

// HITL loop state (F7): briefs below the registry's confidence_gate queue for a human;
// decisions accumulate in data/reviews.jsonl and feed acceptance rates and retirement.
export interface ReviewState {
  status: "queued" | "approved" | "rejected";
  date: string;
}

export interface Evidence {
  claim: string;
  url: string;
  agent: string;
  date: string;
}

// The qualification score is a decision record, not an oracle. Every contribution is
// visible, missing public evidence is explicit, and the fallback says what happens next.
export interface QualificationSignal {
  name: string;
  value: number;               // normalized 0..1 signal value
  weight: number;              // share of the total score
  contribution: number;        // value * weight
  evidence_url?: string;       // absent means "not observed", never "known false"
}

export interface QualificationDecision {
  score: number;
  threshold: number;
  qualified: boolean;
  action: "brief" | "hold" | "exclude";
  signals: QualificationSignal[];
  assumptions: string[];
  fallback: string;
}

export interface RunRecord {
  id: string;
  agent: string;
  started: string;
  duration_ms: number;
  inputs: number;              // records in
  outputs: number;             // records out
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  outcome: "ok" | "error" | "killed_cost_ceiling";
  error?: string;              // compact — this is what `doctor` reads (F9)
}

// Every agent implements this and nothing else.
export interface AgentDef {
  name: string;
  run(input: Account[], ctx: RunContext): Promise<Account[]>;
}

// The runner owns logging and cost metering so an agent cannot forget them (F8).
export interface RunContext {
  pack: string;
  mode: "live" | "fixture";
  now: () => string;           // ISO; fixture mode pins one instant for determinism
  sinceDays: number;           // --since window
  gh: GitHubClient;
  store: StoreSignals;         // app-store signal lookup (fixture-only for now)
  llm: LLM | null;             // null → template fallback in brief
  costs: CostMeter;            // throws CostCeilingError past the registry ceiling
}
