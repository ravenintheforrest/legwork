// The fetch layer. Every external GitHub call goes through here, so fixture mode is a
// property of the harness rather than a branch inside each agent.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FetchMode = "live" | "fixture";

export interface CodeSearchItem {
  name: string;
  path: string;
  html_url: string;
  repository: {
    full_name: string;
    private?: boolean;
    fork?: boolean;
    html_url: string;
    description?: string | null;
    owner: { login: string; type: string };
  };
}

export interface CodeSearch {
  total_count: number;
  incomplete_results?: boolean;
  items: CodeSearchItem[];
}

// One shape for /orgs/<login> and /users/<login> — resolve only reads the common fields.
export interface OrgProfile {
  login: string;
  type?: string;
  name?: string | null;
  blog?: string | null;
  description?: string | null;
  html_url: string;
  public_repos?: number;
  followers?: number;
  created_at?: string;
}

export interface Repo {
  full_name: string;
  html_url: string;
  description?: string | null;
  fork?: boolean;
  archived?: boolean;
  pushed_at?: string;
  default_branch?: string;
}

export interface ContentsEntry {
  name: string;
  path: string;
  type: string;
  html_url?: string;
}

export interface Contents {
  type: "file" | "dir";
  name?: string;
  path: string;
  html_url: string;
  content?: unknown;          // parsed JSON when the file is JSON, else raw text
  entries?: ContentsEntry[];  // directories only
}

interface CacheEntry {
  url: string;
  fetched_at: string;
  status: number;
  body: unknown;
}

const API = "https://api.github.com";

export class GitHubClient {
  private readonly mode: FetchMode;
  private readonly token: string | undefined;
  private readonly fixtureDir: string;
  private readonly cacheDir: string;

  constructor(opts: { mode: FetchMode; token?: string; fixtureDir?: string; cacheDir?: string }) {
    this.mode = opts.mode;
    this.token = opts.token;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.cacheDir = opts.cacheDir ?? "data/cache";
  }

  // Fixture mode records one canned result set regardless of the query — a documented
  // limitation: query variations are not replayed, only the recorded one.
  async searchCode(query: string): Promise<CodeSearch> {
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "github", "search", "code.json");
      const body = readJson<CodeSearch>(file);
      if (!body) throw new Error(`missing fixture ${file} — the fixture set is incomplete`);
      return body;
    }
    const body = await this.get<CodeSearch>(`${API}/search/code?q=${encodeURIComponent(query)}`);
    return body ?? { total_count: 0, items: [] };
  }

  async org(login: string): Promise<OrgProfile | null> {
    if (this.mode === "fixture") {
      return readJson<OrgProfile>(join(this.fixtureDir, "github", "orgs", `${login}.json`));
    }
    return this.get<OrgProfile>(`${API}/orgs/${login}`);
  }

  async user(login: string): Promise<OrgProfile | null> {
    if (this.mode === "fixture") {
      return readJson<OrgProfile>(join(this.fixtureDir, "github", "users", `${login}.json`));
    }
    return this.get<OrgProfile>(`${API}/users/${login}`);
  }

  async repo(owner: string, name: string): Promise<Repo | null> {
    if (this.mode === "fixture") {
      return readJson<Repo>(join(this.fixtureDir, "github", "repos", `${owner}__${name}.json`));
    }
    return this.get<Repo>(`${API}/repos/${owner}/${name}`);
  }

  async contents(owner: string, name: string, path: string): Promise<Contents | null> {
    const slug = path.split("/").join("__");
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "github", "contents", `${owner}__${name}__${slug}.json`);
      return readJson<Contents>(file);
    }
    const body = await this.get<unknown>(`${API}/repos/${owner}/${name}/contents/${path}`);
    if (body === null) return null;
    return normalizeContents(body, owner, name, path);
  }

  // Read-through cache; 404s are cached too, so a missing file is not re-fetched every run.
  private async get<T>(url: string): Promise<T | null> {
    const cached = this.readCache(url);
    if (cached) return cached.status === 404 ? null : (cached.body as T);

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(url, { headers });

    if (response.status === 404) {
      this.writeCache({ url, fetched_at: new Date().toISOString(), status: 404, body: null });
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`GET ${url} → ${response.status}: ${text}`);
    }
    const body = (await response.json()) as T;
    this.writeCache({ url, fetched_at: new Date().toISOString(), status: response.status, body });
    return body;
  }

  private cachePath(url: string): string {
    return join(this.cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  private readCache(url: string): CacheEntry | null {
    return readJson<CacheEntry>(this.cachePath(url));
  }

  private writeCache(entry: CacheEntry): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.cachePath(entry.url), JSON.stringify(entry));
  }
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null; // absence of a fixture is a 404
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// Live file contents arrive base64-encoded; live directory contents arrive as a bare
// array. Fixtures carry both already normalized (authored for readability).
function normalizeContents(body: unknown, owner: string, name: string, path: string): Contents {
  if (Array.isArray(body)) {
    const entries = body as ContentsEntry[];
    return {
      type: "dir",
      path,
      html_url: dirUrl(entries, owner, name, path),
      entries,
    };
  }
  const file = body as {
    name?: string;
    path?: string;
    html_url?: string;
    content?: string;
    encoding?: string;
  };
  let content: unknown = file.content;
  if (typeof file.content === "string" && file.encoding === "base64") {
    const text = Buffer.from(file.content, "base64").toString("utf8");
    content = parseJsonOrText(text);
  }
  return {
    type: "file",
    name: file.name,
    path: file.path ?? path,
    html_url: file.html_url ?? `https://github.com/${owner}/${name}/blob/HEAD/${path}`,
    content,
  };
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A directory listing has no URL of its own; derive it from an entry's blob URL.
function dirUrl(entries: ContentsEntry[], owner: string, name: string, path: string): string {
  const first = entries.find((e) => typeof e.html_url === "string")?.html_url;
  if (first) {
    const parent = first.slice(0, first.lastIndexOf("/"));
    return parent.replace("/blob/", "/tree/");
  }
  return `https://github.com/${owner}/${name}/tree/HEAD/${path}`;
}
