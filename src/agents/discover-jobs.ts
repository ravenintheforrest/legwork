// discover-jobs: companies hiring React Native / Expo engineers, read out of public job
// boards — Hacker News "Ask HN: Who is hiring?" comments, Remotive's public search API, a
// web search run through the Claude CLI (every hit re-fetched and verified here before it
// counts), and, for companies we already hold an exact board URL for, their own
// Greenhouse / Lever / Ashby board.
//
// Why the channel exists: public code search finds individuals. The companies running
// Expo in production keep their app repos private, so the eas.json sweep in `discover`
// structurally misses them. A salary attached to "Expo / EAS / React Native" is
// production evidence and budget evidence in one public signal, published by the
// company itself (rule 9 — public data only). A post that names Expo or EAS is the
// company saying, in its own words, that it builds on them; qualify treats that as
// production evidence. A post that names only React Native is hiring evidence.
//
// Stateless reducer with the same contract as discover (F12): emits accounts at stage
// "discovered", unions new receipts into records it already knows, never regresses a
// stage, and returns only what it touched.

import type { Account, AgentDef, Evidence, RunContext } from "../types.js";
import { invalidateDerived, sourceFingerprint, withSourceState } from "../freshness.js";
import { JobBoards, SearchedBoards, boardFromUrl, type AtsBoard, type JobPost } from "../jobs.js";
import { effective, loadRegistry } from "../registry.js";
import { HnClient, type HnHit } from "../web.js";
import { STACK, companyName, domainFrom, quote, slugify, stackTerms } from "./naming.js";

// Algolia ANDs the words of a query, so each term is its own sweep and the hits are
// merged by objectID. Fixture mode replays one recording for all three.
const HN_QUERIES = ["Expo", "EAS", "React Native"];
const REMOTIVE_QUERIES = ["expo", "react native"];
const WHO_IS_HIRING = /who is hiring/i;
const MIN_FIELDS = 2;
const MAX_BOARD_POSTS = 3;
const DAY_MS = 86_400_000;

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
    const fx = ctx.fixtureDir ? { fixtureDir: ctx.fixtureDir } : {};
    const hn = new HnClient({ mode: ctx.mode, ...fx });
    const boards = new JobBoards({ mode: ctx.mode, ...fx });
    // The web-search feed rides the same switch as model briefs: only the Claude CLI runs it.
    const searched = new SearchedBoards({ mode: ctx.mode, ...fx, boards, ...(ctx.mode === "live" && process.env.LEGWORK_LLM !== "cli" ? { searcher: null } : {}) });
    const now = ctx.now();
    const candidates = new Map<string, Candidate>();

    // --- HN "who is hiring" -------------------------------------------------------------
    const hits = new Map<string, HnHit>();
    for (const query of HN_QUERIES) {
      const result = await hn.whoIsHiring(query, ctx.sinceDays);
      for (const hit of result.hits) if (!hits.has(hit.objectID)) hits.set(hit.objectID, hit);
    }
    for (const hit of hits.values()) {
      const story = hit.story_title ?? "";
      if (!WHO_IS_HIRING.test(story)) continue;
      const text = plainText(hit.comment_text ?? "");
      if (!STACK.test(text)) continue;
      const post = parsePost(text);
      if (!post) continue; // no confident company name: skip the comment rather than guess
      add(candidates, post, {
        claim: `hiring for ${terms(text)} in "${story}": "${post.headline}"`,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        agent: "discover-jobs",
        date: now,
      });
    }

    // --- Remotive (public search API) -----------------------------------------------------
    const seenJobs = new Set<string>();
    for (const query of REMOTIVE_QUERIES) {
      for (const job of await boards.remotive(query)) {
        if (seenJobs.has(job.url)) continue;
        seenJobs.add(job.url);
        if (!withinWindow(job.posted, now, ctx.sinceDays)) continue;
        const text = `${job.title}\n${job.text}`;
        if (!STACK.test(text)) continue;
        const company = job.company ? companyName(job.company) : null;
        if (!company) continue;
        const domain = domainFrom(job.text);
        add(candidates, { company, ...(domain ? { domain } : {}), headline: quote(job.title) }, {
          claim: `hiring for ${terms(text)} on Remotive: "${quote(job.title)}"`,
          url: job.url,
          agent: "discover-jobs",
          date: now,
        });
      }
    }

    // --- web search through the Claude CLI, every hit verified by fetching it -----------------
    if (searched.available) {
      const model = searchModel();
      const found = await searched.find(ctx.sinceDays, model);
      if (found.tokens_in + found.tokens_out > 0) ctx.costs.charge(model, found.tokens_in, found.tokens_out);
      for (const job of found.posts) {
        if (seenJobs.has(job.url)) continue;
        seenJobs.add(job.url);
        if (!withinWindow(job.posted, now, ctx.sinceDays)) continue;
        const text = `${job.title}\n${job.text}`;
        if (!STACK.test(text)) continue;
        const company = job.company ? companyName(job.company) : null;
        if (!company) continue;
        const domain = domainFrom(job.text);
        add(candidates, { company, ...(domain ? { domain } : {}), headline: quote(job.title) }, {
          claim: `hiring for ${terms(text)}, found by web search and verified on the posting: "${quote(job.title)}"`,
          url: job.url,
          agent: "discover-jobs",
          date: now,
        });
      }
    } else if (ctx.mode === "live") {
      console.log("  · discover-jobs: web search feed skipped — set LEGWORK_LLM=cli to let the Claude CLI search (every hit is verified here)");
    }

    // --- the company's own board, when we hold an exact URL for it ------------------------
    // Receipts from enrich (a careers link) or an earlier post may name a board. Read it,
    // keep the RN/Expo roles, attach them to that account. Slugs are never guessed.
    const out: Account[] = [];
    const known = new Map(input.map((account) => [account.org, account]));
    for (const account of input) {
      const board = boardOf(account);
      if (!board) continue;
      const posts = (await boards.board(board)).filter((p) => STACK.test(`${p.title}\n${p.text}`)).slice(0, MAX_BOARD_POSTS);
      if (posts.length === 0) continue;
      const fresh = posts.map((p) => ({
        claim: `hiring for ${terms(`${p.title}\n${p.text}`)} on its own ${board.kind} board: "${quote(p.title)}"`,
        url: p.url,
        agent: "discover-jobs",
        date: now,
      }));
      const candidate = candidates.get(account.org) ?? { company: account.company ?? account.org, ...(account.domain ? { domain: account.domain } : {}), evidence: [] };
      candidate.evidence.push(...fresh);
      candidates.set(account.org, candidate);
    }

    // --- emit: new accounts, or unions into known ones ----------------------------------
    for (const key of [...candidates.keys()].sort()) {
      const candidate = candidates.get(key)!;
      const existing = known.get(key);
      if (!existing) {
        out.push(withSourceState({
          org: key,
          ...(candidate.domain ? { domain: candidate.domain } : {}),
          company: candidate.company,
          stage: "discovered",
          evidence: candidate.evidence,
          updated: now,
        }));
        continue;
      }
      // Known account (discover got there first, or a prior run did): union only, and
      // never overwrite a name or domain someone else already resolved.
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

// The cheap tier unless the registry routes this unit elsewhere; the search is a tool call,
// not a judgment, so it does not earn a better model.
function searchModel(): string {
  try {
    return effective(loadRegistry(), "discover-jobs").model;
  } catch {
    return "claude-haiku-4-5-20251001";
  }
}

function add(candidates: Map<string, Candidate>, post: Post, evidence: Evidence): void {
  const key = post.domain ?? slugify(post.company);
  if (!key) return;
  const candidate = candidates.get(key) ?? { company: post.company, ...(post.domain ? { domain: post.domain } : {}), evidence: [] };
  candidate.evidence.push(evidence);
  candidates.set(key, candidate);
}

/** "Expo, EAS" / "React Native" — what the post actually names, for the claim. */
function terms(text: string): string {
  return stackTerms(text).join(", ") || "React Native";
}

function boardOf(account: Account): AtsBoard | null {
  for (const e of account.evidence) {
    const board = boardFromUrl(e.url);
    if (board) return board;
  }
  return null;
}

function withinWindow(posted: string | undefined, nowIso: string, sinceDays: number): boolean {
  if (sinceDays <= 0 || !posted) return true;
  const at = Date.parse(posted);
  return Number.isNaN(at) || Date.parse(nowIso) - at <= sinceDays * DAY_MS;
}

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

// Company names are only read from the near-universal first-line format
// "Company | Location | Role | REMOTE | https://…". Everything else is skipped.
function parsePost(text: string): Post | null {
  const headline = text.split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (!headline) return null;
  const fields = headline.split("|").map((f) => f.trim()).filter((f) => f !== "");
  if (fields.length < MIN_FIELDS) return null; // not the pipe format: nothing to key on
  const company = companyName(fields[0]!);
  if (!company) return null;
  const domain = domainFrom(text);
  return { company, ...(domain ? { domain } : {}), headline: quote(headline) };
}

export type { JobPost };
