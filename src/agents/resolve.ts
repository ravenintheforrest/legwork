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
      if (!profile) {
        const matched = await orgForDomain(account, ctx);
        // Neither endpoint knows this login and no org claims the domain: leave the
        // account at discovered with the evidence it arrived with, and retry next run.
        if (!matched) continue;
        out.push(resolvedByDomain(account, matched, ctx.now()));
        continue;
      }

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

// --- job-sourced accounts ----------------------------------------------------------
// discover-jobs keys an account by the domain in the job post, because the company has
// no public repo to key on — so the login lookup above was never going to hit. Try the
// handful of logins a domain and company name plausibly map to, and accept one only
// when that org's own profile lists the same domain as its website. A name that merely
// looks similar is a guess, and a guess is not a receipt.
//
// No repos are attached here: this agent has no repo-listing call, and where the org is
// already tracked under its own login, dedupe unions the two records by domain and the
// repos come across with everyone else's receipts.
async function orgForDomain(account: Account, ctx: RunContext): Promise<OrgProfile | null> {
  if (!account.domain || (account.repos ?? []).length > 0) return null;
  for (const login of candidateLogins(account.domain, account.company)) {
    const profile = await ctx.gh.org(login);
    if (profile && domainOf(profile) === account.domain) return profile;
  }
  return null;
}

function candidateLogins(domain: string, company: string | undefined): string[] {
  const bare = domain.slice(0, domain.lastIndexOf("."));    // incident.io -> incident
  const guesses = [domain, bare, company ?? ""].map(slugify).filter((s) => s !== "");
  return [...new Set(guesses)];
}

function resolvedByDomain(account: Account, profile: OrgProfile, date: string): Account {
  return {
    ...account,
    company: profile.name || account.company || account.org,
    kind: "org",
    stage: "resolved",
    confidence: 0.5,
    evidence: [
      ...account.evidence,
      {
        claim: `GitHub org ${profile.login} lists ${account.domain} as its website`,
        url: profile.html_url,
        agent: "resolve",
        date,
      },
    ],
    updated: date,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
