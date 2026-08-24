// The shared HTTP policy layer: rate-limit awareness, bounded backoff, a concurrency
// cap, and a per-run budget. Everything here runs on a stub fetch and a fake clock —
// no sockets, no timers, no waiting.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpClient, HttpError, HTTP_DEFAULTS, httpBudget, retryAfterMs, type HttpBudget, type HttpPolicy } from "../src/http.js";
import { GitHubClient } from "../src/gh.js";
import { GitLabClient } from "../src/gitlab.js";
import { HnClient, WebClient } from "../src/web.js";
import { deferred, fakeClock, noSleepClock, settle, type FakeClock } from "./helpers/clock.js";
import { REPO_ROOT } from "./helpers/env.js";

type Responder = (url: URL, attempt: number) => Response | Promise<Response>;

interface Harness {
  http: HttpClient;
  clock: FakeClock;
  budget: HttpBudget;
  calls: () => number;
}

/** `jitter: 1` pins full-jitter backoff to its cap, so delays are exact, not flaky. */
function harness(responder: Responder, policy: Partial<HttpPolicy> = {}, jitter = 1): Harness {
  const clock = fakeClock();
  const budget: HttpBudget = { requests: 0, attempts: 0, retries: 0, rate_limit_hits: 0, wait_ms: 0, failures: 0 };
  let calls = 0;
  const http = new HttpClient({
    policy,
    budget,
    deps: {
      now: clock.now,
      sleep: clock.sleep,
      jitter: () => jitter,
      fetch: async (input) => {
        calls++;
        return responder(new URL(String(input)), calls);
      },
    },
  });
  return { http, clock, budget, calls: () => calls };
}

function queue(...responses: Array<() => Response>): Responder {
  return (_url, attempt) => {
    const next = responses[Math.min(attempt, responses.length) - 1]!;
    return next();
  };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
  () => new Response("upstream said no", { status: code, headers });

test("Retry-After in seconds is honored on a 429, then the request succeeds", async () => {
  const h = harness(queue(status(429, { "retry-after": "2" }), ok));
  const response = await h.http.request("https://api.github.com/orgs/expo");
  assert.equal(response.status, 200);
  assert.deepEqual(h.clock.slept, [2000], "the server's Retry-After wins over our backoff");
  assert.equal(h.budget.requests, 1);
  assert.equal(h.budget.attempts, 2);
  assert.equal(h.budget.retries, 1);
  assert.equal(h.budget.rate_limit_hits, 1);
  assert.equal(h.budget.wait_ms, 2000);
});

test("Retry-After as an HTTP-date is honored", async () => {
  const clockStart = 1_700_000_000_000;
  const when = new Date(clockStart + 5_000).toUTCString();
  const h = harness(queue(status(503, { "retry-after": when }), ok));
  const response = await h.http.request("https://hn.algolia.com/api/v1/search");
  assert.equal(response.status, 200);
  assert.deepEqual(h.clock.slept, [5000]);
});

test("retryAfterMs reads seconds and dates, and refuses nonsense", () => {
  const now = 1_700_000_000_000;
  assert.equal(retryAfterMs("30", now), 30_000);
  assert.equal(retryAfterMs(new Date(now + 1_000).toUTCString(), now), 1_000);
  assert.equal(retryAfterMs(new Date(now - 90_000).toUTCString(), now), 0, "a past date is not a negative sleep");
  assert.equal(retryAfterMs("soon", now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test("backoff is exponential, jittered, bounded per attempt, and gives up loudly", async () => {
  const h = harness(queue(status(503), status(503), status(503), status(503)));
  const err = await h.http.request("https://gitlab.com/api/v4/projects").then(
    () => null,
    (e: unknown) => e as HttpError,
  );
  assert.ok(err instanceof HttpError);
  assert.equal(h.calls(), HTTP_DEFAULTS.maxAttempts, "a small, fixed number of attempts");
  assert.deepEqual(h.clock.slept, [500, 1000, 2000], "base 500ms doubling, capped at the max delay");
  for (const ms of h.clock.slept) assert.ok(ms <= HTTP_DEFAULTS.maxDelayMs);
  assert.ok(h.clock.total() <= HTTP_DEFAULTS.maxTotalWaitMs, "total wait stays under the per-request ceiling");
  // Loud: host, status, attempts, and time waited all in one line.
  assert.match(err.message, /gitlab\.com/);
  assert.match(err.message, /status 503/);
  assert.match(err.message, /4 attempts/);
  assert.match(err.message, /3\.5s waited/);
  assert.equal(err.failure, "server_error");
  assert.equal(h.budget.failures, 1);
});

test("a single backoff sleep never exceeds the max delay", async () => {
  const h = harness(queue(status(500), status(500), ok), { baseDelayMs: 20_000, factor: 10, maxDelayMs: 30_000 });
  await h.http.request("https://api.github.com/repos/expo/expo");
  assert.deepEqual(h.clock.slept, [20_000, 30_000], "the second delay is clamped, not 200s");
});

test("full jitter spreads the delay below the cap", async () => {
  const h = harness(queue(status(500), ok), {}, 0.25);
  await h.http.request("https://api.github.com/repos/expo/expo");
  assert.deepEqual(h.clock.slept, [125], "uniform in [0, cap]: 0.25 * 500ms");
});

test("a 4xx that is not 429 fails fast — a 404 is an answer, not a failure", async () => {
  const h = harness(queue(status(400)));
  await assert.rejects(() => h.http.request("https://api.github.com/bad"), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.failure, "client_error");
    assert.equal(err.attempts, 1);
    assert.match(err.message, /not retried/);
    return true;
  });
  assert.equal(h.calls(), 1, "no retry");
  assert.deepEqual(h.clock.slept, [], "no sleeping");

  // Accepted statuses come straight back to the caller (gh.ts caches 404s and 204s).
  const missing = harness(queue(status(404)));
  const response = await missing.http.request("https://api.github.com/orgs/nope", { accept: [404, 204] });
  assert.equal(response.status, 404);
  assert.equal(missing.calls(), 1);
});

test("a permissions 403 fails fast; a rate-limit 403 is retried", async () => {
  // Permissions: rate budget still healthy, no retry-after. Waiting cannot fix a token.
  const perms = harness(queue(status(403, { "x-ratelimit-remaining": "4999" }), ok));
  await assert.rejects(() => perms.http.request("https://api.github.com/orgs/private"), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.failure, "permissions");
    assert.match(err.message, /permissions\/scope, not a rate limit/);
    assert.match(err.message, /retrying will not help/);
    return true;
  });
  assert.equal(perms.calls(), 1);
  assert.deepEqual(perms.clock.slept, []);
  assert.equal(perms.budget.rate_limit_hits, 0, "a permissions wall is not a rate-limit hit");

  // Secondary limit: GitHub sends 403 + retry-after.
  const secondary = harness(queue(status(403, { "retry-after": "3" }), ok));
  assert.equal((await secondary.http.request("https://api.github.com/search/code?q=x")).status, 200);
  assert.deepEqual(secondary.clock.slept, [3000]);
  assert.equal(secondary.budget.rate_limit_hits, 1);

  // Primary limit: 403 with a spent budget waits for the reset instead of backing off.
  const resetAt = Math.floor((1_700_000_000_000 + 12_000) / 1000);
  const primary = harness(
    queue(status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }), ok),
  );
  assert.equal((await primary.http.request("https://api.github.com/orgs/expo")).status, 200);
  assert.deepEqual(primary.clock.slept, [12_000], "wait until the window resets, do not hammer");
  assert.equal(primary.budget.rate_limit_hits, 1);
});

test("a spent rate-limit budget on a good response gates the next request until reset", async () => {
  const resetAt = Math.floor((1_700_000_000_000 + 8_000) / 1000);
  const h = harness((_url, attempt) =>
    attempt === 1
      ? new Response("{}", { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) } })
      : new Response("{}", { status: 200, headers: { "x-ratelimit-remaining": "4999" } }),
  );
  await h.http.request("https://api.github.com/orgs/expo");
  assert.deepEqual(h.clock.slept, [], "the first request already succeeded");
  await h.http.request("https://api.github.com/orgs/other");
  assert.deepEqual(h.clock.slept, [8_000], "the next request to that host waits out the window");
  await h.http.request("https://api.github.com/orgs/third");
  assert.deepEqual(h.clock.slept, [8_000], "and stops waiting once the budget refills");
});

test("a wait longer than the per-request ceiling fails fast instead of hanging", async () => {
  const h = harness(queue(status(429, { "retry-after": "900" }), ok));
  await assert.rejects(() => h.http.request("https://api.github.com/search/code?q=x"), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.failure, "wait_ceiling");
    assert.match(err.message, /900\.0s wait exceeds the 60s per-request ceiling/);
    assert.match(err.message, /api\.github\.com/);
    return true;
  });
  assert.deepEqual(h.clock.slept, [], "a run must never hang on a server's Retry-After");
  assert.equal(h.budget.failures, 1);
});

test("network and timeout errors retry, then give up with the host and attempt count", async () => {
  const h = harness(() => {
    throw new TypeError("fetch failed: ETIMEDOUT");
  });
  await assert.rejects(() => h.http.request("https://example.com/page"), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.failure, "network");
    assert.equal(err.attempts, HTTP_DEFAULTS.maxAttempts);
    assert.match(err.message, /network error: fetch failed: ETIMEDOUT/);
    assert.match(err.message, /host example\.com/);
    assert.match(err.message, /no response/);
    return true;
  });
  assert.equal(h.calls(), HTTP_DEFAULTS.maxAttempts);
});

test("concurrency is capped at the configured number of live requests", async () => {
  const gates = Array.from({ length: 6 }, () => deferred<Response>());
  let inFlight = 0;
  let peak = 0;
  const h = harness(async (_url, attempt) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      return await gates[attempt - 1]!.promise;
    } finally {
      inFlight--;
    }
  }, { concurrency: 3, rps: 1_000, burst: 1_000 });

  const all = Promise.all(
    Array.from({ length: 6 }, (_, i) => h.http.request(`https://example.com/${i}`)),
  );
  await settle(50);
  assert.equal(peak, 3, "only three requests may be in flight at once");
  assert.equal(h.calls(), 3, "the rest are queued, not issued");
  for (const gate of gates) gate.resolve(new Response("{}", { status: 200 }));
  await all;
  assert.equal(peak, 3);
  assert.equal(h.calls(), 6, "and every queued request eventually runs");
});

test("the token bucket paces the steady-state rate once the burst is spent", async () => {
  const h = harness(queue(ok, ok, ok, ok), { concurrency: 1, rps: 2, burst: 2 });
  for (let i = 0; i < 4; i++) await h.http.request(`https://example.com/${i}`);
  assert.deepEqual(h.clock.slept, [500, 500], "two free from the burst, then one every 1/rps");
  assert.equal(h.budget.wait_ms, 1000, "pacing counts toward the run's wait budget");
});

test("the defaults are the documented ones", () => {
  assert.equal(HTTP_DEFAULTS.concurrency, 3);
  assert.equal(HTTP_DEFAULTS.rps, 5);
  assert.equal(HTTP_DEFAULTS.maxAttempts, 4);
  assert.equal(HTTP_DEFAULTS.baseDelayMs, 500);
  assert.equal(HTTP_DEFAULTS.maxDelayMs, 30_000);
  assert.equal(HTTP_DEFAULTS.maxTotalWaitMs, 60_000);
});

test("fixture mode opens no socket and never sleeps", async () => {
  // A policy layer that fails loudly if fixture mode ever reaches it.
  const forbidden = new HttpClient({
    deps: {
      ...noSleepClock(),
      jitter: () => 1,
      fetch: async () => {
        throw new Error("fixture mode must never open a socket");
      },
    },
  });
  const fixtureDir = join(REPO_ROOT, "fixtures");
  const gh = new GitHubClient({ mode: "fixture", token: "unused", fixtureDir, http: forbidden });
  const web = new WebClient({ mode: "fixture", fixtureDir, http: forbidden });
  const hn = new HnClient({ mode: "fixture", fixtureDir, http: forbidden });
  const gitlab = new GitLabClient({ mode: "fixture", fixtureDir, http: forbidden });

  assert.ok(await gh.org("expo"));
  assert.ok((await gh.searchCode("eas.json")).items.length >= 0);
  assert.ok(await web.homepage("beatgig", "beatgig.com"));
  assert.ok(await hn.whoIsHiring("expo", 30));
  assert.ok((await gitlab.searchProjects("expo")).projects.length >= 0);
  assert.equal(forbidden.counters().requests, 0, "no request was even started");

  // And the production wiring (no injected client) never touches the shared budget.
  const before = httpBudget();
  const plain = new GitHubClient({ mode: "fixture", fixtureDir });
  await plain.org("expo");
  await new WebClient({ mode: "fixture", fixtureDir }).homepage("beatgig", "beatgig.com");
  assert.deepEqual(httpBudget(), before, "fixture runs spend nothing from the live budget");
});
