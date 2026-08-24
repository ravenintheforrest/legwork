// The non-GitHub fetch layer: company homepages and HN Algolia. Same conventions as
// gh.ts — every external call goes through here, fixture mode reads authored files,
// live mode read-through-caches under data/cache so a re-run is free.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchMode } from "./gh.js";
import { sharedHttp, type HttpClient } from "./http.js";
import { assertPublicUrl } from "./netguard.js";

interface CacheEntry {
  url: string;
  fetched_at: string;
  status: number;
  body: unknown;
}

// Every status a redirect hop can carry: handed back by the policy layer instead of
// thrown, because this loop — not the policy layer — owns redirect revalidation.
const REDIRECT_STATUSES = Array.from({ length: 100 }, (_, i) => 300 + i);

// Shared read-through cache for the small clients in this file (and gitlab.ts).
export class CachedFetch {
  constructor(
    private readonly cacheDir: string,
    /** Injectable for tests; live code shares one policy layer (rate limits, caps). */
    private readonly injectedHttp?: HttpClient,
  ) {}

  private http(): HttpClient {
    return this.injectedHttp ?? sharedHttp();
  }

  // JSON GET; 404s cached as null, other failures throw (the runner owns retries).
  async json<T>(url: string, headers: Record<string, string> = {}, maxAgeMs = 6 * 60 * 60_000): Promise<T | null> {
    return this.get<T>(url, headers, async (r) => (await r.json()) as T, maxAgeMs);
  }

  // Text GET for HTML pages; any non-ok status caches as null — a homepage that will
  // not serve us is an absent signal, not a pipeline fault.
  async text(url: string, headers: Record<string, string> = {}, maxAgeMs = 24 * 60 * 60_000): Promise<string | null> {
    try {
      return await this.get<string>(url, headers, (r) => r.text(), maxAgeMs);
    } catch {
      return null;
    }
  }

  private async get<T>(
    url: string,
    headers: Record<string, string>,
    read: (r: Response) => Promise<T>,
    maxAgeMs: number,
  ): Promise<T | null> {
    const cached = this.readCache(url);
    if (cached && Date.now() - Date.parse(cached.fetched_at) < maxAgeMs) {
      return cached.status === 404 ? null : (cached.body as T);
    }

    let current = new URL(url);
    let response: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      if (current.protocol !== "https:") throw new Error(`refusing non-https URL ${current.href}`);
      await assertPublicUrl(current);
      // Retries, backoff, and the rate-limit gate live in the policy layer; the netguard
      // check above still runs per hop, before anything is sent.
      response = await this.http().request(current, {
        headers,
        redirect: "manual",
        accept: [...REDIRECT_STATUSES, 404],
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error(`redirect from ${current.hostname} has no location`);
      current = new URL(location, current);
    }
    if (!response || (response.status >= 300 && response.status < 400)) throw new Error("too many redirects");
    if (response.status === 404) {
      this.writeCache({ url, fetched_at: new Date().toISOString(), status: 404, body: null });
      return null;
    }
    const body = await read(response);
    this.writeCache({ url, fetched_at: new Date().toISOString(), status: response.status, body });
    return body;
  }

  private cachePath(url: string): string {
    return join(this.cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  private readCache(url: string): CacheEntry | null {
    return readJson<CacheEntry>(this.cachePath(url));
  }

  private writeCache(entry: CacheEntry): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.cachePath(entry.url), JSON.stringify(entry));
  }
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null; // absence of a fixture is a 404
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// --- company homepage -------------------------------------------------------------

export interface HomePage {
  url: string;
  title?: string;
  description?: string;   // meta description — "what the company does", in their words
  careers_url?: string;   // first careers/jobs link found on the homepage
}

export class WebClient {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetcher: CachedFetch;

  constructor(opts: { mode: FetchMode; fixtureDir?: string; cacheDir?: string; http?: HttpClient }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
  }

  // Fixtures are keyed by org (like fixtures/store/); live fetches the domain root.
  async homepage(org: string, domain: string): Promise<HomePage | null> {
    if (this.mode === "fixture") {
      return readJson<HomePage>(join(this.fixtureDir, "web", `${org}.json`));
    }
    const url = `https://${domain}/`;
    const html = await this.fetcher.text(url, { "User-Agent": "legwork (GTM research)" });
    if (!html) return null;
    return parseHomePage(url, html);
  }
}

// Best-effort regex extraction — enough for a title and a meta description; anything
// the regexes miss is an absent signal, never a guess.
function parseHomePage(url: string, html: string): HomePage {
  const page: HomePage = { url };

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) page.title = clean(title);

  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1];
  if (description) page.description = clean(description);

  const careers = /href=["']([^"'#?]*(?:careers|jobs)[^"']*)["']/i.exec(html)?.[1];
  if (careers) {
    try {
      page.careers_url = new URL(careers, url).toString();
    } catch {
      /* unresolvable href: no claim */
    }
  }

  return page;
}

function clean(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// --- HN Algolia -------------------------------------------------------------------

export interface HnHit {
  objectID: string;
  story_title?: string | null;
  comment_text?: string | null;
  title?: string | null;
  author?: string;
  created_at?: string;
}

export interface HnResult {
  hits: HnHit[];
}

const HN_API = "https://hn.algolia.com/api/v1/search";
const HN_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

export class HnClient {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetcher: CachedFetch;

  constructor(opts: { mode: FetchMode; fixtureDir?: string; cacheDir?: string; http?: HttpClient }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
  }

  // Fixture mode records one canned result per org regardless of the query — the same
  // documented limitation as gh.searchCode.
  async search(org: string, query: string): Promise<HnResult> {
    if (this.mode === "fixture") {
      return readJson<HnResult>(join(this.fixtureDir, "hn", `${org}.json`)) ?? { hits: [] };
    }
    const url = `${HN_API}?query=${encodeURIComponent(query)}&tags=comment`;
    return (await this.fetcher.json<HnResult>(url)) ?? { hits: [] };
  }

  // "Ask HN: Who is hiring?" is a channel, not an account, so it gets one fixture for
  // the whole sweep (fixtures/hn/whoishiring.json) rather than one file per org. As
  // with search(), fixture mode replays that one recording whatever the query was.
  // sinceDays > 0 bounds the live sweep to recent threads; the cutoff is floored to a
  // UTC day so the URL — and therefore the cache key — is stable within a day.
  // Fixture mode ignores the window entirely, so the demo stays deterministic.
  async whoIsHiring(query: string, sinceDays = 0): Promise<HnResult> {
    if (this.mode === "fixture") {
      return readJson<HnResult>(join(this.fixtureDir, "hn", "whoishiring.json")) ?? { hits: [] };
    }
    const params = [
      `query=${encodeURIComponent(query)}`,
      "tags=comment",
      `hitsPerPage=${HN_PAGE_SIZE}`,
    ];
    if (sinceDays > 0) {
      const cutoff = Math.floor((Date.now() - sinceDays * DAY_MS) / DAY_MS) * (DAY_MS / 1000);
      params.push(`numericFilters=${encodeURIComponent(`created_at_i>${cutoff}`)}`);
    }
    return (await this.fetcher.json<HnResult>(`${HN_API}?${params.join("&")}`)) ?? { hits: [] };
  }
}
