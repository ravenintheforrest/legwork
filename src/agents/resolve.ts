// resolve: github login -> company name, domain, and whether it is an org or a person.

import type { Account, AgentDef, RunContext } from "../types.js";
import type { OrgProfile } from "../gh.js";

export const resolve: AgentDef = {
  name: "resolve",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const out: Account[] = [];

    for (const account of input) {
      if (account.stage !== "discovered") continue;

      const orgProfile = await ctx.gh.org(account.org);
      const profile = orgProfile ?? (await ctx.gh.user(account.org));
      // Neither endpoint knows this login: leave it at discovered and retry next run.
      if (!profile) continue;

      const kind: "org" | "user" = orgProfile ? "org" : "user";
      const company = profile.name || account.org;
      const domain = domainOf(profile);

      out.push({
        ...account,
        company,
        domain,
        kind,
        stage: "resolved",
        confidence: kind === "org" ? 0.5 : 0.25,
        evidence: [
          ...account.evidence,
          {
            claim: `GitHub ${kind} profile: ${company}${domain ? ` — ${domain}` : ""}`,
            url: profile.html_url,
            agent: "resolve",
            date: ctx.now(),
          },
        ],
        updated: ctx.now(),
      });
    }

    return out;
  },
};

function domainOf(profile: OrgProfile): string | undefined {
  const blog = (profile.blog ?? "").trim();
  if (!blog) return undefined;
  try {
    const url = new URL(blog.includes("://") ? blog : `https://${blog}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}
