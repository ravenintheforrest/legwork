// enrich: company facts from the company's own homepage — what they say they do, and
// whether a careers page is linked. Rule 6: only what the page actually said, each
// claim citing the URL it came from. An unreachable or unparseable page adds nothing.

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { WebClient, type HomePage } from "../web.js";

export const enrich: AgentDef = {
  name: "enrich",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const web = new WebClient({ mode: ctx.mode });
    const out: Account[] = [];

    for (const account of input) {
      if (account.stage !== "resolved") continue;

      const fresh: Evidence[] = [];
      if (account.domain) {
        // Best-effort: a homepage that refuses us is an absent signal, not a fault.
        const page = await web.homepage(account.org, account.domain).catch(() => null);
        if (page) fresh.push(...factsOf(account, page, ctx.now()));
      }

      // Every resolved account advances — enrichment is additive evidence, not a gate.
      const seen = new Set(account.evidence.map((e) => e.url));
      out.push({
        ...account,
        stage: "enriched",
        evidence: [...account.evidence, ...fresh.filter((e) => !seen.has(e.url))],
        updated: ctx.now(),
      });
    }

    return out;
  },
};

function factsOf(account: Account, page: HomePage, date: string): Evidence[] {
  const evidence: Evidence[] = [];
  const company = account.company ?? account.org;

  if (page.title || page.description) {
    const what = [page.title, page.description].filter(Boolean).join(" — ");
    evidence.push({
      claim: `${company} homepage: "${what}"`,
      url: page.url,
      agent: "enrich",
      date,
    });
  }

  if (page.careers_url) {
    evidence.push({
      claim: `${company} links a careers page from its homepage`,
      url: page.careers_url,
      agent: "enrich",
      date,
    });
  }

  return evidence;
}
