// discover-jobs: companies hiring React Native / Expo engineers, read out of Hacker
// News "Ask HN: Who is hiring?" comments.
//
// Why the channel exists: public code search finds individuals. The companies running
// Expo in production keep their app repos private, so the eas.json sweep in `discover`
// structurally misses them. A salary attached to "Expo / EAS / React Native" is
// production evidence and budget evidence in one public signal, published by the
// company itself (rule 9 — public data only).
//
// Stateless reducer with the same contract as discover (F12): emits accounts at stage
// "discovered", unions new receipts into records it already knows, never regresses a
// stage, and returns only what it touched.

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { HnClient, type HnHit } from "../web.js";

// Algolia ANDs the words of a query, so each term is its own sweep and the hits are
// merged by objectID. Fixture mode replays one recording for all three.
const QUERIES = ["Expo", "EAS", "React Native"];

const WHO_IS_HIRING = /who is hiring/i;
const STACK = /\b(expo|eas|react[\s-]?native)\b/i;

// Company names are only read from the near-universal first-line format
// "Company | Location | Role | REMOTE | https://…". Everything else is skipped: an
// unparsed comment costs one lead, a misparsed one puts a wrong name on a receipt.
const MIN_FIELDS = 2;
const MAX_NAME_CHARS = 48;
const MAX_NAME_WORDS = 6;
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .,'’&!/+()-]*$/;
const YC_BATCH = /\s*\((?:YC\s*[SWFX]?\d{2})\)\s*$/i;
const MAX_QUOTE_CHARS = 160;

// Applicant-tracking and social hosts are shared by thousands of companies: keying an
// account on one would fuse unrelated companies into a single record. When a post's
// only link is one of these, the account is keyed by the company name instead.
const SHARED_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "breezy.hr",
  "recruitee.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "workday.com",
  "myworkdayjobs.com",
  "jobvite.com",
  "notion.so",
  "notion.site",
  "docs.google.com",
  "airtable.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "github.com",
  "gitlab.com",
  "ycombinator.com",
  "wellfound.com",
  "angel.co",
  "indeed.com",
];

interface Candidate {
  company: string;
  domain?: string;
  evidence: Evidence[];
}

interface Post {
  company: string;
  domain?: string;
  headline: string;
}

export const discoverJobs: AgentDef = {
  name: "discover-jobs",

  async run(input: Account[], ctx: RunContext): Promise<Account[]> {
    const hn = new HnClient({ mode: ctx.mode });
    const now = ctx.now();

    const hits = new Map<string, HnHit>();
    for (const query of QUERIES) {
      const result = await hn.whoIsHiring(query, ctx.sinceDays);
      for (const hit of result.hits) {
        if (!hits.has(hit.objectID)) hits.set(hit.objectID, hit);
      }
    }

    const candidates = new Map<string, Candidate>();
    for (const hit of hits.values()) {
      const story = hit.story_title ?? "";
      if (!WHO_IS_HIRING.test(story)) continue;

      const text = plainText(hit.comment_text ?? "");
      if (!STACK.test(text)) continue;

      const post = parsePost(text);
      if (!post) continue; // no confident company name: skip the comment rather than guess

      const key = post.domain ?? slugify(post.company);
      if (!key) continue;

      const candidate = candidates.get(key) ?? {
        company: post.company,
        ...(post.domain ? { domain: post.domain } : {}),
        evidence: [],
      };
      candidate.evidence.push({
        claim: `hiring React Native engineers in "${story}": "${post.headline}"`,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        agent: "discover-jobs",
        date: now,
      });
      candidates.set(key, candidate);
    }

    const known = new Map(input.map((account) => [account.org, account]));
    const out: Account[] = [];

    for (const key of [...candidates.keys()].sort()) {
      const candidate = candidates.get(key)!;
      const existing = known.get(key);

      if (!existing) {
        out.push({
          org: key,
          ...(candidate.domain ? { domain: candidate.domain } : {}),
          company: candidate.company,
          stage: "discovered",
          evidence: candidate.evidence,
          updated: now,
        });
        continue;
      }

      // Known account (discover got there first, or a prior run did): union only, and
      // never overwrite a name or domain someone else already resolved.
      const seen = new Set(existing.evidence.map((e) => e.url));
      const fresh = candidate.evidence.filter((e) => !seen.has(e.url));
      if (fresh.length === 0) continue;
      out.push({
        ...existing,
        evidence: [...existing.evidence, ...fresh],
        updated: now,
      });
    }

    return out;
  },
};

// HN serves comment_text as escaped HTML with <p> separators.
function plainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[^\S\n]+/g, " ");
}

function parsePost(text: string): Post | null {
  const headline = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!headline) return null;

  const fields = headline.split("|").map((f) => f.trim()).filter((f) => f !== "");
  if (fields.length < MIN_FIELDS) return null; // not the pipe format: nothing to key on

  const company = companyName(fields[0]!);
  if (!company) return null;

  const domain = domainFrom(text);
  return {
    company,
    ...(domain ? { domain } : {}),
    headline: headline.length > MAX_QUOTE_CHARS ? `${headline.slice(0, MAX_QUOTE_CHARS - 1)}…` : headline,
  };
}

// Conservative by construction: anything that does not look like a name is refused, and
// a refusal drops the comment.
function companyName(field: string): string | null {
  const name = field.replace(YC_BATCH, "").replace(/^["'*`\s]+|["'*`\s]+$/g, "").trim();
  if (!name || name.length > MAX_NAME_CHARS) return null;
  if (!/[A-Za-z]/.test(name)) return null;
  if (/^https?:/i.test(name)) return null;
  if (!NAME_SHAPE.test(name)) return null;
  if (name.split(/\s+/).length > MAX_NAME_WORDS) return null;
  return name;
}

function domainFrom(text: string): string | undefined {
  for (const raw of text.match(/https?:\/\/[^\s<>()[\],"']+/g) ?? []) {
    let host: string;
    try {
      host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (!host.includes(".")) continue;
    if (SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))) continue;
    return host;
  }
  return undefined;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
