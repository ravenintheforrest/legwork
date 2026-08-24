// discover-issues: the companies whose engineers are in Expo's own issue trackers right now.
//
// Why the channel exists: someone who opens an issue on expo/expo or expo/eas-cli and
// lists a company on their public GitHub profile has just told us two things in one public
// act — that company runs Expo today, and it has a pain this week. Code search finds
// hobbyists; job posts find budgets; this finds production users with a reason to talk.
//
// Public-person minimization, as in people.ts: the profile's company is the only field
// read; location and bio are never copied. The claim names the issue and the company; the
// handle is the receipt trail, nothing more.
//
// Stateless reducer with the same contract as discover-jobs (F12): emits accounts at stage
// "discovered", unions new receipts into records it already knows, never regresses a
// stage, and returns only what it touched.

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { invalidateDerived, sourceFingerprint, withSourceState } from "../freshness.js";
import { companyName, normalizeCompany, quote, slugify } from "./naming.js";

const TRACKERS = ["expo/expo", "expo/eas-cli"];
const MAX_ISSUES_PER_TRACKER = 100;
const MAX_PROFILE_LOOKUPS = 80;
// Expo's own people and bots are not prospects.
const FIRST_PARTY = new Set(["expo", "expoteam", "expodev"]);

interface Candidate {
  company: string;
  evidence: Evidence[];
}

export const discoverIssues: AgentDef = {
  name: "discover-issues",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const now = ctx.now();
    const since = ctx.sinceDays > 0 ? ` created:>=${sinceDate(now, ctx.sinceDays)}` : "";

    // One query per tracker, newest first. Fixture-keyed by tracker (fixtures/github/issues/
    // tracker-expo-expo.json); an absent fixture is an empty tracker.
    const byAuthor = new Map<string, Array<{ tracker: string; title: string; url: string }>>();
    for (const tracker of TRACKERS) {
      const key = `tracker-${tracker.replace("/", "-")}`;
      const result = await ctx.gh.searchIssues(key, `repo:${tracker} is:issue${since} sort:created-desc`, { perPage: 100 });
      for (const issue of result.items.slice(0, MAX_ISSUES_PER_TRACKER)) {
        const login = issue.user?.login;
        if (!login || /\[bot\]$/i.test(login)) continue;
        const list = byAuthor.get(login) ?? [];
        list.push({ tracker, title: issue.title, url: issue.html_url });
        byAuthor.set(login, list);
      }
    }

    const candidates = new Map<string, Candidate>();
    let lookups = 0;
    for (const [login, issues] of byAuthor) {
      if (lookups >= MAX_PROFILE_LOOKUPS) break;
      lookups += 1;
      const profile = await ctx.gh.user(login);
      const listed = (profile?.company ?? "").trim();
      if (!listed) continue;

      // "@acme" is a GitHub org login — the best key we can get, resolve confirms it.
      // "Acme Inc" is a name; resolve tries to find the org it names.
      const handle = /^@([A-Za-z0-9][A-Za-z0-9-]*)/.exec(listed)?.[1];
      const name = companyName(listed.replace(/^@/, ""));
      if (!name) continue;
      if (FIRST_PARTY.has(normalizeCompany(name)) || (handle && FIRST_PARTY.has(handle.toLowerCase()))) continue;

      const key = handle ? handle.toLowerCase() : slugify(name);
      if (!key) continue;
      const candidate = candidates.get(key) ?? { company: name, evidence: [] };
      for (const issue of issues.slice(0, 2)) {
        candidate.evidence.push({
          claim: `an engineer who lists ${name} on their GitHub profile opened "${quote(issue.title)}" on ${issue.tracker}`,
          url: issue.url,
          agent: "discover-issues",
          date: now,
        });
      }
      if (profile?.html_url) {
        candidate.evidence.push({
          claim: `@${login}'s GitHub profile lists company '${listed}'`,
          url: profile.html_url,
          agent: "discover-issues",
          date: now,
        });
      }
      candidates.set(key, candidate);
    }

    const known = new Map(input.map((account) => [account.org, account]));
    const out: Account[] = [];
    for (const key of [...candidates.keys()].sort()) {
      const candidate = candidates.get(key)!;
      const existing = known.get(key);
      if (!existing) {
        out.push(withSourceState({ org: key, company: candidate.company, stage: "discovered", evidence: candidate.evidence, updated: now }));
        continue;
      }
      const seen = new Set(existing.evidence.map((e) => e.url));
      const fresh = candidate.evidence.filter((e) => !seen.has(e.url));
      if (fresh.length === 0) continue;
      const updated = { ...existing, evidence: [...existing.evidence, ...fresh], updated: now };
      out.push(
        sourceFingerprint(existing.repos, existing.evidence) !== sourceFingerprint(updated.repos, updated.evidence)
          ? invalidateDerived(updated, now)
          : withSourceState(updated),
      );
    }
    return out;
  },
};

function sinceDate(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 86_400_000).toISOString().slice(0, 10);
}
