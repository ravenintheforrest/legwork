// Public job boards, keyless. Same conventions as web.ts: every live call goes through the
// cached policy layer, fixture mode reads authored files, an absent fixture is an empty
// result, and a board that will not answer is an absent signal rather than a fault.
//
// Two kinds of source live here:
//  - a cross-company search (Remotive's public API) — genuine discovery;
//  - a company's own applicant-tracking board (Greenhouse / Lever / Ashby), read only when
//    we already hold an exact board URL for that company — confirmation and "why now".
//    Slugs are never guessed from a name: a collision would put another company's jobs
//    on a receipt.

import { join } from "node:path";
import type { FetchMode } from "./gh.js";
import type { HttpClient } from "./http.js";
import { CachedFetch, readJson } from "./web.js";
import { hostOf } from "./agents/naming.js";

export interface JobPost {
  title: string;
  url: string;
  company?: string;
  text: string;          // whatever description the source gave, as plain text
  posted?: string;       // ISO
}

export type AtsKind = "greenhouse" | "lever" | "ashby";
export interface AtsBoard {
  kind: AtsKind;
  slug: string;
}

const REMOTIVE_API = "https://remotive.com/api/remote-jobs";

export class JobBoards {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(opts: {
    mode: FetchMode;
    fixtureDir?: string;
    cacheDir?: string;
    http?: HttpClient;
    /** Injectable for tests: no DNS, no network. */
    fetchJson?: (url: string) => Promise<unknown>;
  }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    const fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
    this.fetchJson = opts.fetchJson ?? ((url) => fetcher.json<unknown>(url, { "User-Agent": "legwork (GTM research)" }));
  }

  // Remotive: one query, one public JSON document. Fixture: fixtures/jobs/remotive-<query>.json.
  async remotive(query: string): Promise<JobPost[]> {
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "jobs", `remotive-${slugOf(query)}.json`);
      return parseRemotive(readJson<unknown>(file));
    }
    const url = `${REMOTIVE_API}?search=${encodeURIComponent(query)}`;
    return parseRemotive(await this.safe(url));
  }

  // A company's own board, by exact slug. Fixture: fixtures/jobs/<kind>-<slug>.json.
  async board(board: AtsBoard): Promise<JobPost[]> {
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "jobs", `${board.kind}-${board.slug}.json`);
      return parseBoard(board.kind, readJson<unknown>(file));
    }
    return parseBoard(board.kind, await this.safe(boardUrl(board)));
  }

  private async safe(url: string): Promise<unknown> {
    try {
      return await this.fetchJson(url);
    } catch {
      return null;
    }
  }
}

export function boardUrl(board: AtsBoard): string {
  switch (board.kind) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug)}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(board.slug)}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug)}`;
  }
}

/** The board behind a careers or job-post URL, when the URL names one exactly. */
export function boardFromUrl(url: string): AtsBoard | null {
  const host = hostOf(url);
  if (!host) return null;
  let path: string[];
  try {
    path = new URL(url).pathname.split("/").filter((s) => s !== "");
  } catch {
    return null;
  }
  const slug = path[0];
  if (!slug || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(slug)) return null;
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return { kind: "greenhouse", slug: slug.toLowerCase() };
  if (host === "jobs.lever.co") return { kind: "lever", slug: slug.toLowerCase() };
  if (host === "jobs.ashbyhq.com") return { kind: "ashby", slug: slug.toLowerCase() };
  return null;
}

// --- parsers: tolerant of shape, strict about what they emit ---------------------------

function parseRemotive(data: unknown): JobPost[] {
  const jobs = (data as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: JobPost[] = [];
  for (const j of jobs as Array<Record<string, unknown>>) {
    const title = str(j.title);
    const url = str(j.url);
    if (!title || !url) continue;
    out.push({
      title,
      url,
      ...(str(j.company_name) ? { company: str(j.company_name)! } : {}),
      text: plain(str(j.description) ?? ""),
      ...(str(j.publication_date) ? { posted: str(j.publication_date)! } : {}),
    });
  }
  return out;
}

function parseBoard(kind: AtsKind, data: unknown): JobPost[] {
  const rows: Array<Record<string, unknown>> =
    kind === "lever"
      ? Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
      : Array.isArray((data as { jobs?: unknown[] } | null)?.jobs) ? ((data as { jobs: Array<Record<string, unknown>> }).jobs) : [];
  const out: JobPost[] = [];
  for (const j of rows) {
    const title = str(j.title) ?? str(j.text);
    const url = str(j.absolute_url) ?? str(j.hostedUrl) ?? str(j.jobUrl) ?? str(j.applyUrl);
    if (!title || !url) continue;
    const text = plain(str(j.content) ?? str(j.descriptionPlain) ?? str(j.description) ?? "");
    const posted = str(j.updated_at) ?? str(j.publishedAt) ?? (typeof j.createdAt === "number" ? new Date(j.createdAt).toISOString() : undefined);
    out.push({ title, url, text, ...(posted ? { posted } : {}) });
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// Boards serve HTML (Greenhouse escapes it, too); we only ever read words out of it.
export function plain(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(p|li|div|h\d)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function slugOf(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// --- web search through the Claude CLI ----------------------------------------------------
//
// The cross-company search the ATS boards do not offer. `claude -p` with the web search
// tool finds postings; the fleet then fetches every URL it returns and keeps only the ones
// that exist and name the stack. The search is Claude's, the receipt is ours — a link that
// does not resolve, or resolves to a page that never says React Native, is dropped here and
// never reaches a brief. Same switch as the model briefs (LEGWORK_LLM=cli); skipped, and
// said so, when the CLI is not the provider.

export interface SearchResult {
  title?: string;
  company?: string;
  url?: string;
  posted?: string;
}

export interface PostingSearch {
  /** Returns the CLI's text answer (expected to be a JSON array) and the tokens it cost. */
  search(prompt: string, model: string): Promise<{ text: string; tokens_in: number; tokens_out: number }>;
}

export interface SearchedPosts {
  posts: JobPost[];
  considered: number;
  tokens_in: number;
  tokens_out: number;
}

const MAX_SEARCH_RESULTS = 25;
const SEARCH_TIMEOUT_MS = 240_000;

export function searchPrompt(sinceDays: number): string {
  const window = sinceDays > 0 ? `published in the last ${sinceDays} days` : "published recently";
  return [
    `Use web search to find job postings ${window} for React Native or Expo engineers (titles like`,
    `"React Native Engineer", "Mobile Engineer (React Native)", "Expo developer"). Prefer postings hosted`,
    `on applicant-tracking boards — boards.greenhouse.io, job-boards.greenhouse.io, jobs.lever.co,`,
    `jobs.ashbyhq.com — or on a company's own careers page. Run several searches, for example:`,
    `site:boards.greenhouse.io "react native"; site:jobs.lever.co "react native"; site:jobs.ashbyhq.com expo;`,
    `"react native" engineer careers. Return ONLY a JSON array (no prose, no code fence) of up to`,
    `${MAX_SEARCH_RESULTS} objects with the keys "title", "company", "url", "posted" (ISO date if known,`,
    `else omit). "url" must be the posting page itself, copied exactly from a search result — never`,
    `guessed, never constructed. If you find nothing, return [].`,
  ].join(" ");
}

/** Parses the CLI's answer: the first JSON array in the text, tolerant of a code fence. */
export function parseSearchResults(text: string): SearchResult[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Record<string, unknown>>)
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      ...(str(r.title) ? { title: str(r.title)! } : {}),
      ...(str(r.company) ? { company: str(r.company)! } : {}),
      ...(str(r.url) ? { url: str(r.url)! } : {}),
      ...(str(r.posted) ? { posted: str(r.posted)! } : {}),
    }))
    .slice(0, MAX_SEARCH_RESULTS);
}

export class ClaudeCliSearch implements PostingSearch {
  async search(prompt: string, model: string): Promise<{ text: string; tokens_in: number; tokens_out: number }> {
    const { spawn } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", ["-p", "--output-format", "json", "--model", model, "--allowedTools", "WebSearch"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: SEARCH_TIMEOUT_MS,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`))));
      child.stdin.write(prompt);
      child.stdin.end();
    });
    const parsed = JSON.parse(stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; is_error?: boolean };
    if (parsed.is_error || typeof parsed.result !== "string") throw new Error("claude CLI returned an error result");
    return { text: parsed.result, tokens_in: parsed.usage?.input_tokens ?? 0, tokens_out: parsed.usage?.output_tokens ?? 0 };
  }
}

export class SearchedBoards {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly searcher: PostingSearch | null;
  private readonly fetchText: (url: string) => Promise<string | null>;
  private readonly boards: JobBoards;

  constructor(opts: {
    mode: FetchMode;
    fixtureDir?: string;
    cacheDir?: string;
    http?: HttpClient;
    /** Live search provider; null means "not available" and the feed is skipped. */
    searcher?: PostingSearch | null;
    /** Injectable for tests. */
    fetchText?: (url: string) => Promise<string | null>;
    boards?: JobBoards;
  }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.searcher = opts.searcher === undefined ? new ClaudeCliSearch() : opts.searcher;
    const fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
    this.fetchText = opts.fetchText ?? ((url) => fetcher.text(url, { "User-Agent": "legwork (GTM research)" }));
    this.boards = opts.boards ?? new JobBoards({ mode: opts.mode, fixtureDir: this.fixtureDir, cacheDir: opts.cacheDir, http: opts.http });
  }

  get available(): boolean {
    return this.mode === "fixture" || this.searcher !== null;
  }

  // Fixture: fixtures/jobs/search.json carries results already verified (with `text`).
  async find(sinceDays: number, model: string): Promise<SearchedPosts> {
    if (this.mode === "fixture") {
      const raw = readJson<{ results?: Array<SearchResult & { text?: string }> }>(join(this.fixtureDir, "jobs", "search.json"));
      const rows = raw?.results ?? [];
      const posts = rows
        .filter((r) => r.url && r.title)
        .map((r) => ({ title: r.title!, url: r.url!, ...(r.company ? { company: r.company } : {}), text: r.text ?? "", ...(r.posted ? { posted: r.posted } : {}) }));
      return { posts, considered: rows.length, tokens_in: 0, tokens_out: 0 };
    }
    if (!this.searcher) return { posts: [], considered: 0, tokens_in: 0, tokens_out: 0 };

    let answer: { text: string; tokens_in: number; tokens_out: number };
    try {
      answer = await this.searcher.search(searchPrompt(sinceDays), model);
    } catch {
      return { posts: [], considered: 0, tokens_in: 0, tokens_out: 0 }; // a search that fails is an absent feed, not a fault
    }
    const results = parseSearchResults(answer.text);
    const posts: JobPost[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (!r.url || !r.title || seen.has(r.url)) continue;
      seen.add(r.url);
      const verified = await this.verify(r);
      if (verified) posts.push(verified);
    }
    return { posts, considered: results.length, tokens_in: answer.tokens_in, tokens_out: answer.tokens_out };
  }

  // A result becomes a post only if the page is really there and really names the stack.
  // An ATS URL is checked against the board's own JSON (Ashby pages render client-side, so
  // their HTML says nothing); anything else by fetching the page.
  private async verify(r: SearchResult): Promise<JobPost | null> {
    const url = r.url!;
    let http: URL;
    try {
      http = new URL(url);
    } catch {
      return null;
    }
    if (http.protocol !== "https:") return null;

    const board = boardFromUrl(url);
    if (board) {
      const posts = await this.boards.board(board);
      const hit = posts.find((p) => sameUrl(p.url, url)) ?? posts.find((p) => p.title.trim().toLowerCase() === r.title!.trim().toLowerCase());
      if (!hit) return null;
      return { ...hit, ...(r.company ? { company: r.company } : {}) };
    }
    const html = await this.fetchText(url);
    if (!html) return null;
    const text = plain(html);
    return { title: r.title!, url, ...(r.company ? { company: r.company } : {}), text, ...(r.posted ? { posted: r.posted } : {}) };
  }
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
