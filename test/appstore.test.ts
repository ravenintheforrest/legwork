import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StoreSignals, belongsTo, normalizeName, storeCadence } from "../src/appstore.js";

const results = [
  { trackName: "Dusk.fm", sellerName: "BeatGig, LLC", sellerUrl: "https://www.dusk.fm", artistName: "BeatGig, LLC", userRatingCount: 144, version: "35.0.0", currentVersionReleaseDate: "2026-08-13T19:45:56Z", trackViewUrl: "https://apps.apple.com/us/app/dusk-fm/id1355182285?uo=4" },
  { trackName: "BeatStars", sellerName: "BeatStars Inc.", sellerUrl: "https://www.beatstars.com", artistName: "BeatStars Inc.", userRatingCount: 79750, version: "5.14.4", currentVersionReleaseDate: "2026-07-20T15:53:35Z", trackViewUrl: "https://apps.apple.com/us/app/beatstars/id1436154382?uo=4" },
  { trackName: "BeatGig Venues", sellerName: "BeatGig, LLC", sellerUrl: "https://beatgig.com", artistName: "BeatGig, LLC", userRatingCount: 1800, version: "4.2.0", currentVersionReleaseDate: "2026-06-01T00:00:00Z", trackViewUrl: "https://apps.apple.com/us/app/beatgig/id1524340972?uo=4" },
];

function live(calls: string[] = []) {
  return new StoreSignals({
    mode: "live",
    fetchJson: async (url) => {
      calls.push(url);
      return { resultCount: results.length, results };
    },
  });
}

test("appstore live: matches by seller domain or exact name, never by resemblance; most-rated wins", async () => {
  const calls: string[] = [];
  const record = await live(calls).lookup("beatgig", { company: "BeatGig", domain: "beatgig.com" });
  assert.ok(record);
  assert.equal(record.app_name, "BeatGig Venues"); // both BeatGig apps match; the one with more ratings wins
  assert.equal(record.review_count, 1800);
  assert.equal(record.store_url, "https://apps.apple.com/us/app/beatgig/id1524340972"); // tracking query stripped
  assert.equal(record.last_update, "2026-06-01T00:00:00Z");
  assert.equal(record.updates_last_90d, undefined); // the public API does not know this
  assert.ok(calls[0]!.startsWith("https://itunes.apple.com/search?term=BeatGig&entity=software"));

  // "Beat" resembles both sellers and matches neither
  assert.equal(await live().lookup("beat", { company: "Beat" }), null);
  // a domain match alone is enough
  const byDomain = await live().lookup("whatever", { company: "Something Else", domain: "www.beatstars.com" });
  assert.equal(byDomain?.app_name, "BeatStars");
});

test("appstore live: an unanswering store is an absent signal, not a fault", async () => {
  const broken = new StoreSignals({ mode: "live", fetchJson: async () => { throw new Error("boom"); } });
  assert.equal(await broken.lookup("x", { company: "X Co" }), null);
  const empty = new StoreSignals({ mode: "live", fetchJson: async () => ({ resultCount: 0, results: [] }) });
  assert.equal(await empty.lookup("x", { company: "X Co" }), null);
});

test("appstore fixture: keyed by org from the fixture dir, no fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legwork-store-"));
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "store", "acme.json"), JSON.stringify({ org: "acme", app_name: "Acme", store_url: "https://apps.apple.com/us/app/acme/id1", review_count: 12, updates_last_90d: 2 }));
  const store = new StoreSignals({ mode: "fixture", fixtureDir: dir, fetchJson: async () => { throw new Error("must not fetch"); } });
  assert.equal((await store.lookup("acme"))?.review_count, 12);
  assert.equal(await store.lookup("nobody"), null);
});

test("appstore: cadence scores a 90-day count or a last ship date, and words the claim to match", () => {
  const now = "2026-08-23T00:00:00Z";
  assert.deepEqual(storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0, updates_last_90d: 4 }, now), { score: 1, claim: "4 App Store releases in the last 90 days" });
  assert.equal(storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0, updates_last_90d: 0 }, now)?.score, 0);
  const recent = storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0, last_update: "2026-08-13T19:45:56Z", version: "35.0.0" }, now);
  assert.equal(recent?.score, 1);
  assert.equal(recent?.claim, "A last shipped an App Store update on 2026-08-13 (version 35.0.0)");
  assert.equal(storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0, last_update: "2026-06-20T00:00:00Z" }, now)?.score, 0.5);
  assert.equal(storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0, last_update: "2025-01-01T00:00:00Z" }, now)?.score, 0);
  assert.equal(storeCadence({ org: "a", app_name: "A", store_url: "u", review_count: 0 }, now), null);
});

test("appstore: name normalization strips legal suffixes and punctuation only", () => {
  assert.equal(normalizeName("BeatGig, LLC"), "beatgig");
  assert.equal(normalizeName("Rap Tech Studios Ltd"), "raptechstudios");
  assert.equal(normalizeName("Cooperative Co."), "cooperative");
  assert.ok(belongsTo({ sellerName: "Partiful Inc." }, "partiful", {}));
  assert.ok(!belongsTo({ sellerName: "Partifully" }, "partiful", {}));
});
