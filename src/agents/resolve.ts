// resolve: github login -> company name, domain, and whether it is an org or a person.

import type { Account, AgentDef, RunContext } from "../types.js";
import type { OrgProfile } from "../gh.js";
import { WebClient } from "../web.js";
import { isSharedHost, normalizeCompany, slugify, withoutLegalSuffix } from "./naming.js";

export const resolve: AgentDef = {
  name: "resolve",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const out: Account[] = [];
    const web = new WebClient({ mode: ctx.mode, ...(ctx.fixtureDir ? { fixtureDir: ctx.fixtureDir } : {}) });

    for (const account of input) {
      if (account.stage !== "discovered") continue;

      const orgProfile = await ctx.gh.org(account.org);
      const profile = orgProfile ?? (await ctx.gh.user(account.org));
      if (!profile) {
        const byDomain = await orgForDomain(account, ctx);
        if (byDomain) {
          out.push(resolvedByDomain(account, byDomain, ctx.now()));
          continue;
        }
        const byName = await orgForName(account, ctx);
        if (byName) {
          out.push(resolvedByName(account, byName, ctx.now()));
          continue;
        }
        // No GitHub org anywhere. A company with a domain still exists — its homepage is
        // the receipt. Job-sourced and issue-sourced accounts go this way; without it they
        // sat at discovered forever, which is where the live funnel was losing them.
        const byHome = await resolvedByHomepage(account, web, ctx.now());
        if (byHome) out.push(byHome);
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
        ...locationOf(kind, profile),
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

// Org location only, and only when the profile has one: a missing field is an absent fact,
// never a guess. Person accounts get nothing here on purpose (public-person minimization).
function locationOf(kind: "org" | "user", profile: OrgProfile): { location?: string } {
  if (kind !== "org") return {};
  const location = (profile.location ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return location ? { location } : {};
}

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

// A name-keyed account (an issue author's "Acme Inc", a job post with no link): try the
// login the name slugifies to, and accept it only when that org's own profile name is the
// same name. Same rule as orgForDomain: a resemblance is a guess, and a guess is not a receipt.
async function orgForName(account: Account, ctx: RunContext): Promise<OrgProfile | null> {
  if (account.domain || !account.company || (account.repos ?? []).length > 0) return null;
  const bare = withoutLegalSuffix(account.company);
  const logins = [...new Set([slugify(account.company), slugify(bare), normalizeCompany(bare)])].filter((l) => l && l !== account.org);
  for (const login of logins) {
    const profile = await ctx.gh.org(login);
    if (profile?.name && normalizeCompany(profile.name) === normalizeCompany(account.company)) return profile;
  }
  return null;
}

// A name-keyed account whose name is exactly the name of a GitHub org: take the org's
// domain and name, cite the org. Same shape as the main path; the key stays the name slug
// so receipts already on the record keep pointing at it.
function resolvedByName(account: Account, profile: OrgProfile, date: string): Account {
  const domain = domainOf(profile);
  return {
    ...account,
    company: profile.name || account.company || account.org,
    ...(domain ? { domain } : {}),
    kind: "org",
    stage: "resolved",
    confidence: 0.5,
    evidence: [
      ...account.evidence,
      { claim: `GitHub org ${profile.login} is named "${profile.name}"${domain ? ` and lists ${domain} as its website` : ""}`, url: profile.html_url, agent: "resolve", date },
    ],
    updated: date,
  };
}

// The homepage answered with a title: the company is real and reachable, and every later
// unit has a domain to work from. Confidence stays below a GitHub-resolved org's.
async function resolvedByHomepage(account: Account, web: WebClient, date: string): Promise<Account | null> {
  // A shared host (an ATS, a link shortener) is not a company's homepage, whatever it answers.
  if (!account.domain || isSharedHost(account.domain)) return null;
  const page = await web.homepage(account.org, account.domain).catch(() => null);
  if (!page?.title) return null;
  return {
    ...account,
    company: account.company ?? page.title.split(/\s[|—–-]\s/)[0]!.trim().slice(0, 80) ?? account.org,
    kind: "org",
    stage: "resolved",
    confidence: 0.4,
    evidence: [
      ...account.evidence,
      { claim: `${account.domain} answers as "${page.title.slice(0, 120)}"`, url: page.url, agent: "resolve", date },
    ],
    updated: date,
  };
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
    ...locationOf("org", profile),
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

