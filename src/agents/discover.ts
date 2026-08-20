// discover: public repos that carry an EAS build config, grouped into candidate orgs.
// Stateless reducer — returns only the records it created or changed (F12).

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import type { CodeSearchItem } from "../gh.js";

const QUERY = "filename:eas.json expo";

// First-party owners are never prospects.
const FIRST_PARTY = new Set(["expo"]);

interface Candidate {
  repos: Set<string>;
  evidence: Evidence[];
}

export const discover: AgentDef = {
  name: "discover",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const search = await ctx.gh.searchCode(QUERY);
    const now = ctx.now();

    const candidates = new Map<string, Candidate>();
    for (const item of search.items) {
      const repo = item.repository;
      if (repo.fork) continue;
      const login = repo.owner.login;
      if (FIRST_PARTY.has(login)) continue;
      if (!(await withinWindow(item, ctx))) continue;

      const candidate = candidates.get(login) ?? { repos: new Set<string>(), evidence: [] };
      candidate.repos.add(repo.full_name);
      candidate.evidence.push({
        claim: `eas.json in ${repo.full_name}`,
        url: item.html_url,
        agent: "discover",
        date: now,
      });
      candidates.set(login, candidate);
    }

    const known = new Map(input.map((account) => [account.org, account]));
    const out: Account[] = [];

    for (const login of [...candidates.keys()].sort()) {
      const candidate = candidates.get(login)!;
      const repos = [...candidate.repos].sort();
      const existing = known.get(login);

      if (!existing) {
        out.push({
          org: login,
          stage: "discovered",
          repos,
          evidence: candidate.evidence,
          updated: now,
        });
        continue;
      }

      // Known org: never regress its stage, only union what is new.
      const seenUrls = new Set(existing.evidence.map((e) => e.url));
      const newEvidence = candidate.evidence.filter((e) => !seenUrls.has(e.url));
      const merged = [...new Set([...(existing.repos ?? []), ...repos])].sort();
      const reposChanged = merged.length !== (existing.repos ?? []).length;
      if (newEvidence.length === 0 && !reposChanged) continue;

      out.push({
        ...existing,
        repos: merged,
        evidence: [...existing.evidence, ...newEvidence],
        updated: now,
      });
    }

    return out;
  },
};

// Code search has no date qualifier, so --since is applied to the hits instead: in live
// mode a repo untouched inside the window is not a candidate this run.
async function withinWindow(item: CodeSearchItem, ctx: RunContext): Promise<boolean> {
  if (ctx.mode !== "live" || ctx.sinceDays <= 0) return true;
  const [owner, name] = item.repository.full_name.split("/");
  if (!owner || !name) return true;
  const repo = await ctx.gh.repo(owner, name);
  if (!repo?.pushed_at) return true; // unknown: keep the candidate, let qualify judge it
  const ageDays = (Date.parse(ctx.now()) - Date.parse(repo.pushed_at)) / 86_400_000;
  return ageDays <= ctx.sinceDays;
}
