// The account as a person reads it. One derivation from the account record and its brief
// file into the shapes the review page renders: who they are, the few numbers worth
// knowing, what we found, who to talk to, the opener, a verdict in words, and what we have
// against what we could not find.
//
// Nothing here invents a fact. Every sentence is an evidence claim (or the model's opener,
// which the citations gate already restricted to evidence), and every number is parsed out
// of a claim one of our own units wrote: the patterns below match the templates in
// src/agents/qualify.ts and src/agents/people.ts. A claim that matches none of them renders
// as itself, and a number that is not in the evidence is not shown — not estimated, not
// fetched from a provider, just absent.

import type { Account, Evidence, QualificationSignal } from "./types.js";

/** A run of text and, when it came from a receipt, the receipt. */
export interface Cited {
  text: string;
  url?: string;
  claim?: string;
}

export interface Stat {
  value: string;
  label: string;
  url: string;
  claim: string;
}

export interface Person {
  name: string;
  detail: string;
  url: string;
  claim: string;
}

export interface Verdict {
  word: string;
  tone: "ok" | "warn";
  /** Score as a percentage of 1.0 — the bar under the word. */
  pct: number;
  meaning: string;
}

export interface CheckItem {
  label: string;
  url?: string;
}

export interface BriefView {
  org: string;
  company: string;
  domain?: string;
  /** Org HQ as the GitHub profile lists it, with the profile as its receipt. */
  location: Cited | null;
  initial: string;
  segment?: string;
  /** Fixture record: authored receipts, links may not resolve. Said on the card. */
  sample: boolean;
  stats: Stat[];
  about: Cited | null;
  found: Cited[];
  people: Person[];
  opener: Cited[];
  verdict: Verdict;
  have: CheckItem[];
  missing: CheckItem[];
  score: number;
  threshold: number;
  gate: number;
}

export function buildBriefView(account: Account, opts: { gate: number; brief?: string }): BriefView {
  const company = account.company ?? account.org;
  const evidence = dedupe(account.evidence ?? []);
  const q = account.qualification;
  const score = q?.score ?? account.confidence ?? 0;
  const threshold = q?.threshold ?? 0;
  const { have, missing } = checklist(q?.signals ?? []);

  return {
    org: account.org,
    company,
    domain: account.domain,
    location: location(account, evidence),
    initial: (company.trim()[0] ?? "?").toUpperCase(),
    segment: account.segment,
    sample: account.mode === "fixture",
    stats: stats(evidence),
    about: about(evidence, company),
    found: found(evidence),
    people: people(evidence),
    opener: opts.brief ? parseOpener(opts.brief) : [],
    verdict: q ? verdictFor(score, threshold, opts.gate) : UNSCORED,
    have,
    missing,
    score,
    threshold,
    gate: opts.gate,
  };
}

// --- where they are ------------------------------------------------------------------

// resolve copies the org profile's location onto the account; the receipt is the profile
// resolve already cited, so the number on the card and the link under it agree.
function location(account: Account, evidence: Evidence[]): Cited | null {
  if (!account.location) return null;
  const profile = evidence.find((e) => e.agent === "resolve" && /^https:\/\/github\.com\/[^/]+\/?$/.test(e.url));
  return { text: account.location, url: profile?.url ?? `https://github.com/${account.org}`, claim: profile?.claim ?? `GitHub org profile: ${account.org}` };
}

// --- the verdict ---------------------------------------------------------------------

// No qualification record is not a low score; it is no score, and the card says so.
const UNSCORED: Verdict = { word: "Not scored yet", tone: "warn", pct: 0, meaning: "No qualification record on this account. Run qualify before judging it." };

// Words first; the number is a footnote. The three bands are the three things the pipeline
// itself does with a score: publish past the gate, queue for a human past the threshold,
// hold below it.
export function verdictFor(score: number, threshold: number, gate: number): Verdict {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)));
  if (score >= gate) {
    return {
      word: "Ready to send",
      tone: "ok",
      pct,
      meaning: "Clears the publish gate on its own merits. Sending is still your call here.",
    };
  }
  if (score >= threshold) {
    return {
      word: "Worth a look",
      tone: "ok",
      pct,
      meaning: "Clears the bar for a human to read it, not strong enough to send on its own.",
    };
  }
  return {
    word: "Thin",
    tone: "warn",
    pct,
    meaning: "Below the qualification bar. Read it to calibrate; it is unlikely to be worth the AE's time.",
  };
}

// --- have / couldn't find ----------------------------------------------------------

// Signal names in the words a seller would use. Anything not listed is humanized from
// the identifier, so a new signal still reads as English rather than snake_case.
const SIGNAL_WORDS: Record<string, string> = {
  production_evidence: "Builds on Expo, in their own words or code",
  eas_json_present: "Builds with EAS",
  rn_version_recency: "Current React Native",
  ci_config: "Automated builds in CI",
  team_size_signals: "A visible engineering team",
  repo_activity: "Active repo",
  store_review_volume: "Real app-store presence",
  store_update_cadence: "Shipping store releases",
  regulated_industry: "A regulated industry",
  hiring_signal: "Anyone hiring React Native",
};

export function signalWords(name: string): string {
  const known = SIGNAL_WORDS[name];
  if (known) return known;
  const plain = name.replace(/_/g, " ").trim();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function checklist(signals: QualificationSignal[]): { have: CheckItem[]; missing: CheckItem[] } {
  const have: CheckItem[] = [];
  const missing: CheckItem[] = [];
  for (const s of signals) {
    const item: CheckItem = { label: signalWords(s.name) };
    if (s.evidence_url) item.url = s.evidence_url;
    (s.value > 0 ? have : missing).push(item);
  }
  return { have, missing };
}

// --- the numbers worth knowing -------------------------------------------------------

// Priority order is the order a seller cares: store traction, shipping cadence, stack,
// then GitHub footprint. Four is the design's count; anything past it is still in the
// brief.
const STAT_RULES: Array<{ re: RegExp; make: (m: RegExpExecArray) => Array<{ value: string; label: string }> }> = [
  { re: /has ([\d,]+) App Store ratings/, make: (m) => [{ value: m[1]!, label: "App Store ratings" }] },
  { re: /^(\d+) App Store releases? in the last 90 days/, make: (m) => [{ value: m[1]!, label: "releases in 90 days" }] },
  { re: /react-native ([~^]?[\d.]+)/, make: (m) => [{ value: m[1]!.replace(/^[~^]/, ""), label: "React Native" }] },
  {
    re: /(\d+) public repos? and (\d+) followers/,
    make: (m) => [
      { value: m[1]!, label: "public repos" },
      { value: m[2]!, label: "GitHub followers" },
    ],
  },
  { re: /last pushed (\d{4}-\d{2}-\d{2})/, make: (m) => [{ value: shortDate(m[1]!), label: "last push" }] },
];

function stats(evidence: Evidence[]): Stat[] {
  const out: Stat[] = [];
  const seen = new Set<string>();
  for (const rule of STAT_RULES) {
    for (const e of evidence) {
      const m = rule.re.exec(e.claim);
      if (!m) continue;
      for (const s of rule.make(m)) {
        if (seen.has(s.label)) continue;
        seen.add(s.label);
        out.push({ ...s, url: e.url, claim: e.claim });
      }
      break; // first matching claim per rule
    }
  }
  return out.slice(0, 4);
}

// --- who they are ----------------------------------------------------------------------

// enrich writes `${company} homepage: "${title} — ${description}"`; the description is
// the part a person wants. Falls back to the whole quoted string, then to nothing.
function about(evidence: Evidence[], company: string): Cited | null {
  const e = evidence.find((x) => x.agent === "enrich" && /homepage: "/.test(x.claim));
  if (!e) return null;
  const quoted = /homepage: "([\s\S]*)"\s*$/.exec(e.claim)?.[1] ?? "";
  let text = quoted.includes(" — ") ? quoted.slice(quoted.indexOf(" — ") + 3) : quoted;
  text = text.trim();
  if (!text) return null;
  if (!/^[A-Z]/.test(text) && !text.startsWith(company)) text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text: endStop(text), url: e.url, claim: e.claim };
}

// --- what we found ---------------------------------------------------------------------

const FOUND_AGENTS = new Set(["discover", "discover-gitlab", "discover-jobs", "qualify", "intent"]);

function found(evidence: Evidence[]): Cited[] {
  const out: Cited[] = [];
  const seen = new Set<string>();
  // qualify first — its receipts are the scored signals, in signal order — then the rest.
  const ordered = [...evidence.filter((e) => e.agent === "qualify"), ...evidence.filter((e) => e.agent !== "qualify")];
  for (const e of ordered) {
    if (!FOUND_AGENTS.has(e.agent)) continue;
    if (seen.has(e.claim)) continue;
    seen.add(e.claim);
    out.push({ text: sentence(e.claim), url: e.url, claim: e.claim });
  }
  return out.slice(0, 8);
}

// Our own claim templates, read back as sentences. Anything else: capitalized, full-stopped.
export function sentence(claim: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^eas\.json in (\S+)$/.exec(claim))) return `An eas.json in ${m[1]} — they build through EAS today, not just React Native.`;
  if ((m = /^react-native (\S+) in (\S+)\/package\.json$/.exec(claim))) return `React Native ${m[1]!.replace(/^[~^]/, "")} in ${m[2]}.`;
  if ((m = /^CI workflows in (\S+)$/.exec(claim))) return `CI workflows in ${m[1]} — builds are automated.`;
  if ((m = /^(\d+) public repos? and (\d+) followers on (\S+)$/.exec(claim))) return `${m[1]} public repos and ${m[2]} followers on ${m[3]}.`;
  if ((m = /^(\S+) last pushed (\d{4}-\d{2}-\d{2})$/.exec(claim))) return `${m[1]} was last pushed on ${longDate(m[2]!)}.`;
  if ((m = /^(.+) has ([\d,]+) App Store ratings$/.exec(claim))) return `${m[2]} App Store ratings for ${m[1]}.`;
  if ((m = /^(\d+) App Store releases? in the last 90 days$/.exec(claim))) return `${m[1]} App Store release${m[1] === "1" ? "" : "s"} in the last 90 days.`;
  return endStop(claim.charAt(0).toUpperCase() + claim.slice(1));
}

// --- who to talk to --------------------------------------------------------------------

// people writes `top contributor to ${repo}: ${display}, ${n} commits`, display being
// `Name (@login)` or `@login`. The profile-facts claim that follows it is in the full brief.
function people(evidence: Evidence[]): Person[] {
  const out: Person[] = [];
  for (const e of evidence) {
    if (e.agent !== "people") continue;
    const m = /^top contributor to (\S+): (.+?), (\d+) commits?$/.exec(e.claim);
    if (!m) continue;
    const name = m[2]!.replace(/\s*\(@[^)]+\)\s*$/, "").trim();
    out.push({ name, detail: `${m[3]} commit${m[3] === "1" ? "" : "s"} to ${m[1]}`, url: e.url, claim: e.claim });
  }
  if (out.length > 1) out[0]!.detail += " — more than anyone else";
  return out;
}

// --- the opener --------------------------------------------------------------------------

/** The "## Suggested opener" section of a brief, as runs of text each carrying its receipt. */
export function parseOpener(md: string): Cited[] {
  const m = /^## Suggested opener[ \t]*\n([\s\S]*?)(?=\n## |\n*$)/m.exec(md);
  if (!m) return [];
  const text = m[1]!
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith(">"))
    .join(" ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return segmentCites(text);
}

/** Splits `fact ([source](url)) more ([source](url2)). tail` into cited runs. */
export function segmentCites(text: string): Cited[] {
  const out: Cited[] = [];
  const re = /\s*\(\[source\]\((https?:[^)\s]+)\)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const run = text.slice(last, m.index);
    if (run.trim()) out.push({ text: run, url: m[1]! });
    else if (out.length > 0) out[out.length - 1]!.url ??= m[1]!;
    last = re.lastIndex;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ text: tail });
  return out;
}

// --- small words for the overview --------------------------------------------------------

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** 0..12 as a word, else digits — for sentences, not tables. */
export function countWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n]! : String(n);
}

/** "2 in 3" — the share you kept, as people say it. "—" with no decisions. */
export function keptRatio(kept: number, total: number): string {
  if (total <= 0) return "—";
  if (kept === total) return total === 1 ? "1 of 1" : "all";
  if (kept === 0) return "none";
  const g = gcd(kept, total);
  return `${kept / g} in ${total / g}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// --- internals -------------------------------------------------------------------------

// Same fact, two refs: discover's code-search hit cites a blob/<sha>/ path while qualify's
// cites blob/main/. One claim string covers both, so the claim alone is the key.
function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    if (!e?.claim) return false;
    const key = `${e.agent}|${e.claim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function endStop(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shortDate(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  return `${MONTHS[(mo ?? 1) - 1]} ${d}, ${y}`;
}

function longDate(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  return `${MONTHS_LONG[(mo ?? 1) - 1]} ${d}, ${y}`;
}
