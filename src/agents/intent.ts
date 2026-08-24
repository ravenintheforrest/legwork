// intent: "why now" receipts on already-qualified accounts. Two public sources: open
// GitHub issues in the org's repos about EAS/build pain or upgrades, and hiring
// mentions in HN "Ask HN: Who is hiring?" threads. The stage never changes — intent
// only sharpens the brief. Rule 6 as always: every claim carries the URL it came from.

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { HnClient } from "../web.js";

const ISSUE_TERMS = "EAS OR \"build failed\" OR \"expo upgrade\" in:title";
const MAX_ISSUES = 3;
const MAX_HIRING = 2;
const WHO_IS_HIRING = /who is hiring/i;

export const intent: AgentDef = {
  name: "intent",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const hn = new HnClient({ mode: ctx.mode });
    const out: Account[] = [];

    for (const account of input) {
      if (account.stage !== "qualified") continue;

      const date = ctx.now();
      const fresh: Evidence[] = [];

      // --- open EAS/build/upgrade issues in the org's own repos. Only when the account is
      // a GitHub org with repos: a domain- or name-keyed account (resolved by homepage) has
      // no `org:` to search, and GitHub answers 422 for a login it does not know.
      const issues = (account.repos ?? []).length === 0 ? { total_count: 0, items: [] } : await ctx.gh.searchIssues(
        account.org,
        `org:${account.org} is:issue is:open ${ISSUE_TERMS}`,
      );
      for (const issue of issues.items.slice(0, MAX_ISSUES)) {
        fresh.push({
          claim: `open issue in ${account.org}: "${issue.title}"`,
          url: issue.html_url,
          agent: "intent",
          date,
        });
      }

      // --- hiring mentions in HN "who is hiring" threads
      const company = account.company ?? account.org;
      const result = await hn.search(account.org, company);
      // "Why now" means now: a post outside the run's window is history, not a signal.
      const cutoff = ctx.sinceDays > 0 ? Date.parse(date) - ctx.sinceDays * 86_400_000 : Number.NEGATIVE_INFINITY;
      const hiring = result.hits.filter((h) => WHO_IS_HIRING.test(h.story_title ?? "") && (!h.created_at || Date.parse(h.created_at) >= cutoff));
      for (const hit of hiring.slice(0, MAX_HIRING)) {
        const posted = hit.created_at ? ` (${hit.created_at.slice(0, 10)})` : "";
        fresh.push({
          claim: `${company} listed in "${hit.story_title}" on HN${posted}`,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          agent: "intent",
          date,
        });
      }

      // Only touched records come back; an account with no new signal is untouched.
      const seen = new Set(account.evidence.map((e) => e.url));
      const additions = fresh.filter((e) => !seen.has(e.url));
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
