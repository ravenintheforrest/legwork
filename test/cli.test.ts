// The operator surface itself: the two verbs this workstream added, plus the read-only
// verbs that must never blow up on an empty repo. Everything runs in a working copy.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCli, withWorkingCopy } from "./helpers/env.js";

test("legwork selftest runs offline and reports a green summary", async () => {
  await withWorkingCopy((dir) => {
    // A subset, so the suite does not re-run the whole selftest inside itself.
    const result = runCli(dir, ["selftest", "--only", "cost ceiling"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PASS · \d+ checks/m);
    assert.match(result.stdout, /cost ceiling kills past the boundary, not at it\s+pass/);
    assert.match(result.stdout, /live artifacts untouched/);
    assert.match(result.stdout, /Offline, no credentials/);
  });
});

test("legwork selftest fails loudly when a named check does not exist", async () => {
  await withWorkingCopy((dir) => {
    const result = runCli(dir, ["selftest", "--only", "no-such-check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no check matches "no-such-check"/);
  });
});

test("legwork soak refuses without a token instead of guessing or reaching out", async () => {
  await withWorkingCopy((dir) => {
    const result = runCli(dir, ["soak", "--orgs", "1"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs GITHUB_TOKEN/);
    assert.match(result.stderr, /legwork selftest/);
  });
});

test("legwork soak validates --orgs before doing anything", async () => {
  await withWorkingCopy((dir) => {
    const result = runCli(dir, ["soak", "--orgs", "zero"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--orgs must be a positive integer/);
  });
});

test("read-only verbs are safe on a repo with no state yet", async () => {
  await withWorkingCopy((dir) => {
    const status = runCli(dir, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /no runs yet/);

    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "accounts.jsonl"), "");
    const show = runCli(dir, ["show", "nobody"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /no account "nobody"/);
  });
});

test("an unknown verb is an error, not a silent no-op", async () => {
  await withWorkingCopy((dir) => {
    const result = runCli(dir, ["frobnicate"]);
    assert.notEqual(result.status, 0);
  });
});
