// Core state model. One account record carries its pipeline stage (12-Factor F5);
// agents are stateless reducers over these records (F12).

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
}

export interface Evidence {
  claim: string;
  url: string;
  agent: string;
  date: string;
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

export interface RunContext {
  pack: string;
  log: (r: Omit<RunRecord, "id" | "started">) => void;
  budgetUsd: number;
}
