// Naming helpers shared by the discovery units that read company names out of text a
// company wrote about itself (a job post, a profile field). Conservative by construction:
// anything that does not look like a name is refused, and a refusal drops the lead — an
// unparsed post costs one lead, a misparsed one puts a wrong name on a receipt.

const MAX_NAME_CHARS = 48;
const MAX_NAME_WORDS = 6;
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .,'’&!/+()-]*$/;
const YC_BATCH = /\s*\((?:YC\s*[SWFX]?\d{2})\)\s*$/i;

// Applicant-tracking and social hosts are shared by thousands of companies: keying an
// account on one would fuse unrelated companies into a single record. When a post's
// only link is one of these, the account is keyed by the company name instead.
export const SHARED_HOSTS = [
  "greenhouse.io",
  "grnh.se",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "breezy.hr",
  "recruitee.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "workday.com",
  "myworkdayjobs.com",
  "jobvite.com",
  "notion.so",
  "notion.site",
  "docs.google.com",
  "airtable.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "github.com",
  "gitlab.com",
  "ycombinator.com",
  "wellfound.com",
  "angel.co",
  "indeed.com",
  "remotive.com",
  "remotive.io",
  "remoteok.com",
  "arbeitnow.com",
  "glassdoor.com",
  "calendly.com",
  "typeform.com",
  "loom.com",
  "youtube.com",
  "youtu.be",
  "bit.ly",
  "lnkd.in",
  "t.co",
  "forms.gle",
  "hubs.ly",
  "hubs.la",
  "tinyurl.com",
  "rb.gy",
];

/** The stack terms a post can name. Expo and EAS are production evidence; React Native is hiring evidence. */
export const STACK = /\b(expo|eas|react[\s-]?native)\b/i;

/** Which of Expo, EAS, React Native a text names, in that order, deduplicated. */
export function stackTerms(text: string): string[] {
  const out: string[] = [];
  if (/\bexpo\b/i.test(text)) out.push("Expo");
  if (/\beas\b/i.test(text)) out.push("EAS");
  if (/\breact[\s-]?native\b/i.test(text)) out.push("React Native");
  return out;
}

export function companyName(field: string): string | null {
  const name = field.replace(YC_BATCH, "").replace(/^["'*`@\s]+|["'*`\s]+$/g, "").trim();
  if (!name || name.length > MAX_NAME_CHARS) return null;
  if (!/[A-Za-z]/.test(name)) return null;
  if (/^https?:/i.test(name)) return null;
  if (!NAME_SHAPE.test(name)) return null;
  if (name.split(/\s+/).length > MAX_NAME_WORDS) return null;
  return name;
}

/** First linked host in the text that is not a shared job/social host — the company's own site, usually. */
export function domainFrom(text: string): string | undefined {
  for (const raw of text.match(/https?:\/\/[^\s<>()[\],"']+/g) ?? []) {
    const host = hostOf(raw);
    if (!host || !host.includes(".")) continue;
    if (isSharedHost(host)) continue;
    return host;
  }
  return undefined;
}

export function isSharedHost(host: string): boolean {
  return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`));
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const LEGAL_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sas|sa|bv|ab|oy|pty|plc|srl)\b\.?/gi;

/** "Northwind Health Inc." → "Northwind Health". */
export function withoutLegalSuffix(name: string): string {
  return name.replace(/[,.]/g, " ").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/** Company names as equals: lower-cased, legal suffixes and punctuation gone. */
export function normalizeCompany(name: string | null | undefined): string {
  return withoutLegalSuffix(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

const MAX_QUOTE_CHARS = 160;
export function quote(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_QUOTE_CHARS ? `${one.slice(0, MAX_QUOTE_CHARS - 1)}…` : one;
}
