// GitLab fetch layer. Deliberately thin: GitLab has no unauthenticated code search,
// so the best public probe is project name/description search — which is exactly why
// discover-gitlab is the designed retirement candidate (see registry.yaml hypothesis).

import { join } from "node:path";
import type { FetchMode } from "./gh.js";
import type { HttpClient } from "./http.js";
import { CachedFetch, readJson } from "./web.js";

export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  namespace: { path: string; kind?: string; full_path?: string };
  web_url: string;
  description?: string | null;
  last_activity_at?: string;
}

export interface GitLabSearch {
  projects: GitLabProject[];
}

const API = "https://gitlab.com/api/v4";

export class GitLabClient {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;
  private readonly fetcher: CachedFetch;

  constructor(opts: { mode: FetchMode; fixtureDir?: string; cacheDir?: string; http?: HttpClient }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
    this.fetcher = new CachedFetch(opts.cacheDir ?? "data/cache", opts.http);
  }

  // Fixture mode records one canned result set regardless of the query.
  async searchProjects(query: string): Promise<GitLabSearch> {
    if (this.mode === "fixture") {
      const file = join(this.fixtureDir, "gitlab", "search.json");
      const body = readJson<GitLabSearch>(file);
      if (!body) throw new Error(`missing fixture ${file} — the fixture set is incomplete`);
      return body;
    }
    const url = `${API}/projects?search=${encodeURIComponent(query)}&visibility=public&order_by=last_activity_at&per_page=50`;
    const body = await this.fetcher.json<GitLabProject[]>(url);
    return { projects: body ?? [] };
  }
}
