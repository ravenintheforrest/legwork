// App-store signals: the public MAU/build proxies EAS bills on (see packs/expo/icp.yaml).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchMode } from "./gh.js";

export interface StoreRecord {
  org: string;
  app_name: string;
  store_url: string;
  review_count: number;
  updates_last_90d: number;
  last_update?: string;
}

export class StoreSignals {
  private readonly mode: FetchMode;
  private readonly fixtureDir: string;

  constructor(opts: { mode: FetchMode; fixtureDir?: string }) {
    this.mode = opts.mode;
    this.fixtureDir = opts.fixtureDir ?? "fixtures";
  }

  async lookup(org: string): Promise<StoreRecord | null> {
    // No live adapter yet: an unknown signal scores zero and cites nothing, which is
    // the honest outcome. Guessing here would put an unsourced number in a brief.
    if (this.mode === "live") return null;

    const file = join(this.fixtureDir, "store", `${org}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as StoreRecord;
  }
}
