import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadAccounts, mergeAccounts, saveAccounts } from "../src/store.js";
import type { Account } from "../src/types.js";
import { withTempDir } from "./helpers/env.js";
import { account, evidence } from "./helpers/fleet.js";

test("save/load is a roundtrip, including nested evidence", async () => {
  await withTempDir((dir) => {
    const file = join(dir, "nested", "accounts.jsonl");
    const accounts: Account[] = [
      account({ org: "zulu", evidence: [evidence("uses expo", "https://example.com/a")] }),
      account({ org: "alpha", stage: "discovered", repos: ["alpha/app"] }),
    ];
    saveAccounts(accounts, file);
    const loaded = loadAccounts(file);
    assert.equal(loaded.length, 2);
    assert.deepEqual(
      [...loaded].sort((a, b) => (a.org < b.org ? -1 : 1)),
      [...accounts].sort((a, b) => (a.org < b.org ? -1 : 1)),
    );
  });
});

test("loading a file that does not exist is empty, not an error", async () => {
  await withTempDir((dir) => {
    assert.deepEqual(loadAccounts(join(dir, "nope.jsonl")), []);
  });
});

test("output is sorted by org and stable across writes", async () => {
  await withTempDir((dir) => {
    const file = join(dir, "accounts.jsonl");
    const accounts = ["mike", "alpha", "zulu", "bravo"].map((org) => account({ org }));
    saveAccounts(accounts, file);
    const first = readFileSync(file, "utf8");
    assert.deepEqual(
      first.trim().split("\n").map((line) => (JSON.parse(line) as Account).org),
      ["alpha", "bravo", "mike", "zulu"],
    );
    // A different input order must produce a byte-identical file.
    saveAccounts([...accounts].reverse(), file);
    assert.equal(readFileSync(file, "utf8"), first);
    // And saving does not mutate the caller's array order.
    assert.deepEqual(accounts.map((a) => a.org), ["mike", "alpha", "zulu", "bravo"]);
  });
});

test("an empty account list writes an empty file, not a stray newline", async () => {
  await withTempDir((dir) => {
    const file = join(dir, "accounts.jsonl");
    saveAccounts([], file);
    assert.equal(readFileSync(file, "utf8"), "");
    assert.deepEqual(loadAccounts(file), []);
  });
});

test("mergeAccounts upserts by org and preserves first-seen order", () => {
  const state = [
    account({ org: "alpha", stage: "discovered" }),
    account({ org: "bravo", stage: "discovered" }),
  ];
  const merged = mergeAccounts(state, [
    account({ org: "bravo", stage: "qualified" }),
    account({ org: "charlie", stage: "discovered" }),
  ]);
  assert.deepEqual(merged.map((a) => a.org), ["alpha", "bravo", "charlie"]);
  assert.equal(merged.find((a) => a.org === "bravo")!.stage, "qualified");
  // The reducer owns its output: an update replaces the record wholesale.
  assert.equal(state[1]!.stage, "discovered", "the input state must not be mutated");
});

test("write-then-rename leaves no temp file and never truncates a good file", async () => {
  await withTempDir((dir) => {
    const file = join(dir, "accounts.jsonl");
    saveAccounts([account({ org: "alpha" })], file);
    assert.equal(existsSync(`${file}.tmp`), false, "the temp file must be renamed away");

    const good = readFileSync(file, "utf8");
    // Simulate the crash window: a stale temp file from a killed process must not be
    // mistaken for state, and the next successful save must overwrite it cleanly.
    writeFileSync(`${file}.tmp`, "{ truncated garbage");
    assert.equal(readFileSync(file, "utf8"), good, "the live file survives a stale temp file");
    assert.deepEqual(loadAccounts(file).map((a) => a.org), ["alpha"]);

    saveAccounts([account({ org: "alpha" }), account({ org: "bravo" })], file);
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.deepEqual(loadAccounts(file).map((a) => a.org), ["alpha", "bravo"]);
  });
});
