import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StoreSignals } from "../src/appstore.js";
import { CostMeter } from "../src/costs.js";
import { GitHubClient } from "../src/gh.js";
import { JobBoards, boardFromUrl } from "../src/jobs.js";
import { discoverIssues } from "../src/agents/discover-issues.js";
import { companyName, domainFrom, normalizeCompany, stackTerms } from "../src/agents/naming.js";
import { qualify } from "../src/agents/qualify.js";
import { resolve } from "../src/agents/resolve.js";
import type { Account, RunContext } from "../src/types.js";

const NOW = "2026-08-20T12:00:00.000Z";

function fixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "legwork-src-"));
  for (const sub of ["github/issues", "github/users", "github/orgs", "github/repos", "github/contents", "web", "store", "jobs"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

function ctx(fixtureDir: string, sinceDays = 0): RunContext {
  return {
    pack: "packs/expo",
    mode: "fixture",
    now: () => NOW,
    sinceDays,
    gh: new GitHubClient({ mode: "fixture", fixtureDir }),
    store: new StoreSignals({ mode: "fixture", fixtureDir }),
    llm: null,
    costs: new CostMeter(Number.POSITIVE_INFINITY),
    fixtureDir,
  };
}

test("discover-issues: issue authors who list a company become accounts; bots, first-party, and the unlisted do not", async () => {
  const dir = fixtures();
  writeFileSync(join(dir, "github/issues/tracker-expo-expo.json"), JSON.stringify({ total_count: 4, items: [
    { title: "EAS Update fails to roll back on Android", html_url: "https://github.com/expo/expo/issues/1", user: { login: "ada" } },
    { title: "Credentials on CI", html_url: "https://github.com/expo/expo/issues/2", user: { login: "ada" } },
    { title: "Third one is dropped (cap is two per author)", html_url: "https://github.com/expo/expo/issues/3", user: { login: "ada" } },
    { title: "bot noise", html_url: "https://github.com/expo/expo/issues/4", user: { login: "renovate[bot]" } },
    { title: "first party", html_url: "https://github.com/expo/expo/issues/5", user: { login: "brent" } },
    { title: "no company", html_url: "https://github.com/expo/expo/issues/6", user: { login: "nobody" } },
  ] }));
  writeFileSync(join(dir, "github/issues/tracker-expo-eas-cli.json"), JSON.stringify({ total_count: 1, items: [
    { title: "eas build hangs", html_url: "https://github.com/expo/eas-cli/issues/9", user: { login: "grace" } },
  ] }));
  writeFileSync(join(dir, "github/users/ada.json"), JSON.stringify({ login: "ada", company: "@acme", html_url: "https://github.com/ada", location: "Private City", bio: "secret" }));
  writeFileSync(join(dir, "github/users/grace.json"), JSON.stringify({ login: "grace", company: "Northwind Health Inc", html_url: "https://github.com/grace" }));
  writeFileSync(join(dir, "github/users/brent.json"), JSON.stringify({ login: "brent", company: "@expo", html_url: "https://github.com/brent" }));
  writeFileSync(join(dir, "github/users/nobody.json"), JSON.stringify({ login: "nobody", html_url: "https://github.com/nobody" }));

  const out = await discoverIssues.run([], ctx(dir));
  assert.deepEqual(out.map((a) => a.org), ["acme", "northwind-health-inc"]);
  const acme = out[0]!;
  assert.equal(acme.company, "acme");
  assert.equal(acme.stage, "discovered");
  assert.equal(acme.evidence.filter((e) => /opened "/.test(e.claim)).length, 2);
  assert.ok(acme.evidence.some((e) => e.url === "https://github.com/ada" && e.claim.includes("lists company '@acme'")));
  const text = JSON.stringify(acme);
  assert.ok(!text.includes("Private City") && !text.includes("secret"), "location and bio are never copied");

  // known account: union only, returned only if something is new
  const again = await discoverIssues.run(out, ctx(dir));
  assert.equal(again.length, 0);
});

test("jobs: Remotive posts and a company's own board, parsed tolerantly; slugs only from exact board URLs", async () => {
  const boards = new JobBoards({ mode: "live", fetchJson: async (url) => {
    if (url.startsWith("https://remotive.com/api/remote-jobs?search=react%20native")) return { jobs: [
      { id: 1, url: "https://remotive.com/remote-jobs/x/1", title: "Senior React Native Engineer", company_name: "Acme Inc", description: "<p>We build on Expo and EAS. Apply at https://acme.com/jobs</p>", publication_date: "2026-08-15T00:00:00" },
      { id: 2, url: "https://remotive.com/remote-jobs/x/2", title: "Backend Engineer", company_name: "Other", description: "Go and Postgres" },
    ] };
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs")) return { jobs: [
      { title: "Mobile Engineer (React Native)", absolute_url: "https://boards.greenhouse.io/acme/jobs/7", content: "&lt;p&gt;Expo, EAS Update&lt;/p&gt;", updated_at: "2026-08-10T00:00:00Z" },
    ] };
    if (url.startsWith("https://api.lever.co/v0/postings/acme")) return [
      { text: "iOS Engineer", hostedUrl: "https://jobs.lever.co/acme/1", descriptionPlain: "Swift only", createdAt: 1755000000000 },
    ];
    throw new Error("unexpected " + url);
  } });
  const posts = await boards.remotive("react native");
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.company, "Acme Inc");
  assert.ok(posts[0]!.text.includes("Expo and EAS") && !posts[0]!.text.includes("<p>"));
  assert.equal(domainFrom(posts[0]!.text), "acme.com");
  assert.deepEqual(stackTerms(`${posts[0]!.title} ${posts[0]!.text}`), ["Expo", "EAS", "React Native"]);

  const gh = await boards.board({ kind: "greenhouse", slug: "acme" });
  assert.equal(gh[0]!.title, "Mobile Engineer (React Native)");
  assert.ok(gh[0]!.text.includes("EAS Update"));
  const lever = await boards.board({ kind: "lever", slug: "acme" });
  assert.equal(lever[0]!.title, "iOS Engineer");
  assert.equal(lever[0]!.posted?.slice(0, 4), "2025");

  assert.deepEqual(boardFromUrl("https://boards.greenhouse.io/acme/jobs/7"), { kind: "greenhouse", slug: "acme" });
  assert.deepEqual(boardFromUrl("https://jobs.lever.co/Acme"), { kind: "lever", slug: "acme" });
  assert.deepEqual(boardFromUrl("https://jobs.ashbyhq.com/acme/123"), { kind: "ashby", slug: "acme" });
  assert.equal(boardFromUrl("https://acme.com/careers"), null);
  assert.equal(boardFromUrl("https://boards.greenhouse.io/"), null);

  // an unanswering board is an absent signal
  const dead = new JobBoards({ mode: "live", fetchJson: async () => { throw new Error("down"); } });
  assert.deepEqual(await dead.remotive("expo"), []);
});

test("naming: company names are refused unless they look like names; normalization strips legal suffixes", () => {
  assert.equal(companyName("Acme Inc (YC W24)"), "Acme Inc");
  assert.equal(companyName("@acme"), "acme");
  assert.equal(companyName("https://acme.com"), null);
  assert.equal(companyName("one two three four five six seven"), null);
  assert.equal(normalizeCompany("Northwind Health, Inc."), "northwindhealth");
});

test("resolve: a domain-keyed account with no GitHub org resolves by its own homepage; a name-keyed one by an org of the same name", async () => {
  const dir = fixtures();
  writeFileSync(join(dir, "web/mollie.com.json"), JSON.stringify({ url: "https://mollie.com/", title: "Mollie | Payments for every business", description: "Accept payments" }));
  writeFileSync(join(dir, "github/orgs/northwind-health.json"), JSON.stringify({ login: "northwind-health", name: "Northwind Health", blog: "https://northwind.example", html_url: "https://github.com/northwind-health", type: "Organization" }));
  const input: Account[] = [
    { org: "mollie.com", domain: "mollie.com", company: "Mollie", stage: "discovered", evidence: [{ claim: "hiring for React Native on Remotive: \"Mobile Engineer\"", url: "https://remotive.com/r/1", agent: "discover-jobs", date: NOW }], updated: NOW },
    { org: "northwind-health-inc", company: "Northwind Health Inc", stage: "discovered", evidence: [], updated: NOW },
    { org: "nowhere-co", company: "Nowhere", stage: "discovered", evidence: [], updated: NOW },
  ];
  const out = await resolve.run(input, ctx(dir));
  const mollie = out.find((a) => a.org === "mollie.com")!;
  assert.equal(mollie.stage, "resolved");
  assert.equal(mollie.kind, "org");
  assert.equal(mollie.company, "Mollie");
  assert.ok(mollie.evidence.some((e) => e.agent === "resolve" && e.url === "https://mollie.com/" && e.claim.includes("answers as")));
  const nw = out.find((a) => a.org === "northwind-health-inc")!;
  assert.equal(nw.stage, "resolved");
  assert.equal(nw.domain, "northwind.example");
  assert.ok(out.every((a) => a.org !== "nowhere-co"), "no org, no domain, no homepage → stays discovered");
});

test("qualify: a company's own job post naming Expo/EAS passes the gate; React Native alone does not", async () => {
  const dir = fixtures();
  writeFileSync(join(dir, "store/mollie.com.json"), JSON.stringify({ org: "mollie.com", app_name: "Mollie", store_url: "https://apps.apple.com/us/app/mollie/id1", review_count: 1500, updates_last_90d: 4 }));
  const base: Account = { org: "mollie.com", domain: "mollie.com", company: "Mollie", kind: "org", stage: "enriched", updated: NOW, evidence: [] };
  const withExpo = { ...base, evidence: [{ claim: 'hiring for Expo, EAS, React Native on its own greenhouse board: "Mobile Engineer"', url: "https://boards.greenhouse.io/mollie/jobs/1", agent: "discover-jobs", date: NOW }] };
  const [scored] = await qualify.run([withExpo], ctx(dir));
  assert.ok(scored);
  const prod = scored.qualification!.signals.find((s) => s.name === "production_evidence")!;
  assert.equal(prod.value, 1);
  assert.equal(prod.evidence_url, "https://boards.greenhouse.io/mollie/jobs/1");
  assert.equal(scored.qualification!.signals.find((s) => s.name === "hiring_signal")!.value, 1);
  assert.equal(scored.qualification!.score, 0.55); // 0.20 + 0.20 + 0.05 (1.5k ratings → 0.5) + 0.10 (4 releases)
  assert.equal(scored.stage, "qualified");

  const rnOnly = { ...base, evidence: [{ claim: 'hiring for React Native on Remotive: "Mobile Engineer"', url: "https://remotive.com/r/2", agent: "discover-jobs", date: NOW }] };
  const [held] = await qualify.run([rnOnly], ctx(dir));
  assert.equal(held!.qualification!.signals.find((s) => s.name === "production_evidence")!.value, 0);
  assert.equal(held!.stage, "enriched");
  assert.equal(held!.qualification!.action, "hold");
});

test("discover-jobs web search: Claude finds, the fleet verifies — unreachable or off-stack pages never become receipts", async () => {
  const { SearchedBoards, JobBoards, parseSearchResults } = await import("../src/jobs.js");
  assert.deepEqual(parseSearchResults("Here you go:\n```json\n[{\"title\":\"A\",\"url\":\"https://x/1\"}]\n```"), [{ title: "A", url: "https://x/1" }]);
  assert.deepEqual(parseSearchResults("no array here"), []);

  const boards = new JobBoards({ mode: "live", fetchJson: async (url) => {
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs")) return { jobs: [{ title: "Senior React Native Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/7", content: "Expo and EAS Update, see https://acme.com" }] };
    throw new Error("unexpected " + url);
  } });
  const searched = new SearchedBoards({
    mode: "live",
    boards,
    searcher: { async search() { return { text: JSON.stringify([
      { title: "Senior React Native Engineer", company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/7" },     // verified via the board API
      { title: "Mobile Engineer", company: "Globex", url: "https://globex.com/careers/mobile" },                        // verified by fetching the page
      { title: "Backend Engineer", company: "Initech", url: "https://initech.com/jobs/1" },                              // page exists but never names the stack
      { title: "React Native Lead", company: "Ghost", url: "https://ghost.example/jobs/404" },                          // does not resolve
      { title: "React Native Lead", company: "Plain", url: "http://plain.example/jobs/1" },                             // not https
    ]), tokens_in: 100, tokens_out: 50 }; } },
    fetchText: async (url) => url.includes("globex") ? "<h1>Mobile Engineer</h1><p>We ship with Expo on React Native.</p>" : url.includes("initech") ? "<p>Go, Postgres</p>" : null,
  });
  const found = await searched.find(7, "claude-haiku-4-5-20251001");
  assert.equal(found.considered, 5);
  assert.deepEqual(found.posts.map((p) => p.url), ["https://boards.greenhouse.io/acme/jobs/7", "https://globex.com/careers/mobile", "https://initech.com/jobs/1"]);
  // initech survives verification (the page exists) but the agent's STACK test drops it — checked via stackTerms:
  assert.deepEqual(stackTerms(`${found.posts[2]!.title}\n${found.posts[2]!.text}`), []);
  assert.ok(found.posts[0]!.text.includes("EAS Update"));
  assert.equal(found.tokens_in, 100);

  // no searcher → nothing, quietly; fixture → pre-verified file
  const off = new SearchedBoards({ mode: "live", boards, searcher: null });
  assert.equal(off.available, false);
  assert.deepEqual((await off.find(7, "m")).posts, []);
  const broken = new SearchedBoards({ mode: "live", boards, searcher: { async search() { throw new Error("cli down"); } } });
  assert.deepEqual((await broken.find(7, "m")).posts, []);
});
