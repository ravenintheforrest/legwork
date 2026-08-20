// qualify: score public production-usage signals and segment the account.
// The weights and thresholds here are the eval contract — change them and the golden
// set moves with them (packs/expo/golden-set.jsonl, `legwork evals`).

import type { Account, AgentDef, Evidence, RunContext, Segment } from "../types.js";
import type { OrgProfile, Repo } from "../gh.js";

type SignalName =
  | "eas_json_present"
  | "rn_version_recency"
  | "ci_config"
  | "team_size_signals"
  | "repo_activity"
  | "store_review_volume"
  | "store_update_cadence"
  | "regulated_industry";

const WEIGHTS: Record<SignalName, number> = {
  eas_json_present: 0.3,
  rn_version_recency: 0.1,
  ci_config: 0.1,
  team_size_signals: 0.1,
  repo_activity: 0.15,
  store_review_volume: 0.1,
  store_update_cadence: 0.1,
  regulated_industry: 0.05,
};

const QUALIFY_AT = 0.55;

const REGULATED = /fintech|financial|bank|payment|health|medical|insur|government|transit/i;
const AGENCY = /agenc|studio|consultanc/i;
const B2B = /\b(b2b|saas|enterprise|for teams|incident management)\b/i;

interface Signal {
  name: SignalName;
  score: number;            // 0..1
  evidence?: Evidence;      // only when a real source produced the score
}

export const qualify: AgentDef = {
  name: "qualify",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const out: Account[] = [];

    for (const account of input) {
      if (account.stage !== "resolved") continue;

      const profile = await profileFor(account, ctx);
      const signals = await scoreAccount(account, profile, ctx);
      const weighted = signals.reduce((sum, s) => sum + s.score * WEIGHTS[s.name], 0);
      const easPresent = signals.find((s) => s.name === "eas_json_present")?.score === 1;
      const isUser = account.kind === "user";

      const qualified = easPresent && weighted >= QUALIFY_AT && !isUser;
      // A person's side project never becomes an account, and never carries more
      // confidence than a person's side project deserves.
      const confidence = round2(isUser ? Math.min(weighted, 0.25) : weighted);

      // Re-scoring replaces this agent's own receipts; everyone else's carry forward.
      const carried = account.evidence.filter((e) => e.agent !== "qualify");
      const fresh = signals.flatMap((s) => (s.evidence ? [s.evidence] : []));

      out.push({
        ...account,
        stage: qualified ? "qualified" : "resolved",
        segment: qualified ? segmentOf(profile, signals) : undefined,
        confidence,
        evidence: [...carried, ...fresh],
        updated: ctx.now(),
      });
    }

    return out;
  },
};

async function profileFor(account: Account, ctx: RunContext): Promise<OrgProfile | null> {
  if (account.kind === "user") return ctx.gh.user(account.org);
  return (await ctx.gh.org(account.org)) ?? ctx.gh.user(account.org);
}

async function scoreAccount(
  account: Account,
  profile: OrgProfile | null,
  ctx: RunContext,
): Promise<Signal[]> {
  const date = ctx.now();
  const repos = (account.repos ?? []).map(splitFullName).filter((r) => r !== null);

  // --- eas_json_present: any repo of the org ships an EAS build config
  let eas: Signal = { name: "eas_json_present", score: 0 };
  for (const { owner, name, full } of repos) {
    const file = await ctx.gh.contents(owner, name, "eas.json");
    if (!file) continue;
    eas = {
      name: "eas_json_present",
      score: 1,
      // Same wording as discover's receipt for the same file, so a brief that renders
      // both shows the fact once.
      evidence: { claim: `eas.json in ${full}`, url: file.html_url, agent: "qualify", date },
    };
    break;
  }

  // --- rn_version_recency: newest react-native pinned across the org's repos
  let rn: Signal = { name: "rn_version_recency", score: 0 };
  for (const { owner, name, full } of repos) {
    const file = await ctx.gh.contents(owner, name, "package.json");
    if (!file) continue;
    const version = reactNativeVersion(file.content);
    if (!version) continue;
    const score = rnScore(version);
    if (score === null) continue; // no parseable minor: no claim we can stand behind
    if (rn.evidence && score <= rn.score) continue;
    rn = {
      name: "rn_version_recency",
      score,
      evidence: {
        claim: `react-native ${version} in ${full}/package.json`,
        url: file.html_url,
        agent: "qualify",
        date,
      },
    };
  }

  // --- ci_config: automated builds, not a laptop
  let ci: Signal = { name: "ci_config", score: 0 };
  for (const { owner, name, full } of repos) {
    const dir = await ctx.gh.contents(owner, name, ".github/workflows");
    if (!dir) continue;
    ci = {
      name: "ci_config",
      score: 1,
      evidence: { claim: `CI workflows in ${full}`, url: dir.html_url, agent: "qualify", date },
    };
    break;
  }

  // --- team_size_signals: an org with people in it (a user account scores nothing)
  let team: Signal = { name: "team_size_signals", score: 0 };
  if (account.kind !== "user" && profile) {
    const publicRepos = profile.public_repos ?? 0;
    const followers = profile.followers ?? 0;
    const score = publicRepos >= 10 || followers >= 50 ? 1 : publicRepos >= 3 ? 0.5 : 0;
    team = {
      name: "team_size_signals",
      score,
      evidence: {
        claim: `${publicRepos} public repos and ${followers} followers on github.com/${account.org}`,
        url: profile.html_url,
        agent: "qualify",
        date,
      },
    };
  }

  // --- repo_activity: the most recently touched repo the org has
  let activity: Signal = { name: "repo_activity", score: 0 };
  let bestRepo: Repo | null = null;
  for (const { owner, name } of repos) {
    const repo = await ctx.gh.repo(owner, name);
    if (!repo) continue;
    const score = activityScore(repo, ctx.now());
    if (bestRepo && score <= activity.score) continue;
    bestRepo = repo;
    activity = { name: "repo_activity", score };
  }
  if (bestRepo) {
    const pushed = (bestRepo.pushed_at ?? "").slice(0, 10);
    activity.evidence = {
      claim: bestRepo.archived
        ? `${bestRepo.full_name} is archived, last pushed ${pushed}`
        : `${bestRepo.full_name} last pushed ${pushed}`,
      url: bestRepo.html_url,
      agent: "qualify",
      date,
    };
  }

  // --- store signals: the public MAU and build-volume proxies EAS bills on
  const record = await ctx.store.lookup(account.org);
  const reviews: Signal = { name: "store_review_volume", score: 0 };
  const cadence: Signal = { name: "store_update_cadence", score: 0 };
  if (record) {
    reviews.score =
      record.review_count >= 10_000 ? 1 : record.review_count >= 1_000 ? 0.5 : record.review_count > 0 ? 0.25 : 0;
    reviews.evidence = {
      claim: `${record.app_name} has ${thousands(record.review_count)} App Store ratings`,
      url: record.store_url,
      agent: "qualify",
      date,
    };
    cadence.score = record.updates_last_90d >= 4 ? 1 : record.updates_last_90d >= 1 ? 0.5 : 0;
    cadence.evidence = {
      claim: `${record.updates_last_90d} App Store releases in the last 90 days`,
      url: record.store_url,
      agent: "qualify",
      date,
    };
  }

  // --- regulated_industry: enterprise-tier compliance pressure
  const description = profile?.description ?? "";
  const match = REGULATED.exec(description);
  const regulated: Signal = { name: "regulated_industry", score: match ? 1 : 0 };
  if (match && profile) {
    regulated.evidence = {
      claim: `GitHub org description names a regulated category ("${match[0]}")`,
      url: profile.html_url,
      agent: "qualify",
      date,
    };
  }

  return [eas, rn, ci, team, activity, reviews, cadence, regulated];
}

function segmentOf(profile: OrgProfile | null, signals: Signal[]): Segment {
  const description = profile?.description ?? "";
  if (AGENCY.test(description)) return "D";
  if (signals.find((s) => s.name === "regulated_industry")?.score === 1) return "B";
  if (B2B.test(description)) return "B";
  const createdYear = profile?.created_at ? new Date(profile.created_at).getUTCFullYear() : NaN;
  if (createdYear < 2016 && (profile?.public_repos ?? 0) >= 100) return "C";
  return "A";
}

function splitFullName(full: string): { owner: string; name: string; full: string } | null {
  const [owner, name] = full.split("/");
  return owner && name ? { owner, name, full } : null;
}

function reactNativeVersion(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const deps = (content as { dependencies?: Record<string, string> }).dependencies;
  const version = deps?.["react-native"];
  return typeof version === "string" ? version : null;
}

// "^0.74.5", "~0.73.6", ">= 0.72.0" all reduce to their minor.
function rnScore(version: string): number | null {
  const minor = Number(version.replace(/^[\^~>=<\s]+/, "").split(".")[1]);
  if (!Number.isFinite(minor)) return null;
  return minor >= 73 ? 1 : minor >= 68 ? 0.5 : 0.25;
}

function activityScore(repo: Repo, now: string): number {
  if (repo.archived) return 0;
  if (!repo.pushed_at) return 0;
  const days = (Date.parse(now) - Date.parse(repo.pushed_at)) / 86_400_000;
  return days <= 90 ? 1 : days <= 365 ? 0.5 : 0;
}

function thousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
