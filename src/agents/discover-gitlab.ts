// discover-gitlab: the designed retirement candidate (registry.yaml hypothesis —
// public mobile repos on GitLab are rare; expect near-zero marginal contribution).
// GitLab exposes no unauthenticated code search, so the best public probe is project
// name/description search. This agent exists to be measured honestly: it runs, it
// logs, and the retirement loop decides its fate with data — success is not faked.

import type { Account, AgentDef, RunContext } from "../types.js";
import { invalidateDerived, sourceFingerprint, withSourceState } from "../freshness.js";
import { GitLabClient } from "../gitlab.js";

const QUERY = "expo eas";

export const discoverGitlab: AgentDef = {
  name: "discover-gitlab",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const gitlab = new GitLabClient({ mode: ctx.mode });
    const search = await gitlab.searchProjects(QUERY);
    const now = ctx.now();

    const known = new Map(input.map((account) => [account.org, account]));
    const out: Account[] = [];

    const projects = [...search.projects].sort((a, b) =>
      a.path_with_namespace < b.path_with_namespace ? -1 : 1,
    );
    for (const project of projects) {
      if (!withinWindow(project.last_activity_at, ctx)) continue;

      const org = project.namespace.path;
      const evidence = {
        claim: `GitLab project ${project.path_with_namespace} matches "${QUERY}"`,
        url: project.web_url,
        agent: "discover-gitlab",
        date: now,
      };

      const existing = known.get(org);
      if (!existing) {
        out.push(withSourceState({ org, stage: "discovered", repos: [project.path_with_namespace], evidence: [evidence], updated: now }));
        continue;
      }

      // Known org (github discover got there first, or a prior run did): union only.
      if (existing.evidence.some((e) => e.url === evidence.url)) continue;
      const updated = {
        ...existing,
        repos: [...new Set([...(existing.repos ?? []), project.path_with_namespace])].sort(),
        evidence: [...existing.evidence, evidence],
        updated: now,
      };
      out.push(
        sourceFingerprint(existing.repos, existing.evidence) !== sourceFingerprint(updated.repos, updated.evidence)
          ? invalidateDerived(updated, now)
          : withSourceState(updated),
      );
    }

    return out;
  },
};

// Live mode honors --since via the project's own activity stamp; fixture mode replays
// the recorded set untouched so the demo stays deterministic.
function withinWindow(lastActivity: string | undefined, ctx: RunContext): boolean {
  if (ctx.mode !== "live" || ctx.sinceDays <= 0) return true;
  if (!lastActivity) return true;
  const ageDays = (Date.parse(ctx.now()) - Date.parse(lastActivity)) / 86_400_000;
  return ageDays <= ctx.sinceDays;
}
