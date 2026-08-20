// The fleet is config, not code: registry.yaml is the single source of truth for what
// each agent may spend, which model runs it, and how much autonomy it has.

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

const Autonomy = z.enum(["fix", "propose", "human"]);

const AgentEntry = z
  .object({
    does: z.string(),
    sources: z.array(z.string()).optional(),
    signals: z.array(z.string()).optional(),
    output: z.string(),
    model: z.string().optional(),
    cost_ceiling_usd: z.number().optional(),
    autonomy: Autonomy.optional(),
    hypothesis: z.string().optional(),
    schedule: z.string().optional(),
  })
  .strict(); // unknown keys are typos, not features

const RegistrySchema = z.object({
  pack: z.string(),
  defaults: z.object({
    model: z.string(),
    cost_ceiling_usd: z.number(),
    autonomy: Autonomy,
  }),
  agents: z.record(AgentEntry),
  loops: z.record(z.object({ trigger: z.string() }).passthrough()),
  sources: z.record(z.object({}).passthrough()),
  autonomy_tiers: z.record(z.array(z.string())),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type AgentConfig = z.infer<typeof AgentEntry>;
export type AutonomyTier = z.infer<typeof Autonomy>;

export interface EffectiveConfig {
  model: string;
  costCeilingUsd: number;
  autonomy: AutonomyTier;
}

export function loadRegistry(path = "registry.yaml"): Registry {
  const raw = yaml.load(readFileSync(path, "utf8"));
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join(".") : "";
    const why = first ? first.message : "invalid";
    throw new Error(`${path} is invalid at "${where}": ${why}`);
  }
  return parsed.data;
}

export function effective(reg: Registry, agent: string): EffectiveConfig {
  const entry = reg.agents[agent];
  if (!entry) throw new Error(`no agent "${agent}" in the registry`);
  return {
    model: entry.model ?? reg.defaults.model,
    costCeilingUsd: entry.cost_ceiling_usd ?? reg.defaults.cost_ceiling_usd,
    autonomy: entry.autonomy ?? reg.defaults.autonomy,
  };
}
