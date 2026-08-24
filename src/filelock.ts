import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 10 * 60_000;

export class FileLockError extends Error {
  constructor(path: string) {
    super(`another legwork process holds ${path}`);
    this.name = "FileLockError";
  }
}

export function withFileLock<T>(path: string, work: () => T, staleMs = DEFAULT_STALE_MS): T {
  acquire(path, staleMs);
  try {
    return work();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

export async function withFileLockAsync<T>(
  path: string,
  work: () => Promise<T>,
  staleMs = DEFAULT_STALE_MS,
): Promise<T> {
  acquire(path, staleMs);
  try {
    return await work();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function acquire(path: string, staleMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if (!isStale(path, staleMs)) throw new FileLockError(path);
    rmSync(path, { recursive: true, force: true });
    try {
      mkdirSync(path);
    } catch {
      throw new FileLockError(path);
    }
  }
  writeFileSync(`${path}/owner.json`, JSON.stringify({ pid: process.pid, acquired: new Date().toISOString() }) + "\n");
}

function isStale(path: string, staleMs: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(`${path}/owner.json`, "utf8")) as { pid?: number; acquired?: string };
    if (typeof owner.acquired !== "string" || Date.now() - Date.parse(owner.acquired) <= staleMs) return false;
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") return false;
      }
    }
    return true;
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
}
