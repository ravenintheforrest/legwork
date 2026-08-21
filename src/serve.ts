// The local operator desk. One localhost process so the console can *act*, not just show.
//
// It is a second client, never a second control plane: every endpoint calls the same
// exported function the CLI verb calls. Nothing here reimplements a loop, and nothing
// auto-mutates — every action is an explicit click by the human sitting in front of it.
//
// GitHub Pages stays the public read-only window; the CLI stays the fallback that always
// works. This is the third seat at the same table.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { format } from "node:util";
import { runEvals } from "./evals.js";
import { notifyBrief } from "./notify.js";
import { renderConsole, renderPanels } from "./report.js";
import { runRetire } from "./retire.js";
import { runReview } from "./review.js";
import { runPipeline } from "./runner.js";
import { loadAccounts } from "./store.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024;
const MEMO_DIR = "memos";

// --- run state --------------------------------------------------------------------

interface RunState {
  running: boolean;
  lines: string[];
  startedAt: string | null;
  error?: string;
}

// One run at a time, by design: the harness is a desk, not a queue. `lines` is
// cumulative for the active run and survives as the last run's transcript after it ends.
let runState: RunState = { running: false, lines: [], startedAt: null };

// --- output capture ---------------------------------------------------------------

// The pipeline talks to the terminal. To show it in the browser we intercept console
// output, but scoped: the sink lives in an AsyncLocalStorage context, so only the async
// tree started by *this* action collects lines. A review or notify request handled while
// a run is in flight writes to the terminal and never leaks into the run's log.
const sinks = new AsyncLocalStorage<string[]>();
const realConsole = { log: console.log.bind(console), error: console.error.bind(console) };
let patchDepth = 0;

function patchConsole(): void {
  if (patchDepth++ > 0) return;
  console.log = (...args: unknown[]) => tee(realConsole.log, args);
  console.error = (...args: unknown[]) => tee(realConsole.error, args);
}

function restoreConsole(): void {
  if (--patchDepth > 0) return;
  patchDepth = 0;
  console.log = realConsole.log;
  console.error = realConsole.error;
}

function tee(write: (...args: unknown[]) => void, args: unknown[]): void {
  write(...args); // the terminal still sees everything it saw before
  const sink = sinks.getStore();
  if (!sink) return;
  for (const line of format(...args).split("\n")) sink.push(line);
}

/** Run `fn`, appending everything it prints to `sink`. Console is always restored. */
async function captured<T>(sink: string[], fn: () => Promise<T> | T): Promise<T> {
  patchConsole();
  try {
    return await sinks.run(sink, async () => await fn());
  } finally {
    restoreConsole();
  }
}

// --- server -----------------------------------------------------------------------

export async function startServer(opts: { port?: number; open?: boolean } = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(`serve: unhandled ${describe(err)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(err) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use — try \`legwork serve --port ${port + 1}\``)
          : err,
      );
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  // Past startup, a socket-level error must never take the desk down with it.
  server.on("error", (err: unknown) => console.error(`serve: ${describe(err)}`));

  const url = `http://${HOST}:${port}/`;
  console.log(`legwork serve — local operator desk on ${url}`);
  console.log("read-only pages build unaffected: `legwork report` still writes site/index.html");
  console.log("Ctrl-C to stop");
  if (opts.open !== false) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/") return sendHtml(res, renderConsole({ served: true }));
  if (method === "GET" && path === "/api/state") return getState(res);
  if (method === "GET" && path === "/api/run/status") return getRunStatus(res);
  if (method === "POST" && path === "/api/run") return postRun(req, res);
  if (method === "POST" && path === "/api/review") return postReview(req, res);
  if (method === "POST" && path === "/api/retire") return postRetire(req, res);
  if (method === "POST" && path === "/api/evals") return postEvals(res);
  if (method === "POST" && path === "/api/notify") return postNotify(req, res);
  if (method === "GET" && path === "/api/receipt") return getReceipt(req, res);

  sendJson(res, 404, { ok: false, error: `no route ${method} ${path}` });
}

// --- endpoints ---------------------------------------------------------------------

function getState(res: ServerResponse): void {
  try {
    sendJson(res, 200, { ok: true, html: renderPanels() });
  } catch (err) {
    fail(res, 500, err);
  }
}

function getRunStatus(res: ServerResponse): void {
  sendJson(res, 200, {
    running: runState.running,
    lines: runState.lines,
    startedAt: runState.startedAt,
    ...(runState.error ? { error: runState.error } : {}),
  });
}

async function postRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (err) {
    return fail(res, 400, err);
  }

  const mode = body.mode === "live" ? "live" : body.mode === "fixture" ? "fixture" : null;
  if (!mode) return sendJson(res, 400, { ok: false, error: `mode must be "fixture" or "live"` });

  const sinceDays = typeof body.sinceDays === "number" && body.sinceDays > 0 ? Math.floor(body.sinceDays) : 7;

  if (runState.running) {
    return sendJson(res, 409, { ok: false, error: "a run is already active — wait for it to finish" });
  }
  // runPipeline exits the process on a live run without a token; the desk must not die
  // for a missing env var, so the check happens here first.
  if (mode === "live" && !process.env.GITHUB_TOKEN) {
    return sendJson(res, 400, {
      ok: false,
      error: "GITHUB_TOKEN is not set — set it in .env and restart, or run the fixture demo",
    });
  }

  const state: RunState = {
    running: true,
    lines: [`> legwork run --since ${sinceDays}d${mode === "fixture" ? " --fixture" : ""}`],
    startedAt: new Date().toISOString(),
  };
  runState = state;

  // Fire and forget: the client polls /api/run/status for the transcript.
  void (async () => {
    try {
      await captured(state.lines, () => runPipeline({ mode, sinceDays }));
      state.lines.push(`done · ${mode} run finished`);
    } catch (err) {
      state.error = describe(err);
      state.lines.push(`error: ${state.error}`);
      console.error(`serve: run failed — ${state.error}`);
    } finally {
      state.running = false;
    }
  })();

  sendJson(res, 200, { ok: true });
}

async function postReview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const org = typeof body.org === "string" ? body.org.trim() : "";
    const decision = body.decision;
    if (!org) return sendJson(res, 400, { ok: false, error: "org is required" });
    if (decision !== "approve" && decision !== "reject") {
      return sendJson(res, 400, { ok: false, error: `decision must be "approve" or "reject"` });
    }
    // Approval also posts the brief to Slack from inside runReview — same path the CLI takes.
    await runReview(decision === "approve" ? { approve: org } : { reject: org });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    fail(res, 400, err);
  }
}

async function postRetire(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    if (!agent) return sendJson(res, 400, { ok: false, error: "agent is required" });

    // runRetire prints the memo and writes it; the file is the artifact we hand back.
    const printed: string[] = [];
    await captured(printed, () => runRetire(agent));
    const file = join(MEMO_DIR, `retire-${agent}.md`);
    const memo = existsSync(file) ? readFileSync(file, "utf8") : printed.join("\n");
    sendJson(res, 200, { ok: true, memo });
  } catch (err) {
    fail(res, 400, err);
  }
}

async function postEvals(res: ServerResponse): Promise<void> {
  // runEvals reports a regression by setting a non-zero exit code. That is right for CI
  // and wrong for a long-lived server: it would poison the eventual exit status of a
  // process that is perfectly healthy. Capture the signal, then put the code back.
  const priorExitCode = process.exitCode;
  const lines: string[] = [];
  try {
    process.exitCode = 0;
    await captured(lines, () => runEvals({}));
    const exitCode = process.exitCode;
    const regressions =
      (typeof exitCode === "number" && exitCode !== 0) ||
      lines.some((line) => line.startsWith("REGRESSION:"));
    sendJson(res, 200, { ok: true, output: lines.join("\n"), regressions });
  } catch (err) {
    fail(res, 500, err);
  } finally {
    process.exitCode = priorExitCode;
  }
}

async function postNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const org = typeof body.org === "string" ? body.org.trim() : "";
    if (!org) return sendJson(res, 400, { ok: false, error: "org is required" });
    const result = await notifyBrief(org);
    if (result === "missing") {
      return sendJson(res, 404, {
        ok: false,
        error: `no published brief for "${org}" (is it still in the review queue?)`,
      });
    }
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    fail(res, 500, err);
  }
}

// --- receipt previews ------------------------------------------------------------------
//
// `GET /api/receipt?url=<encoded>` → `{ ok, kind, title?, text?, meta?, error? }`.
//
// The console's receipt drawer previews a source in place instead of opening a tab, and
// most of those sources cannot be iframed (GitHub sends X-Frame-Options: DENY). So the
// server fetches on the page's behalf — which makes this the one endpoint that talks to
// the outside world, and the one that has to be paranoid about it.
//
// The allowlist below is a security boundary, not a convenience. Everything downstream of
// it exists to keep this from becoming an open proxy: https only, no credentials in the
// URL, no non-default port, redirects followed by hand with the host re-checked at every
// hop, response bodies read through a byte cap, one 6s budget for the whole exchange, and
// the GitHub token (if the operator has one) attached only for GitHub's own hosts.

const RECEIPT_TIMEOUT_MS = 6_000;
const RECEIPT_CONCURRENCY = 4;
const RECEIPT_CACHE_MAX = 200;
const PREVIEW_MAX_LINES = 200;
const PREVIEW_MAX_BYTES = 20 * 1024;
const HTML_SCAN_BYTES = 256 * 1024;
const JSON_SCAN_BYTES = 128 * 1024;
const RECEIPT_UA = "legwork-receipt-preview (+https://github.com/ravenintheforrest/legwork)";

// Hosts a receipt link may point at. Account domains are added at request time.
const RECEIPT_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "apps.apple.com",
  "play.google.com",
  "news.ycombinator.com",
]);

// Hosts *we* may derive a fetch to from an already-allowed receipt URL. The two extras are
// ours, not the caller's: nothing outside this file can ask for them directly.
const DERIVED_HOSTS = new Set(["itunes.apple.com", "raw.githubusercontent.com", "api.github.com"]);

const GITHUB_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

interface ReceiptPreview {
  ok: true;
  kind: string;
  title?: string;
  text?: string;
  meta?: Record<string, string>;
  note?: string;
}

const receiptCache = new Map<string, { status: number; payload: unknown }>();

// Account domains change when the pipeline runs; re-read them occasionally rather than
// pinning the allowlist to whatever state existed when the desk booted.
let domainCache: { at: number; hosts: Set<string> } | null = null;

function accountDomains(): Set<string> {
  const now = Date.now();
  if (domainCache && now - domainCache.at < 5_000) return domainCache.hosts;
  const hosts = new Set<string>();
  try {
    for (const account of loadAccounts()) {
      const domain = (account.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) continue;
      hosts.add(domain);
      hosts.add(`www.${domain}`);
    }
  } catch {
    // No state file yet: the fixed allowlist still applies, account domains just don't.
  }
  domainCache = { at: now, hosts };
  return hosts;
}

function hostAllowed(host: string): boolean {
  return RECEIPT_HOSTS.has(host) || accountDomains().has(host);
}

function fetchHostAllowed(host: string): boolean {
  return hostAllowed(host) || DERIVED_HOSTS.has(host);
}

// Redirect hops only. A hop onto a subdomain of a host we already trust adds no trust that
// wasn't already granted (codeload.github.com, www.example.com), but a hop to a different
// registrable domain does — infinitered.com genuinely redirects to infinite.red, and that
// is a host nobody put on the list. Refusing it is the whole point of having a list.
function redirectHostAllowed(host: string): boolean {
  if (fetchHostAllowed(host)) return true;
  for (const allowed of RECEIPT_HOSTS) if (host.endsWith(`.${allowed}`)) return true;
  for (const allowed of DERIVED_HOSTS) if (host.endsWith(`.${allowed}`)) return true;
  for (const allowed of accountDomains()) if (host.endsWith(`.${allowed}`)) return true;
  return false;
}

async function getReceipt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = new URL(req.url ?? "/", `http://${HOST}`).searchParams.get("url");
  if (!raw) return sendJson(res, 400, { ok: false, error: "url query parameter is required" });

  const cached = receiptCache.get(raw);
  if (cached) return sendJson(res, cached.status, cached.payload);

  const guard = guardUrl(raw);
  if ("error" in guard) return remember(res, raw, 403, { ok: false, error: guard.error });

  try {
    const preview = await withReceiptSlot(() => buildPreview(guard.url));
    remember(res, raw, 200, preview);
  } catch (err) {
    // A source that will not answer is an absent preview, not a broken desk. The drawer
    // renders the reason as a quiet line under the metadata it already has.
    remember(res, raw, 502, { ok: false, error: describe(err) });
  }
}

function remember(res: ServerResponse, key: string, status: number, payload: unknown): void {
  if (receiptCache.size >= RECEIPT_CACHE_MAX) {
    const oldest = receiptCache.keys().next();
    if (!oldest.done) receiptCache.delete(oldest.value);
  }
  receiptCache.set(key, { status, payload });
  sendJson(res, status, payload);
}

function guardUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "not a valid absolute URL" };
  }
  if (url.protocol !== "https:") return { error: "only https: sources are previewed" };
  if (url.username !== "" || url.password !== "") return { error: "URLs carrying credentials are refused" };
  if (url.port !== "" && url.port !== "443") return { error: "only the default https port is previewed" };
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host)) return { error: `${host} is not on the preview allowlist — open it in a new tab instead` };
  return { url };
}

// One slot queue rather than a library: four in flight is plenty for a drawer a human
// clicks, and an unbounded fan-out is how a local desk turns into a load generator.
let receiptActive = 0;
const receiptWaiting: (() => void)[] = [];

async function withReceiptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (receiptActive >= RECEIPT_CONCURRENCY) await new Promise<void>((resolve) => receiptWaiting.push(resolve));
  receiptActive++;
  try {
    return await fn();
  } finally {
    receiptActive--;
    receiptWaiting.shift()?.();
  }
}

function classify(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const seg = url.pathname.split("/").filter((s) => s !== "");
  if (host === "raw.githubusercontent.com") return "github file";
  if (host === "api.github.com") return "github";
  if (host === "github.com") {
    if (seg.length >= 3 && (seg[2] === "blob" || seg[2] === "raw")) return "github file";
    if (seg.length >= 3 && (seg[2] === "issues" || seg[2] === "pull")) return "issue";
    if (seg.length >= 2) return "github repo";
    if (seg.length === 1) return "github profile";
    return "github";
  }
  if (host === "apps.apple.com" || host === "play.google.com") return "app store";
  if (host === "news.ycombinator.com") return "hn";
  return "homepage";
}

async function buildPreview(url: URL): Promise<ReceiptPreview> {
  const kind = classify(url);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const seg = url.pathname.split("/").filter((s) => s !== "");

  if (kind === "github file") return await previewFile(url, host, seg);
  if (kind === "github repo") return await previewRepo(seg);
  if (kind === "github profile") return await previewProfile(seg[0] ?? "");
  if (kind === "issue") return await previewIssue(seg);
  if (host === "api.github.com") return await previewRawJson(url.href);
  if (host === "apps.apple.com") return await previewAppStore(url);
  return await previewPage(url, kind); // homepage, HN, Play Store: title + description only
}

// --- per-kind previews ---

// The eas.json / package.json case: exactly what a reviewer wants to read without leaving.
async function previewFile(url: URL, host: string, seg: string[]): Promise<ReceiptPreview> {
  const raw =
    host === "raw.githubusercontent.com"
      ? url.href
      : `https://raw.githubusercontent.com/${seg[0]}/${seg[1]}/${seg.slice(3).join("/")}`;
  const res = await fetchAllowed(raw, "text/plain, */*");
  if (!res.ok) throw new Error(`raw.githubusercontent.com returned ${res.status} for that file`);
  const body = await readCapped(res, PREVIEW_MAX_BYTES);
  let lines = body.text.split("\n");
  let truncated = body.truncated;
  if (lines.length > PREVIEW_MAX_LINES) {
    lines = lines.slice(0, PREVIEW_MAX_LINES);
    truncated = true;
  }
  return {
    ok: true,
    kind: "github file",
    title: host === "raw.githubusercontent.com" ? url.pathname.slice(1) : seg.slice(4).join("/") || url.pathname.slice(1),
    text: lines.join("\n"),
    ...(truncated ? { note: `showing the first ${PREVIEW_MAX_LINES} lines / 20KB — open in a new tab for the whole file` } : {}),
  };
}

async function previewRepo(seg: string[]): Promise<ReceiptPreview> {
  const repo = await githubJson(`https://api.github.com/repos/${seg[0]}/${seg[1]}`);
  const meta: Record<string, string> = {
    description: str(repo.description),
    language: str(repo.language),
    "pushed at": str(repo.pushed_at).slice(0, 10),
    stars: str(repo.stargazers_count),
    "default branch": str(repo.default_branch),
  };

  // A /tree/ URL points at a directory, so list what is in it — the receipt is usually
  // "there are CI workflows here", and the file list is the proof.
  let note: string | undefined;
  if (seg[2] === "tree" && seg.length > 4) {
    const ref = seg[3] ?? str(repo.default_branch);
    const path = seg.slice(4).join("/");
    try {
      const listing = await githubJson(`https://api.github.com/repos/${seg[0]}/${seg[1]}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      const entries = Array.isArray(listing) ? listing : [];
      if (entries.length) {
        const names = entries.slice(0, 100).map((e) => `${str((e as Record<string, unknown>).name)}`);
        meta[path] = names.join(", ");
        if (entries.length > names.length) note = `${entries.length} entries in that directory; showing the first 100`;
      }
    } catch {
      note = "directory listing unavailable — repository metadata only";
    }
  }
  return { ok: true, kind: "github repo", title: str(repo.full_name), meta, ...(note ? { note } : {}) };
}

async function previewProfile(login: string): Promise<ReceiptPreview> {
  // /users/<login> answers for organizations too, so one call covers both profile shapes.
  const user = await githubJson(`https://api.github.com/users/${encodeURIComponent(login)}`);
  return {
    ok: true,
    kind: "github profile",
    title: str(user.name) || str(user.login) || login,
    meta: {
      login: str(user.login),
      type: str(user.type),
      company: str(user.company),
      location: str(user.location),
      bio: str(user.bio).slice(0, 500),
      "public repos": str(user.public_repos),
      "joined": str(user.created_at).slice(0, 10),
    },
  };
}

async function previewIssue(seg: string[]): Promise<ReceiptPreview> {
  const number = seg[3] ?? "";
  const issue = await githubJson(`https://api.github.com/repos/${seg[0]}/${seg[1]}/issues/${encodeURIComponent(number)}`);
  const body = str(issue.body);
  const clipped = body.length > 4000;
  return {
    ok: true,
    kind: "issue",
    title: str(issue.title),
    meta: {
      state: str(issue.state),
      author: str((issue.user as Record<string, unknown> | undefined)?.login),
      opened: str(issue.created_at).slice(0, 10),
      comments: str(issue.comments),
    },
    ...(body ? { text: clipped ? `${body.slice(0, 4000)}\n…` : body } : {}),
    ...(clipped ? { note: "issue body clipped at 4000 characters" } : {}),
  };
}

// The iTunes Lookup API, same source appstore.ts already uses for store signals.
async function previewAppStore(url: URL): Promise<ReceiptPreview> {
  const id = /\/id(\d+)/.exec(url.pathname)?.[1];
  if (!id) throw new Error("no numeric app id in that App Store URL");
  // `media=software` matters: iTunes ids are one namespace across every store, and a bare
  // lookup on an app id that does not exist will happily hand back a song with that id.
  const res = await fetchAllowed(`https://itunes.apple.com/lookup?id=${id}&media=software`, "application/json");
  if (!res.ok) throw new Error(`itunes.apple.com returned ${res.status}`);
  const body = await readCapped(res, JSON_SCAN_BYTES);
  const parsed = JSON.parse(body.text) as { results?: Record<string, unknown>[] };
  const app = parsed.results?.find((r) => str(r.wrapperType) === "software");
  if (!app) throw new Error(`no App Store listing for id ${id}`);
  return {
    ok: true,
    kind: "app store",
    title: str(app.trackName),
    meta: {
      seller: str(app.sellerName),
      "rating count": str(app.userRatingCount),
      rating: typeof app.averageUserRating === "number" ? app.averageUserRating.toFixed(2) : "",
      version: str(app.version),
      "last release": str(app.currentVersionReleaseDate).slice(0, 10),
      "minimum os": str(app.minimumOsVersion),
    },
    ...(str(app.releaseNotes) ? { text: str(app.releaseNotes).slice(0, 2000) } : {}),
  };
}

// Homepages and HN: the title and the meta description, nothing else. Raw HTML never
// reaches the drawer — not as markup, not as text.
async function previewPage(url: URL, kind: string): Promise<ReceiptPreview> {
  const res = await fetchAllowed(url.href, "text/html,application/xhtml+xml");
  if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);
  const body = await readCapped(res, HTML_SCAN_BYTES);
  const html = body.text;
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const description = decodeEntities(metaContent(html, "description") || metaContent(html, "og:description")).replace(/\s+/g, " ").trim();
  if (!title && !description) throw new Error(`${url.hostname} served no title or description to preview`);
  return {
    ok: true,
    kind,
    title: title.slice(0, 300),
    ...(description ? { meta: { description: description.slice(0, 500) } } : {}),
  };
}

async function previewRawJson(href: string): Promise<ReceiptPreview> {
  const res = await fetchAllowed(href, "application/json");
  if (!res.ok) throw new Error(`api.github.com returned ${res.status}`);
  const body = await readCapped(res, JSON_SCAN_BYTES);
  const text = JSON.stringify(JSON.parse(body.text), null, 2).split("\n").slice(0, PREVIEW_MAX_LINES).join("\n");
  return { ok: true, kind: "github", title: new URL(href).pathname.slice(1), text };
}

// --- fetch plumbing ---

async function githubJson(endpoint: string): Promise<Record<string, unknown>> {
  const res = await fetchAllowed(endpoint, "application/vnd.github+json");
  if (res.status === 403 || res.status === 429) {
    await res.body?.cancel();
    throw new Error(
      process.env.GITHUB_TOKEN
        ? "GitHub API refused the request (rate limit or permissions)"
        : "GitHub's unauthenticated API limit (60/hr) is spent — set GITHUB_TOKEN and restart the desk",
    );
  }
  if (!res.ok) throw new Error(`api.github.com returned ${res.status}`);
  const body = await readCapped(res, JSON_SCAN_BYTES);
  return JSON.parse(body.text) as Record<string, unknown>;
}

/**
 * Fetch with the allowlist enforced at every hop. Redirects are followed by hand precisely
 * so a redirect cannot walk us off the allowlist and onto, say, a link-local metadata
 * endpoint. One timeout covers the whole chain.
 */
async function fetchAllowed(target: string, accept: string): Promise<Response> {
  const signal = AbortSignal.timeout(RECEIPT_TIMEOUT_MS);
  let current = target;
  let from = new URL(target).hostname.toLowerCase();
  for (let hop = 0; hop < 4; hop++) {
    const url = new URL(current);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") throw new Error(`refusing a non-https hop to ${host}`);
    if (hop === 0 ? !fetchHostAllowed(host) : !redirectHostAllowed(host)) {
      throw new Error(`${from} redirects to ${host}, which is not on the preview allowlist`);
    }

    const headers: Record<string, string> = { accept, "user-agent": RECEIPT_UA };
    // The operator's token goes to GitHub's own hosts and nowhere else, re-decided per hop.
    if (GITHUB_HOSTS.has(host) && process.env.GITHUB_TOKEN) {
      headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(current, { redirect: "manual", signal, headers });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error(`${host} redirected without a location`);
      from = host;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/** Read at most `maxBytes`, then hang up. A preview must never be able to exhaust memory. */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    if (size + chunk.length >= maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - size)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function metaContent(html: string, name: string): string {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const tag = pattern.exec(html)?.[0];
  if (!tag) return "";
  return /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1] ?? "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// --- plumbing -----------------------------------------------------------------------

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new Error("body must be a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function fail(res: ServerResponse, status: number, err: unknown): void {
  const error = describe(err);
  console.error(`serve: ${error}`);
  sendJson(res, status, { ok: false, error });
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}
