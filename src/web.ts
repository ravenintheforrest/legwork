// The non-GitHub fetch layer: company homepages and HN Algolia. Same conventions as
// gh.ts — every external call goes through here, fixture mode reads authored files,
// live mode read-through-caches under data/cache so a re-run is free.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchMode } from "./gh.js";

interface CacheEntry {
  url: string;
  fetched_at: string;
  status: number;
  body: unknown;
}

// Shared read-through cache for the small clients in this file (and gitlab.ts).
export class CachedFetch {
  constructor(private readonly cacheDir: string) {}

  // JSON GET; 404s cached as null, other failures throw (the runner owns retries).
  async json<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
    return this.get<T>(url, headers, async (r) => (await r.json()) as T);
  }

  // Text GET for HTML pages; any non-ok status caches as null — a homepage that will
  // not serve us is an absent signal, not a pipeline fault.
  async text(url: string, headers: Record<string, string> = {}): Promise<string | null> {
    try {
      return await this.get<string>(url, headers, (r) => r.text());
    } catch {
      return null;
    }
  }

  private async get<T>(
    url: string,
    headers: Record<string, string>,
    read: (r: Response) => Promise<T>,
  ): Promise<T | null> {
    const cached = this.readCache(url);
    if (cached) return cached.status === 404 ? null : (cached.body as T);

    const response = await fetch(url, { headers, redirect: "follow" });
    if (response.status === 404) {
      this.writeCache({ url, fetched_at: new Date().toISOString(), status: 404, body: null });
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`GET ${url} → ${response.status}: ${text}`);
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

  constructor(opts: { mode: FetchMode; fixtureDir?: string; cacheDir?: string }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.fetcher = new CachedFetch(opts.cacheDir ?? "data/cache");
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

export class HnClient {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetcher: CachedFetch;

  constructor(opts: { mode: FetchMode; fixtureDir?: string; cacheDir?: string }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.fetcher = new CachedFetch(opts.cacheDir ?? "data/cache");
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
}
