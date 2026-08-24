// The HTTP policy layer. Every *live* outbound request in the fleet goes through here
// so rate-limit handling exists once instead of once per client (gh.ts, web.ts,
// gitlab.ts). Fixture mode never reaches this file — the clients answer from authored
// files before any request is built — which is what keeps `legwork demo` offline,
// byte-deterministic, and sleep-free.
//
// What it does, in order, per request:
//   1. wait out a known rate-limit reset for that host (GitHub tells us in headers),
//   2. take a token from a shared bucket (steady-state rate) inside a concurrency gate,
//   3. fetch with a timeout,
//   4. classify the result: return it, retry it with bounded jittered backoff, or fail
//      loudly with host + status + attempts + total wait.
//
// Retries are only for 429, 5xx, and network/timeout errors. A 404 is an answer, and a
// permissions 403 is a wall — retrying either one just burns the clock.

export interface HttpPolicy {
  /** Max live requests in flight at once (LEGWORK_HTTP_CONCURRENCY). */
  concurrency: number;
  /** Steady-state requests per second across all hosts (LEGWORK_HTTP_RPS). */
  rps: number;
  /** Token-bucket capacity: how much of that rate may be spent in one burst. */
  burst: number;
  /** Total tries per request, first attempt included. */
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  /** Ceiling for a single backoff sleep. */
  maxDelayMs: number;
  /** Ceiling for all sleeping done on behalf of one request. A run cannot hang. */
  maxTotalWaitMs: number;
  timeoutMs: number;
}

export const HTTP_DEFAULTS: Readonly<HttpPolicy> = Object.freeze({
  concurrency: 3,
  rps: 5,
  burst: 5,
  maxAttempts: 4,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
  maxTotalWaitMs: 60_000,
  timeoutMs: 10_000,
});

/** Per-run counters. The runner logs these; `doctor` reads them out of the run log. */
export interface HttpBudget {
  /** Logical requests (a retried request still counts once). */
  requests: number;
  /** Individual fetch attempts, retries included. */
  attempts: number;
  retries: number;
  /** Responses that were a rate limit (429, or a 403 that was really a limit). */
  rate_limit_hits: number;
  /** Every millisecond this layer spent asleep: pacing, Retry-After, and backoff. */
  wait_ms: number;
  /** Requests that gave up. */
  failures: number;
}

/** The subset carried into the run record — counts an operator acts on. */
export interface HttpUsage {
  requests: number;
  retries: number;
  rate_limit_hits: number;
  wait_ms: number;
}

export interface HttpDeps {
  fetch: (input: URL | string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Full-jitter source, 0..1. Injectable so tests can pin the backoff. */
  jitter: () => number;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  /** Statuses handed back to the caller instead of thrown (e.g. 404, 204, redirects). */
  accept?: readonly number[];
  timeoutMs?: number;
}

export type HttpFailure =
  | "permissions"
  | "rate_limit"
  | "client_error"
  | "server_error"
  | "network"
  | "wait_ceiling";

export interface HttpErrorDetail {
  url: string;
  host: string;
  method: string;
  status?: number;
  attempts: number;
  waitedMs: number;
  failure: HttpFailure;
  reason: string;
  body?: string;
}

/**
 * Loud by contract: which host, which status, how many attempts, how long we waited.
 * `legwork doctor` and the run log are only as useful as this string.
 */
export class HttpError extends Error {
  readonly url: string;
  readonly host: string;
  readonly method: string;
  readonly status: number | undefined;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly failure: HttpFailure;

  constructor(detail: HttpErrorDetail) {
    const status = detail.status === undefined ? "no response" : `status ${detail.status}`;
    const tries = `${detail.attempts} attempt${detail.attempts === 1 ? "" : "s"}`;
    const waited = `${(detail.waitedMs / 1000).toFixed(1)}s waited`;
    const body = detail.body ? `: ${detail.body}` : "";
    super(
      `${detail.method} ${detail.url} failed — ${detail.reason} ` +
        `[host ${detail.host}, ${status}, ${tries}, ${waited}]${body}`,
    );
    this.name = "HttpError";
    this.url = detail.url;
    this.host = detail.host;
    this.method = detail.method;
    this.status = detail.status;
    this.attempts = detail.attempts;
    this.waitedMs = detail.waitedMs;
    this.failure = detail.failure;
  }
}

const REAL_DEPS: HttpDeps = {
  fetch: (input, init) => fetch(input as URL, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
  jitter: () => Math.random(),
};

export class HttpClient {
  readonly policy: HttpPolicy;
  private readonly deps: HttpDeps;
  private readonly budget: HttpBudget;
  private readonly gate: Gate;
  private readonly bucket: TokenBucket;
  /** host → epoch ms when its rate limit resets. Set from GitHub's headers. */
  private readonly resets = new Map<string, number>();

  constructor(opts: { policy?: Partial<HttpPolicy>; deps?: Partial<HttpDeps>; budget?: HttpBudget } = {}) {
    this.policy = { ...HTTP_DEFAULTS, ...opts.policy };
    this.deps = { ...REAL_DEPS, ...opts.deps };
    this.budget = opts.budget ?? emptyBudget();
    this.gate = new Gate(Math.max(1, this.policy.concurrency));
    this.bucket = new TokenBucket(this.policy.rps, Math.max(1, this.policy.burst), this.deps);
  }

  counters(): HttpBudget {
    return { ...this.budget };
  }

  async request(url: string | URL, options: HttpRequestOptions = {}): Promise<Response> {
    return this.gate.run(() => this.attemptLoop(new URL(String(url)), options));
  }

  private async attemptLoop(url: URL, options: HttpRequestOptions): Promise<Response> {
    const method = options.method ?? "GET";
    const host = url.hostname;
    const accept = new Set(options.accept ?? []);
    const state: Waiting = { waitedMs: 0 };
    this.budget.requests++;
    let attempt = 0;

    for (;;) {
      attempt++;
      try {
        await this.waitForHostReset(host, url, method, state, attempt);
        const paced = await this.bucket.take();
        state.waitedMs += paced;
        this.budget.wait_ms += paced;
      } catch (err) {
        this.budget.failures++;
        throw err;
      }
      this.budget.attempts++;

      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          method,
          headers: options.headers,
          ...(options.redirect ? { redirect: options.redirect } : {}),
          signal: AbortSignal.timeout(options.timeoutMs ?? this.policy.timeoutMs),
        });
      } catch (err) {
        const reason = `network error: ${compact(err instanceof Error ? err.message : String(err))}`;
        if (attempt >= this.policy.maxAttempts) {
          this.budget.failures++;
          throw new HttpError({
            url: url.href, host, method, attempts: attempt, waitedMs: state.waitedMs,
            failure: "network", reason: `${reason} — gave up after ${attempt} attempts`,
          });
        }
        await this.backoff(attempt, undefined, url, method, host, state, undefined, reason);
        continue;
      }

      const verdict = this.classify(response, accept);
      this.noteRateLimitHeaders(host, response);
      if (verdict.kind === "return") return response;
      if (verdict.rateLimited) this.budget.rate_limit_hits++;

      const body = await snippet(response);
      if (verdict.kind === "fail" || attempt >= this.policy.maxAttempts) {
        this.budget.failures++;
        const exhausted = verdict.kind === "retry";
        throw new HttpError({
          url: url.href, host, method, status: response.status, attempts: attempt,
          waitedMs: state.waitedMs, failure: verdict.failure,
          reason: exhausted ? `${verdict.reason} — gave up after ${attempt} attempts` : verdict.reason,
          body,
        });
      }
      await this.backoff(
        attempt, verdict.delayMs, url, method, host, state, response.status, verdict.reason,
      );
    }
  }

  /** Sleep, counting every millisecond against the per-request ceiling. */
  private async wait(
    ms: number,
    context: { url: URL; method: string; host: string; status?: number; reason: string; attempts: number },
    state: Waiting,
  ): Promise<void> {
    if (ms <= 0) return;
    if (state.waitedMs + ms > this.policy.maxTotalWaitMs) {
      throw new HttpError({
        url: context.url.href, host: context.host, method: context.method, status: context.status,
        attempts: context.attempts, waitedMs: state.waitedMs, failure: "wait_ceiling",
        reason:
          `${context.reason}; the required ${(ms / 1000).toFixed(1)}s wait exceeds the ` +
          `${(this.policy.maxTotalWaitMs / 1000).toFixed(0)}s per-request ceiling`,
      });
    }
    await this.deps.sleep(ms);
    state.waitedMs += ms;
    this.budget.wait_ms += ms;
  }

  private async backoff(
    attempt: number,
    explicitMs: number | undefined,
    url: URL,
    method: string,
    host: string,
    state: Waiting,
    status?: number,
    reason = "retrying",
  ): Promise<void> {
    const ms = explicitMs ?? this.jitteredDelay(attempt);
    this.budget.retries++;
    try {
      await this.wait(ms, { url, method, host, status, reason, attempts: attempt }, state);
    } catch (err) {
      this.budget.failures++;
      throw err;
    }
  }

  /** Exponential with full jitter: uniform in [0, min(max, base * factor^n)]. */
  private jitteredDelay(attempt: number): number {
    const cap = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * this.policy.factor ** (attempt - 1));
    return Math.floor(this.deps.jitter() * cap);
  }

  /**
   * GitHub sets `x-ratelimit-remaining: 0` with `x-ratelimit-reset` (epoch seconds) when
   * the primary limit is spent — including on the last *successful* response. Remember
   * it and hold the next request to that host until reset instead of hammering.
   */
  private noteRateLimitHeaders(host: string, response: Response): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === null || Number(remaining) > 0) {
      if (response.ok) this.resets.delete(host);
      return;
    }
    const reset = resetAtMs(response.headers.get("x-ratelimit-reset"));
    if (reset !== null && reset > this.deps.now()) this.resets.set(host, reset);
  }

  private async waitForHostReset(
    host: string, url: URL, method: string, state: Waiting, attempt: number,
  ): Promise<void> {
    const reset = this.resets.get(host);
    if (reset === undefined) return;
    const ms = reset - this.deps.now();
    if (ms <= 0) {
      this.resets.delete(host);
      return;
    }
    if (attempt === 1) this.budget.rate_limit_hits++;
    await this.wait(
      ms,
      {
        url, method, host, attempts: attempt,
        reason: `${host} rate limit is exhausted until ${new Date(reset).toISOString()}`,
      },
      state,
    );
    this.resets.delete(host);
  }

  private classify(response: Response, accept: Set<number>): Verdict {
    if (response.ok || accept.has(response.status)) return { kind: "return", rateLimited: false };

    if (response.status === 429) {
      return {
        kind: "retry",
        rateLimited: true,
        failure: "rate_limit",
        reason: "rate limited (429)",
        delayMs: this.limitDelay(response),
      };
    }

    if (response.status === 403) {
      // A rate-limit 403 announces itself: `retry-after` (GitHub's secondary limit) or a
      // spent primary budget (`x-ratelimit-remaining: 0`). Anything else is a scope or
      // permissions problem, and no amount of waiting fixes a token that cannot read this.
      const retryAfter = response.headers.get("retry-after");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const spent = remaining !== null && Number(remaining) === 0;
      if (retryAfter !== null || spent) {
        return {
          kind: "retry",
          rateLimited: true,
          failure: "rate_limit",
          reason: spent && retryAfter === null
            ? "primary rate limit exhausted (403, x-ratelimit-remaining: 0)"
            : "secondary rate limit (403 with retry-after)",
          delayMs: this.limitDelay(response),
        };
      }
      return {
        kind: "fail",
        rateLimited: false,
        failure: "permissions",
        reason: "403 permissions/scope, not a rate limit (no retry-after, rate budget remaining) — retrying will not help",
      };
    }

    if (response.status >= 500) {
      return {
        kind: "retry",
        rateLimited: false,
        failure: "server_error",
        reason: `server error (${response.status})`,
        delayMs: this.limitDelay(response),
      };
    }

    return {
      kind: "fail",
      rateLimited: false,
      failure: "client_error",
      reason: `http ${response.status} is an answer, not a failure — not retried`,
    };
  }

  /** Retry-After (seconds or HTTP-date) wins; otherwise x-ratelimit-reset; else backoff. */
  private limitDelay(response: Response): number | undefined {
    const now = this.deps.now();
    const after = retryAfterMs(response.headers.get("retry-after"), now);
    if (after !== null) return after;
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number(remaining) === 0) {
      const reset = resetAtMs(response.headers.get("x-ratelimit-reset"));
      if (reset !== null && reset > now) return reset - now;
    }
    return undefined;
  }
}

interface Waiting {
  waitedMs: number;
}

type Verdict =
  | { kind: "return"; rateLimited: false }
  | { kind: "retry"; rateLimited: boolean; failure: HttpFailure; reason: string; delayMs?: number }
  | { kind: "fail"; rateLimited: boolean; failure: HttpFailure; reason: string };

/** Bounded concurrency. FIFO, so a queued request is not starved by later ones. */
class Gate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resume) => this.queue.push(resume));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Steady-state pacing. Takes are serialized so two callers cannot spend the same token;
 * the returned number is how long this take had to sleep, which the caller bills to the
 * request's wait budget.
 */
class TokenBucket {
  private tokens: number;
  private last: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rps: number,
    private readonly capacity: number,
    private readonly deps: HttpDeps,
  ) {
    this.tokens = capacity;
    this.last = deps.now();
  }

  take(): Promise<number> {
    const run = this.chain.then(() => this.takeNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async takeNow(): Promise<number> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const need = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
    await this.deps.sleep(need);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return need;
  }

  private refill(): void {
    const now = this.deps.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rps);
  }
}

export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function resetAtMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

async function snippet(response: Response): Promise<string> {
  try {
    return compact(await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function emptyBudget(): HttpBudget {
  return { requests: 0, attempts: 0, retries: 0, rate_limit_hits: 0, wait_ms: 0, failures: 0 };
}

// --- the shared client ------------------------------------------------------------
// One process, one gate, one bucket, one budget. Clients take an injectable `http` for
// tests, but production code shares this instance or the caps mean nothing.

const SHARED_BUDGET = emptyBudget();
let shared: HttpClient | null = null;

/** Lazy so `.env` (loaded by the CLI at startup) can set the caps. */
export function sharedHttp(): HttpClient {
  if (shared === null) {
    shared = new HttpClient({
      policy: {
        concurrency: envNumber("LEGWORK_HTTP_CONCURRENCY", HTTP_DEFAULTS.concurrency),
        rps: envNumber("LEGWORK_HTTP_RPS", HTTP_DEFAULTS.rps),
        burst: Math.max(1, Math.round(envNumber("LEGWORK_HTTP_RPS", HTTP_DEFAULTS.rps))),
      },
      budget: SHARED_BUDGET,
    });
  }
  return shared;
}

/** Snapshot of the shared budget. The runner diffs this around each unit. */
export function httpBudget(): HttpBudget {
  return { ...SHARED_BUDGET };
}

export function resetHttpBudget(): void {
  Object.assign(SHARED_BUDGET, emptyBudget());
}

/** Delta between two snapshots, or null when nothing live happened (fixture runs). */
export function httpUsageSince(before: HttpBudget, after: HttpBudget): HttpUsage | null {
  const usage: HttpUsage = {
    requests: after.requests - before.requests,
    retries: after.retries - before.retries,
    rate_limit_hits: after.rate_limit_hits - before.rate_limit_hits,
    wait_ms: Math.round(after.wait_ms - before.wait_ms),
  };
  return usage.requests === 0 && usage.retries === 0 && usage.rate_limit_hits === 0 && usage.wait_ms === 0
    ? null
    : usage;
}

export function formatHttpUsage(usage: HttpUsage): string {
  const parts = [`${usage.requests} req`];
  if (usage.retries > 0) parts.push(`${usage.retries} retried`);
  if (usage.rate_limit_hits > 0) parts.push(`${usage.rate_limit_hits} rate-limited`);
  if (usage.wait_ms > 0) parts.push(`${(usage.wait_ms / 1000).toFixed(1)}s waited`);
  return parts.join(", ");
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`  ${name}="${raw}" is not a positive number — using the default ${fallback}`);
    return fallback;
  }
  return value;
}
