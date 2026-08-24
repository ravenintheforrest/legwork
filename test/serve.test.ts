// The operator desk. Every endpoint is exercised against a real server bound to a
// reserved ephemeral port, running inside a throwaway working copy so its writes land in
// the temp tree instead of the repo's. The server is always shut down in a finally.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import test from "node:test";
import { runCli, withWorkingCopy } from "./helpers/env.js";
import { call, startDesk, type Desk } from "./helpers/server.js";
import type { Account } from "../src/types.js";

const PANELS = ["inbox", "accounts", "search", "system"];

function accountsIn(dir: string): Account[] {
  const file = join(dir, "data", "accounts.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Account);
}

/** One server, one working copy, seeded by a demo run so the panels have something to show. */
async function withDesk(fn: (desk: Desk, dir: string) => Promise<void>): Promise<void> {
  await withWorkingCopy(async (dir) => {
    assert.equal(runCli(dir, ["demo"]).status, 0, "the desk needs state to serve");
    const desk = await startDesk(dir);
    try {
      await fn(desk, dir);
    } finally {
      await desk.stop();
    }
  });
}

async function waitForRun(base: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await call(base, "GET", "/api/run/status");
    assert.equal(status.status, 200);
    const body = status.body as Record<string, unknown>;
    if (body.running === false) return body;
    if (Date.now() > deadline) throw new Error(`run never finished: ${status.text}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

test("the desk serves its console, every panel, and every action", async (t) => {
  await withDesk(async (desk, dir) => {
    // --- GET / ---------------------------------------------------------------
    const home = await call(desk.base, "GET", "/");
    assert.equal(home.status, 200);
    assert.ok(/^<!doctype html>/i.test(home.text.trim()), "the desk serves the console page");
    assert.ok(home.text.includes("legwork"), "the console names itself");

    // --- GET /api/state ------------------------------------------------------
    const state = await call(desk.base, "GET", "/api/state");
    assert.equal(state.status, 200);
    const statePayload = state.body as { ok: boolean; html: Record<string, string> };
    assert.equal(statePayload.ok, true);
    assert.equal(typeof statePayload.html, "object");
    for (const panel of PANELS) {
      assert.equal(typeof statePayload.html[panel], "string", `missing panel: ${panel}`);
    }
    assert.ok(
      Object.keys(statePayload.html).length >= PANELS.length,
      `expected at least ${PANELS.length} panels, got ${Object.keys(statePayload.html).join(", ")}`,
    );

    // --- POST /api/run + 409 + status ----------------------------------------
    const idle = await call(desk.base, "GET", "/api/run/status");
    assert.equal((idle.body as Record<string, unknown>).running, false);

    const started = await call(desk.base, "POST", "/api/run", { mode: "fixture" });
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { ok: true });

    // "One run at a time" — the 409. A fixture run never awaits real I/O, so the whole
    // pipeline completes inside a single event-loop turn and the server cannot parse a
    // second request while `running` is true. Eight simultaneous POSTs still serialize.
    // So: if the window is ever observed, its shape is checked; otherwise what is checked
    // is that concurrent runs did not corrupt each other. See the report.
    const stampede = await Promise.all(
      Array.from({ length: 8 }, () => call(desk.base, "POST", "/api/run", { mode: "fixture" })),
    );
    const refused = stampede.filter((r) => r.status === 409);
    for (const reply of refused) {
      assert.match(String((reply.body as Record<string, unknown>).error), /already active/);
    }
    for (const reply of stampede) {
      assert.ok([200, 409].includes(reply.status), `unexpected ${reply.status}: ${reply.text}`);
    }
    if (refused.length === 0) {
      t.diagnostic(
        "no 409 observed: a fixture run completes within one event-loop turn, so the " +
          "concurrent-run guard is only reachable on a live run",
      );
    }

    const finished = await waitForRun(desk.base);
    assert.equal(finished.running, false);
    assert.equal(finished.error, undefined, `the fixture run must not fail: ${JSON.stringify(finished)}`);
    const lines = finished.lines as string[];
    assert.ok(lines.some((l) => l.includes("done · fixture run finished")), lines.join("\n"));
    assert.equal(typeof finished.startedAt, "string");

    // A run through the desk is the same run the CLI makes: state landed on disk.
    assert.ok(accountsIn(dir).length > 0);

    // --- POST /api/run validation --------------------------------------------
    const badMode = await call(desk.base, "POST", "/api/run", { mode: "sideways" });
    assert.equal(badMode.status, 400);
    assert.match(String((badMode.body as Record<string, unknown>).error), /mode must be/);

    const noToken = await call(desk.base, "POST", "/api/run", { mode: "live" });
    assert.equal(noToken.status, 400, "a live run without a token is refused, not fatal");
    assert.match(String((noToken.body as Record<string, unknown>).error), /GITHUB_TOKEN/);

    // --- POST /api/review ----------------------------------------------------
    const noOrg = await call(desk.base, "POST", "/api/review", { decision: "approve" });
    assert.equal(noOrg.status, 400);
    assert.match(String((noOrg.body as Record<string, unknown>).error), /org is required/);

    const badDecision = await call(desk.base, "POST", "/api/review", { org: "acme", decision: "maybe" });
    assert.equal(badDecision.status, 400);
    assert.match(String((badDecision.body as Record<string, unknown>).error), /decision must be/);

    const queued = accountsIn(dir).find((a) => a.review?.status === "queued");
    if (queued) {
      const approved = await call(desk.base, "POST", "/api/review", {
        org: queued.org,
        decision: "approve",
      });
      assert.equal(approved.status, 200, approved.text);
      assert.deepEqual(approved.body, { ok: true });
      assert.equal(accountsIn(dir).find((a) => a.org === queued.org)?.review?.status, "approved");
      assert.ok(existsSync(join(dir, "briefs", `${queued.org}.md`)));
      assert.equal(existsSync(join(dir, "briefs", "queue", `${queued.org}.md`)), false);
    }
    const unknown = await call(desk.base, "POST", "/api/review", { org: "not-an-org", decision: "approve" });
    assert.equal(unknown.status, 400);
    assert.match(String((unknown.body as Record<string, unknown>).error), /no queued brief/);

    // --- POST /api/retire ----------------------------------------------------
    const retireNoAgent = await call(desk.base, "POST", "/api/retire", {});
    assert.equal(retireNoAgent.status, 400);
    assert.match(String((retireNoAgent.body as Record<string, unknown>).error), /agent is required/);

    const anyAgent = JSON.parse(
      readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n")[0]!,
    ) as { agent: string };
    const retired = await call(desk.base, "POST", "/api/retire", { agent: anyAgent.agent });
    assert.equal(retired.status, 200, retired.text);
    const memo = (retired.body as { memo: string }).memo;
    assert.match(memo, /# Retirement memo/);
    assert.ok(existsSync(join(dir, "memos", `retire-${anyAgent.agent}.md`)));

    const retireUnknown = await call(desk.base, "POST", "/api/retire", { agent: "not-an-agent" });
    assert.equal(retireUnknown.status, 400);

    // --- POST /api/evals -----------------------------------------------------
    const evals = await call(desk.base, "POST", "/api/evals", {});
    assert.equal(evals.status, 200, evals.text);
    const evalBody = evals.body as { ok: boolean; output: string; regressions: boolean };
    assert.equal(evalBody.ok, true);
    assert.equal(typeof evalBody.regressions, "boolean");
    assert.match(evalBody.output, /metric\s+score\s+ratio/);

    // --- errors --------------------------------------------------------------
    const missing = await call(desk.base, "GET", "/api/nope");
    assert.equal(missing.status, 404);
    assert.match(String((missing.body as Record<string, unknown>).error), /no route GET \/api\/nope/);

    const wrongMethod = await call(desk.base, "GET", "/api/run");
    assert.equal(wrongMethod.status, 404, "GET on a POST-only route is not a route");

    const malformed = await call(desk.base, "POST", "/api/run", "{not json");
    assert.equal(malformed.status, 400);
    assert.match(String((malformed.body as Record<string, unknown>).error), /not valid JSON/);

    const arrayBody = await call(desk.base, "POST", "/api/review", "[1,2,3]");
    assert.equal(arrayBody.status, 400);
    assert.match(String((arrayBody.body as Record<string, unknown>).error), /must be a JSON object/);

    // The desk survived every one of those.
    const alive = await call(desk.base, "GET", "/api/state");
    assert.equal(alive.status, 200);
    assert.equal(desk.child.exitCode, null, "the server must still be running");
  });
});



test("the desk API refuses missing tokens, cross-origin requests, forged hosts, and non-JSON writes", async () => {
  await withWorkingCopy(async (dir) => {
    const desk = await startDesk(dir);
    try {
      const missing = await fetch(desk.base + "/api/state");
      assert.equal(missing.status, 403);

      const crossOrigin = await fetch(desk.base + "/api/state", {
        headers: { "x-legwork-token": desk.token, origin: "https://evil.example" },
      });
      assert.equal(crossOrigin.status, 403);

      const forgedHost = await new Promise<number>((resolve, reject) => {
        const target = new URL(desk.base);
        const req = request({
          hostname: target.hostname,
          port: target.port,
          path: "/api/state",
          headers: { "x-legwork-token": desk.token, host: "evil.example" },
        }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(forgedHost, 403);

      const form = await fetch(desk.base + "/api/evals", {
        method: "POST",
        headers: { "x-legwork-token": desk.token, "content-type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
      assert.equal(form.status, 415);

      const valid = await call(desk.base, "GET", "/api/state");
      assert.equal(valid.status, 200);
    } finally {
      await desk.stop();
    }
  });
});
test("the desk binds loopback only and refuses a port already in use", async () => {
  await withWorkingCopy(async (dir) => {
    const desk = await startDesk(dir);
    try {
      assert.match(desk.output(), /local operator desk on http:\/\/127\.0\.0\.1:/);
      const port = new URL(desk.base).port;
      const clash = runCli(dir, ["serve", "--port", port, "--no-open"], 30_000);
      assert.equal(clash.status, 1);
      assert.match(clash.stderr, /already in use/);
    } finally {
      await desk.stop();
    }
  });
});

test("an out-of-range port is rejected before anything binds", async () => {
  await withWorkingCopy((dir) => {
    const result = runCli(dir, ["serve", "--port", "99999", "--no-open"], 30_000);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--port must be a number between 1 and 65535/);
  });
});
