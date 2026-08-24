// App-store signals: the public MAU/build proxies EAS bills on (see packs/expo/icp.yaml).
//
// Live mode reads Apple's public, keyless Search API (itunes.apple.com/search). It answers
// with the seller's name and website, the rating count, and when the current version
// shipped — enough for the two store signals, each with apps.apple.com as its receipt. It
// does not expose release history, so live cadence is "when did it last ship", not "how
// many times in 90 days"; the record says which one it knows and qualify scores it as such.
//
// Matching is strict on purpose: the seller's website must be the account's domain, or the
// seller's name must equal the company name once legal suffixes are stripped. A similar
// name is a guess, and a guess is not a receipt — better no store signal than the wrong app.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchMode } from "./gh.js";
import type { HttpClient } from "./http.js";
import { CachedFetch } from "./web.js";

export interface StoreRecord {
  org: string;
  app_name: string;
  store_url: string;
  review_count: number;
  /** Releases in the last 90 days — authored fixtures know this; the public API does not. */
  updates_last_90d?: number;
  /** When the current version shipped — what the public API does tell us. */
  last_update?: string;
  version?: string;
}

/** One row of the iTunes Search API's `results`, the fields we read. */
export interface ItunesApp {
  trackName?: string;
  trackViewUrl?: string;
  sellerName?: string;
  sellerUrl?: string;
  artistName?: string;
  userRatingCount?: number;
  version?: string;
  currentVersionReleaseDate?: string;
}

export interface StoreHints {
  company?: string;
  domain?: string;
}

const SEARCH_API = "https://itunes.apple.com/search";
const SEARCH_LIMIT = 25;
const DAY_MS = 86_400_000;

export class StoreSignals {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(opts: {
    mode: FetchMode;
    fixtureDir?: string;
    cacheDir?: string;
    http?: HttpClient;
    /** Injectable for tests: replaces the cached HTTP fetch, so no DNS and no network. */
    fetchJson?: (url: string) => Promise<unknown>;
  }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    const fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
    this.fetchJson = opts.fetchJson ?? ((url) => fetcher.json<unknown>(url, { "User-Agent": "legwork (GTM research)" }));
  }

  // Fixtures are keyed by org. Live searches by company name and keeps only a result that
  // provably belongs to the account (domain or exact name); null is the honest outcome.
  async lookup(org: string, hints: StoreHints = {}): Promise<StoreRecord | null> {
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "store", `${org}.json`);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, "utf8")) as StoreRecord;
    }

    const term = (hints.company ?? org).trim();
    if (!term) return null;
    const url = `${SEARCH_API}?term=${encodeURIComponent(term)}&entity=software&limit=${SEARCH_LIMIT}&country=us`;
    let data: unknown;
    try {
      data = await this.fetchJson(url);
    } catch {
      return null; // a store that will not answer is an absent signal, not a pipeline fault
    }
    const results = Array.isArray((data as { results?: unknown })?.results) ? ((data as { results: ItunesApp[] }).results) : [];
    const matches = results.filter((app) => belongsTo(app, org, hints));
    if (matches.length === 0) return null;
    matches.sort((a, b) => (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0));
    return toRecord(org, matches[0]!);
  }
}

/** Cadence from whichever fact the record carries: a 90-day count (fixtures) or the last ship date (live). */
export function storeCadence(record: StoreRecord, nowIso: string): { score: number; claim: string } | null {
  if (typeof record.updates_last_90d === "number") {
    const n = record.updates_last_90d;
    return { score: n >= 4 ? 1 : n >= 1 ? 0.5 : 0, claim: `${n} App Store releases in the last 90 days` };
  }
  if (record.last_update) {
    const then = Date.parse(record.last_update);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
    const days = Math.max(0, Math.floor((now - then) / DAY_MS));
    const score = days <= 30 ? 1 : days <= 90 ? 0.5 : 0;
    const when = record.last_update.slice(0, 10);
    return {
      score,
      claim: `${record.app_name} last shipped an App Store update on ${when}${record.version ? ` (version ${record.version})` : ""}`,
    };
  }
  return null;
}

// --- matching -------------------------------------------------------------------------

export function belongsTo(app: ItunesApp, org: string, hints: StoreHints): boolean {
  const sellerHost = hostOf(app.sellerUrl);
  if (hints.domain && sellerHost && sellerHost === hints.domain.toLowerCase().replace(/^www\./, "")) return true;
  const names = [hints.company, org].map(normalizeName).filter((n) => n.length >= 3);
  const sellers = [app.sellerName, app.artistName].map(normalizeName).filter((n) => n.length >= 3);
  return names.some((n) => sellers.includes(n));
}

const LEGAL_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sas|sa|bv|ab|oy|pty|plc|srl|s\.?r\.?l)\b\.?/g;

export function normalizeName(name: string | undefined | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function toRecord(org: string, app: ItunesApp): StoreRecord {
  const storeUrl = (app.trackViewUrl ?? "").replace(/\?.*$/, "");
  const record: StoreRecord = {
    org,
    app_name: app.trackName ?? org,
    store_url: storeUrl || `https://apps.apple.com/us/search?term=${encodeURIComponent(org)}`,
    review_count: Math.max(0, Math.floor(app.userRatingCount ?? 0)),
  };
  if (app.currentVersionReleaseDate) record.last_update = app.currentVersionReleaseDate;
  if (app.version) record.version = app.version;
  return record;
}
