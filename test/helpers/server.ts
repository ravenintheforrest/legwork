// Boot `legwork serve` inside a working copy and talk to it over HTTP.
//
// startServer() neither returns the server nor reports the bound port, and the CLI
// rejects `--port 0`, so the port is reserved here first and handed to the child. The
// child is a separate process with cwd inside the temp copy, which is also what keeps
// its writes (data/, briefs/, memos/) out of the repo.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { assertTemp, offlineEnv } from "./env.js";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export interface Desk {
  base: string;
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

export async function startDesk(dir: string, timeoutMs = 30_000): Promise<Desk> {
  assertTemp(dir);
  const port = await freePort();
  const child = spawn(
    join(dir, "node_modules", ".bin", "tsx"),
    [join("src", "cli.ts"), "serve", "--port", String(port), "--no-open"],
    { cwd: dir, env: offlineEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`serve exited early (${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(base + "/", { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        await res.text();
        return { base, child, output: () => output, stop };
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`serve never came up on ${base}:\n${output}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

export interface Reply {
  status: number;
  body: unknown;
  text: string;
}

export async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown | string,
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}
