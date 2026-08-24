// Shared plumbing for the suite. Two rules live here and nowhere else:
//   1. nothing writes outside a fresh mkdtemp directory (assertTemp guards every path
//      the helpers hand out, so a mistake fails loudly instead of eating demo state);
//   2. child processes inherit a scrubbed environment, so a stray ANTHROPIC_API_KEY or
//      GITHUB_TOKEN on the developer's machine can never turn an offline test live.

import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// macOS hands out /var/folders/... from tmpdir() but /private/var/folders/... from
// realpath and process.cwd(); compare realpaths or the guard rejects its own directories.
const TMP_ROOT = realpathSync(tmpdir());

/** The four live artifact trees the hard rule protects. */
export const SEALED_TREES = ["data", "briefs", "memos", "site"] as const;

/** Everything a working copy needs to run the CLI offline. `data/` etc. are deliberately absent. */
export const WORKING_COPY_PARTS = [
  "src",
  "packs",
  "fixtures",
  "registry.yaml",
  "tsconfig.json",
  "package.json",
] as const;

export function tempDir(prefix = "legwork-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Refuse to touch anything that is not inside the OS temp root. */
export function assertTemp(dir: string): string {
  const real = realpathSync(dir);
  if (real !== TMP_ROOT && !real.startsWith(TMP_ROOT + "/")) {
    throw new Error(`refusing to operate outside the temp root: ${dir}`);
  }
  return real;
}

export function removeTemp(dir: string): void {
  assertTemp(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A throwaway copy of the repo that can be run like the repo. Source and fixtures are
 * copied (not symlinked) so `import.meta.url`-relative lookups resolve inside the copy;
 * node_modules is symlinked because 68MB per test is not a testing strategy.
 */
export function workingCopy(parts: readonly string[] = WORKING_COPY_PARTS): string {
  const dir = tempDir("legwork-copy-");
  assertTemp(dir);
  for (const part of parts) {
    cpSync(join(REPO_ROOT, part), join(dir, part), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** Run `fn` with a fresh temp directory, always cleaned up. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = tempDir();
  try {
    return await fn(dir);
  } finally {
    removeTemp(dir);
  }
}

/** Run `fn` with a fresh working copy, always cleaned up. */
export async function withWorkingCopy<T>(
  fn: (dir: string) => Promise<T> | T,
  parts?: readonly string[],
): Promise<T> {
  const dir = workingCopy(parts);
  try {
    return await fn(dir);
  } finally {
    removeTemp(dir);
  }
}

/**
 * chdir into a temp directory for the duration of `fn`. Modules that hardcode relative
 * paths (`briefs/`, `memos/`, `data/reviews.jsonl`) are redirected this way rather than
 * refactored, because they belong to other workstreams right now.
 */
export async function inDir<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  assertTemp(dir);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/** Environment with every credential and provider switch removed. Offline by construction. */
export function offlineEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SLACK_WEBHOOK_URL", "LEGWORK_LLM"]) {
    delete env[key];
  }
  return env;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `legwork <args>` inside a working copy, offline. */
export function runCli(dir: string, args: string[], timeoutMs = 120_000): CliResult {
  assertTemp(dir);
  const result: SpawnSyncReturns<string> = spawnSync(
    join(dir, "node_modules", ".bin", "tsx"),
    [join("src", "cli.ts"), ...args],
    { cwd: dir, env: offlineEnv(), encoding: "utf8", timeout: timeoutMs },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
