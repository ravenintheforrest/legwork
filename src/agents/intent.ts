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

      // --- open EAS/build/upgrade issues in the org's own repos
      const issues = await ctx.gh.searchIssues(
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
      const hiring = result.hits.filter((h) => WHO_IS_HIRING.test(h.story_title ?? ""));
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
