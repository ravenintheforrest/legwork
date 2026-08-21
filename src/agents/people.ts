// people: who to talk to. For a qualified account's primary Expo repo, the top public
// contributors and what their own GitHub profiles say (name, company, bio, location,
// blog). Public fields only, bots skipped, nothing inferred: a profile is quoted, never
// interpreted. Runs after intent and before brief; the stage never changes — people only
// makes the brief personal. Rule 6 as always: every claim carries the URL it came from.

import type { Contributor, OrgProfile } from "../gh.js";
import type { Account, AgentDef, Evidence, RunContext } from "../types.js";

const MAX_PEOPLE = 3;
const MAX_BIO_CHARS = 160;
const EAS_JSON_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/eas\.json$/;

export const people: AgentDef = {
  name: "people",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const out: Account[] = [];

    for (const account of input) {
      if (account.stage !== "qualified") continue;
      const repo = primaryRepo(account);
      if (!repo) continue;

      const date = ctx.now();
      const fresh: Evidence[] = [];

      const contributors = await ctx.gh.contributors(repo.owner, repo.name);
      const humans = contributors.filter((c) => !isBot(c)).slice(0, MAX_PEOPLE);
      for (const contributor of humans) {
        const profile = await ctx.gh.user(contributor.login);
        const name = profile?.name?.trim() || null;
        const display = name ? `${name} (@${contributor.login})` : `@${contributor.login}`;
        const url = profile?.html_url ?? contributor.html_url;
        const commits = `${contributor.contributions} commit${contributor.contributions === 1 ? "" : "s"}`;
        fresh.push({
          claim: `top contributor to ${repo.full}: ${display}, ${commits}`,
          url,
          agent: "people",
          date,
        });

        const facts = profileFacts(profile);
        if (facts.length > 0) {
          fresh.push({
            claim: `${name ?? `@${contributor.login}`}'s GitHub profile lists ${joinNatural(facts)}`,
            url,
            agent: "people",
            date,
          });
        }
      }

      // Only touched records come back; an account with no new people is untouched.
      const seen = new Set(account.evidence.map((e) => `${e.claim}|${e.url}`));
      const additions = fresh.filter((e) => !seen.has(`${e.claim}|${e.url}`));
      if (additions.length === 0) continue;

      out.push({
        ...account,
        evidence: [...account.evidence, ...additions],
        updated: date,
      });
    }

    return out;
  },
};

// The repo the eas.json receipt points at is the Expo app; repos[0] is the fallback.
function primaryRepo(account: Account): { owner: string; name: string; full: string } | null {
  for (const e of account.evidence) {
    const match = EAS_JSON_URL.exec(e.url);
    if (match) return { owner: match[1]!, name: match[2]!, full: `${match[1]}/${match[2]}` };
  }
  const first = account.repos?.[0];
  if (!first) return null;
  const [owner, name] = first.split("/");
  if (!owner || !name) return null;
  return { owner, name, full: first };
}

function isBot(c: Contributor): boolean {
  return c.type === "Bot" || /\[bot\]$/i.test(c.login) || /(^|[-_])bot$/i.test(c.login);
}

// Only fields the profile actually carries, quoted as written (bio trimmed for length).
function profileFacts(profile: OrgProfile | null): string[] {
  if (!profile) return [];
  const facts: string[] = [];
  const company = clean(profile.company);
  const location = clean(profile.location);
  const blog = clean(profile.blog);
  const bio = clean(profile.bio);
  if (company) facts.push(`company '${company}'`);
  if (location) facts.push(`location '${location}'`);
  if (blog) facts.push(`website ${blog}`);
  if (bio) facts.push(`bio '${bio.length > MAX_BIO_CHARS ? bio.slice(0, MAX_BIO_CHARS - 1).trimEnd() + "…" : bio}'`);
  return facts;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function joinNatural(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
