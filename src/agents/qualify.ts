// qualify: score public production-usage signals and segment the account.
// The weights and thresholds here are the eval contract — change them and the golden
// set moves with them (packs/expo/golden-set.jsonl, `legwork evals`).

import type { Account, AgentDef, Evidence, QualificationDecision, RunContext, Segment } from "../types.js";
import { storeCadence } from "../appstore.js";
import type { OrgProfile, Repo } from "../gh.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

type SignalName =
  | "production_evidence"
  | "rn_version_recency"
  | "ci_config"
  | "team_size_signals"
  | "repo_activity"
  | "store_review_volume"
  | "store_update_cadence"
  | "regulated_industry"
  | "hiring_signal";

// Weights sum to 1.00: the maximum possible score is the top of the scale, always.
//
// Rebalance 2026-08-23 — the private-repo path (docs/specs/private-repo-path.md §2).
// production_evidence is the gate and it now has three sources: an eas.json in a public
// repo, a job post the company published that names Expo or EAS, or an engineer who lists
// the company on their profile opening an issue on Expo's own trackers. hiring_signal
// doubled to 0.20 (budget evidence; any public job post for React Native / Expo); the 0.10
// came out of rn_version_recency and ci_config, which only a public repo can show. The
// live funnel was 57 leads → 2 briefs because the old gate could only be passed from a
// public repo, and the ICP keeps the app repo private.
//
// Arithmetic: a company with no public repo, a job post naming EAS, a store app with ≥1k
// ratings shipped in the last 30 days: 0.20 + 0.20 + 0.05 + 0.10 = 0.55 → brief. With no
// app found: 0.40 → hold. A repo account with eas.json, current RN, active repo and a
// store app still clears 0.55; one with eas.json + RN + CI and nothing else lands at 0.30.
const WEIGHTS: Record<SignalName, number> = {
  production_evidence: 0.2,
  rn_version_recency: 0.05,
  ci_config: 0.05,
  team_size_signals: 0.1,
  repo_activity: 0.15,
  store_review_volume: 0.1,
  store_update_cadence: 0.1,
  regulated_industry: 0.05,
  hiring_signal: 0.2,
};

// 0.55 → 0.50 on 2026-08-23, after the first live run with the new sources: companies with
// production evidence (a job post naming EAS, an engineer in Expo's tracker) and a store
// app landed at 0.43–0.50 and were held. At 0.50 the bar reads "production evidence and one
// more real signal"; a repo fork with nothing else (0.45) still does not clear it.
// The bar is pack config (packs/<pack>/icp.yaml thresholds.qualify_at), tunable from the
// console's System screen; this is the fallback when the file has no opinion.
const QUALIFY_AT_DEFAULT = 0.5;

function qualifyAt(pack: string): number {
  try {
    const icp = yaml.load(readFileSync(join(pack, "icp.yaml"), "utf8")) as { thresholds?: { qualify_at?: unknown } };
    const raw = icp?.thresholds?.qualify_at;
    if (typeof raw === "number" && raw >= 0.2 && raw <= 0.9) return raw;
  } catch { /* no icp file: the default holds */ }
  return QUALIFY_AT_DEFAULT;
}

// A job-post claim that names Expo or EAS: "hiring for Expo, EAS in …" / "(names Expo…)".
const NAMES_EXPO = /hiring for [^:]*\b(Expo|EAS)\b/;

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
      if (account.stage !== "enriched") continue;

      const threshold = qualifyAt(ctx.pack);
      const profile = await profileFor(account, ctx);
      const signals = await scoreAccount(account, profile, ctx);
      const weighted = signals.reduce((sum, s) => sum + s.score * WEIGHTS[s.name], 0);
      const production = signals.find((s) => s.name === "production_evidence")?.score === 1;
      const isUser = account.kind === "user";

      // The number a person sees is the number that decides: compare the rounded score, so
      // 0.20 + 0.05 + 0.05 + 0.15 + 0.05 + 0.05 is 0.55, not 0.5499999.
      const qualified = production && round2(weighted) >= threshold && !isUser;
      // A person's side project never becomes an account, and never carries more
      // confidence than a person's side project deserves.
      const confidence = round2(isUser ? Math.min(weighted, 0.25) : weighted);
      const qualification = decisionFor(signals, round2(weighted), qualified, isUser, threshold);

      // Re-scoring replaces this agent's own receipts; everyone else's carry forward.
      const carried = account.evidence.filter((e) => e.agent !== "qualify");
      const fresh = signals.flatMap((s) => (s.evidence ? [s.evidence] : []));

      out.push({
        ...account,
        stage: qualified ? "qualified" : "enriched",
        segment: qualified ? segmentOf(profile, signals) : undefined,
        confidence,
        qualification,
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

  // --- production_evidence: the gate. Three public ways a company shows it builds on
  // Expo: an eas.json in one of its repos; a job post it published naming Expo or EAS; an
  // engineer who lists it on their profile opening an issue on Expo's own trackers. The
  // first one found is the receipt, in that order — a file beats a sentence.
  let eas: Signal = { name: "production_evidence", score: 0 };
  for (const { owner, name, full } of repos) {
    const file = await ctx.gh.contents(owner, name, "eas.json");
    if (!file) continue;
    eas = {
      name: "production_evidence",
      score: 1,
      // Same wording as discover's receipt for the same file, so a brief that renders
      // both shows the fact once.
      evidence: { claim: `eas.json in ${full}`, url: file.html_url, agent: "qualify", date },
    };
    break;
  }
  if (eas.score === 0) {
    const words = account.evidence.find((e) => e.agent === "discover-jobs" && NAMES_EXPO.test(e.claim))
      ?? account.evidence.find((e) => e.agent === "discover-issues" && /opened "/.test(e.claim));
    if (words) eas = { name: "production_evidence", score: 1, evidence: { claim: words.claim, url: words.url, agent: "qualify", date } };
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
  const record = await ctx.store.lookup(account.org, { company: account.company, domain: account.domain });
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
    // Fixtures carry a 90-day release count; the live API only knows the last ship date.
    // storeCadence scores whichever the record has and words the claim to match.
    const shipped = storeCadence(record, date);
    if (shipped) {
      cadence.score = shipped.score;
      cadence.evidence = { claim: shipped.claim, url: record.store_url, agent: "qualify", date };
    }
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

  // --- hiring_signal: a public job post for React Native / Expo is budget evidence — the
  // channel that reaches companies whose app repo is private. Scoped to discover-jobs'
  // receipts so the score is reproducible from named sources; no post observed is 0 and
  // an assumption, never known-false. (Whether the post also names Expo/EAS is the gate's
  // business, above.)
  const post = account.evidence.find((e) => e.agent === "discover-jobs");
  const hiring: Signal = { name: "hiring_signal", score: post ? 1 : 0 };
  if (post) {
    // Same claim and URL as discover-jobs' receipt, so a brief rendering both shows the
    // fact once — the convention production_evidence already follows.
    hiring.evidence = { claim: post.claim, url: post.url, agent: "qualify", date };
  }

  return [eas, rn, ci, team, activity, reviews, cadence, regulated, hiring];
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

function decisionFor(
  signals: Signal[],
  score: number,
  qualified: boolean,
  isUser: boolean,
  threshold: number,
): QualificationDecision {
  const visible = signals.map((signal) => ({
    name: signal.name,
    value: round2(signal.score),
    weight: WEIGHTS[signal.name],
    contribution: round4(signal.score * WEIGHTS[signal.name]),
    ...(signal.evidence ? { evidence_url: signal.evidence.url } : {}),
  }));
  const assumptions = signals
    .filter((signal) => !signal.evidence)
    .map((signal) => `No public evidence observed for ${signal.name}; counted as 0, not treated as known false.`);

  if (isUser) {
    assumptions.unshift("The GitHub namespace resolves to a person, not a company account.");
  }

  return {
    score,
    threshold,
    qualified,
    action: isUser ? "exclude" : qualified ? "brief" : "hold",
    signals: visible,
    assumptions,
    fallback: isUser
      ? "Exclude personal namespaces; require company or organization resolution before reconsidering."
      : qualified
        ? "Send to brief; the confidence gate may still require human review before publication."
        : "Hold; collect stronger production or company evidence, then rescore.",
  };
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

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
