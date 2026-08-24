import { createHash } from "node:crypto";
import type { Account, Evidence } from "./types.js";

export const DISCOVERY_AGENTS = new Set(["discover", "discover-jobs", "discover-issues", "discover-gitlab"]);
const REFRESH_MS = 24 * 60 * 60_000;

export function sourceFingerprint(repos: string[] = [], evidence: Evidence[] = []): string {
  const sources = evidence
    .filter((item) => DISCOVERY_AGENTS.has(item.agent))
    .map((item) => `${item.agent}\u0000${item.claim}\u0000${item.url}`)
    .sort();
  return createHash("sha256").update(JSON.stringify([[...repos].sort(), sources])).digest("hex").slice(0, 16);
}

export function needsRefresh(account: Account, now: string): boolean {
  const last = account.pipeline?.last_full_refresh;
  return !last || !Number.isFinite(Date.parse(last)) || Date.parse(now) - Date.parse(last) >= REFRESH_MS;
}

export function invalidateDerived(account: Account, now: string): Account {
  const sourceEvidence = account.evidence.filter((item) => DISCOVERY_AGENTS.has(item.agent));
  return {
    org: account.org,
    ...(account.domain ? { domain: account.domain } : {}),
    ...(account.company ? { company: account.company } : {}),
    stage: "discovered",
    evidence: sourceEvidence,
    updated: now,
    ...(account.repos ? { repos: account.repos } : {}),
    pipeline: {
      source_fingerprint: sourceFingerprint(account.repos, sourceEvidence),
      ...(account.pipeline?.last_full_refresh ? { last_full_refresh: account.pipeline.last_full_refresh } : {}),
    },
  };
}

export function withSourceState(account: Account): Account {
  return {
    ...account,
    pipeline: {
      ...account.pipeline,
      source_fingerprint: sourceFingerprint(account.repos, account.evidence),
    },
  };
}

export function markFullyRefreshed(account: Account, now: string): Account {
  return {
    ...account,
    pipeline: {
      ...account.pipeline,
      source_fingerprint: sourceFingerprint(account.repos, account.evidence),
      last_full_refresh: now,
    },
  };
}
