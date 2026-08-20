// dedupe: one company, one record. Two orgs resolving to the same domain are the same
// company under different spellings — the canonical record absorbs the duplicate's
// receipts and repos, the leftover is flagged by dropping its confidence. Nothing is
// deleted (the state model has no deletes) and no evidence is ever invented: the flag
// cites the duplicate's own profile receipt, which is where its domain came from.

import type { Account, AgentDef, Evidence, RunContext, Stage } from "../types.js";

const STAGE_RANK: Record<Stage, number> = {
  discovered: 0,
  resolved: 1,
  enriched: 2,
  qualified: 3,
  briefed: 4,
};

const FLAGGED_CONFIDENCE = 0.1;

export const dedupe: AgentDef = {
  name: "dedupe",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const byDomain = new Map<string, Account[]>();
    for (const account of input) {
      if (!account.domain) continue;
      const group = byDomain.get(account.domain) ?? [];
      group.push(account);
      byDomain.set(account.domain, group);
    }

    const now = ctx.now();
    const out: Account[] = [];

    for (const domain of [...byDomain.keys()].sort()) {
      const group = byDomain.get(domain)!;
      if (group.length < 2) continue;

      // Canonical is the record furthest along, then the one with the most receipts,
      // then alphabetical — fully deterministic.
      const ranked = [...group].sort(
        (a, b) =>
          STAGE_RANK[b.stage] - STAGE_RANK[a.stage] ||
          b.evidence.length - a.evidence.length ||
          (a.org < b.org ? -1 : 1),
      );
      const canonical = ranked[0]!;
      const duplicates = ranked.slice(1);

      out.push({
        ...canonical,
        repos: [...new Set([...(canonical.repos ?? []), ...duplicates.flatMap((d) => d.repos ?? [])])].sort(),
        evidence: unionEvidence([canonical, ...duplicates]),
        updated: now,
      });

      for (const dupe of duplicates) {
        const { domain: _reconciled, ...rest } = dupe; // the domain now lives on the canonical record
        out.push({
          ...rest,
          confidence: Math.min(dupe.confidence ?? FLAGGED_CONFIDENCE, FLAGGED_CONFIDENCE),
          evidence: [...dupe.evidence, flag(dupe, canonical, domain, now)],
          updated: now,
        });
      }
    }

    return out;
  },
};

function unionEvidence(accounts: Account[]): Evidence[] {
  const seen = new Set<string>();
  const union: Evidence[] = [];
  for (const account of accounts) {
    for (const e of account.evidence) {
      const key = `${e.claim}|${e.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(e);
    }
  }
  return union;
}

// The duplicate's resolve receipt is the source that put the shared domain on the
// record; the flag re-cites it rather than asserting anything new.
function flag(dupe: Account, canonical: Account, domain: string, date: string): Evidence {
  const source = dupe.evidence.find((e) => e.agent === "resolve")?.url ?? `https://github.com/${dupe.org}`;
  return {
    claim: `duplicate of ${canonical.org}: both profiles resolve to ${domain}`,
    url: source,
    agent: "dedupe",
    date,
  };
}
