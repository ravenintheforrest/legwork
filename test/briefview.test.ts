import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBriefView, countWord, keptRatio, parseOpener, segmentCites, sentence, verdictFor } from "../src/briefview.js";
import type { Account } from "../src/types.js";

const date = "2026-08-20T12:00:00.000Z";
const evidence = (agent: string, claim: string, url: string) => ({ agent, claim, url, date });

const account: Account = {
  org: "beatgig",
  company: "BeatGig",
  domain: "beatgig.com",
  stage: "briefed",
  segment: "A",
  confidence: 0.6,
  location: "New York, NY",
  mode: "fixture",
  updated: date,
  evidence: [
    evidence("discover", "eas.json in beatgig/beatgig-mobile", "https://github.com/beatgig/beatgig-mobile/blob/abc/eas.json"),
    evidence("resolve", "GitHub org profile: BeatGig — beatgig.com", "https://github.com/beatgig"),
    evidence("enrich", 'BeatGig homepage: "BeatGig | Book Live Music — BeatGig is a live music booking platform connecting artists with venues"', "https://beatgig.com/"),
    evidence("qualify", "eas.json in beatgig/beatgig-mobile", "https://github.com/beatgig/beatgig-mobile/blob/main/eas.json"),
    evidence("qualify", "react-native ~0.73.6 in beatgig/beatgig-mobile/package.json", "https://github.com/beatgig/beatgig-mobile/blob/main/package.json"),
    evidence("qualify", "6 public repos and 22 followers on github.com/beatgig", "https://github.com/beatgig"),
    evidence("qualify", "beatgig/beatgig-mobile last pushed 2026-06-30", "https://github.com/beatgig/beatgig-mobile"),
    evidence("qualify", "BeatGig has 1,800 App Store ratings", "https://apps.apple.com/us/app/beatgig/id1"),
    evidence("qualify", "2 App Store releases in the last 90 days", "https://apps.apple.com/us/app/beatgig/id1"),
    evidence("people", "top contributor to beatgig/beatgig-mobile: Maintainer One (@m1), 88 commits", "https://github.com/m1"),
    evidence("people", "Maintainer One's GitHub profile lists company 'BeatGig'", "https://github.com/m1"),
    evidence("people", "top contributor to beatgig/beatgig-mobile: @m2, 19 commits", "https://github.com/m2"),
  ],
  qualification: {
    score: 0.6,
    threshold: 0.55,
    qualified: true,
    action: "brief",
    signals: [
      { name: "eas_json_present", value: 1, weight: 0.2, contribution: 0.2, evidence_url: "https://github.com/beatgig/beatgig-mobile/blob/main/eas.json" },
      { name: "ci_config", value: 0, weight: 0.1, contribution: 0 },
      { name: "store_review_volume", value: 0.5, weight: 0.1, contribution: 0.05, evidence_url: "https://apps.apple.com/us/app/beatgig/id1" },
      { name: "some_new_signal", value: 0, weight: 0.1, contribution: 0 },
    ],
    assumptions: [],
    fallback: "",
  },
  review: { status: "queued", date },
};

const brief = `# BeatGig — account brief

## Who
Something ([source](https://beatgig.com/)).

## Suggested opener
Maintainer One, you have 88 commits on beatgig-mobile ([source](https://github.com/m1)). The repo has an \`eas.json\` ([source](https://github.com/beatgig/beatgig-mobile/blob/main/eas.json)). What did the path from commit to build look like?
`;

test("briefview: the card reads as a person would, from evidence alone", () => {
  const v = buildBriefView(account, { gate: 0.8, brief });
  assert.equal(v.company, "BeatGig");
  assert.equal(v.initial, "B");
  assert.equal(v.sample, true);
  assert.deepEqual(v.location, { text: "New York, NY", url: "https://github.com/beatgig", claim: "GitHub org profile: BeatGig — beatgig.com" });

  // numbers: store traction first, capped at four, each carrying its receipt
  assert.deepEqual(
    v.stats.map((s) => [s.value, s.label]),
    [["1,800", "App Store ratings"], ["2", "releases in 90 days"], ["0.73.6", "React Native"], ["6", "public repos"]],
  );
  assert.ok(v.stats.every((s) => s.url.startsWith("https://")));

  // who they are: the description after the em dash, not the page title
  assert.equal(v.about?.text, "BeatGig is a live music booking platform connecting artists with venues.");
  assert.equal(v.about?.url, "https://beatgig.com/");

  // what we found: qualify first, our own templates read back as sentences, discover's duplicate collapsed
  assert.equal(v.found[0]?.text, "An eas.json in beatgig/beatgig-mobile — they build through EAS today, not just React Native.");
  assert.equal(v.found.filter((f) => f.text.startsWith("An eas.json")).length, 1);
  assert.ok(v.found.some((f) => f.text === "React Native 0.73.6 in beatgig/beatgig-mobile."));
  assert.ok(v.found.some((f) => f.text === "beatgig/beatgig-mobile was last pushed on June 30, 2026."));

  // who to talk to: name without the handle, commits, the top one called out
  assert.deepEqual(
    v.people.map((p) => [p.name, p.detail]),
    [["Maintainer One", "88 commits to beatgig/beatgig-mobile — more than anyone else"], ["@m2", "19 commits to beatgig/beatgig-mobile"]],
  );

  // the opener, as cited runs; backticks stripped
  assert.equal(v.opener.length, 3);
  assert.equal(v.opener[0]?.url, "https://github.com/m1");
  assert.ok(v.opener[1]?.text.includes("eas.json") && !v.opener[1]?.text.includes("`"));
  assert.equal(v.opener[2]?.url, undefined);

  // verdict in words, have / couldn't find, unknown signal humanized
  assert.equal(v.verdict.word, "Worth a look");
  assert.equal(v.verdict.pct, 60);
  assert.deepEqual(v.have.map((i) => i.label), ["Builds with EAS", "Real app-store presence"]);
  assert.deepEqual(v.missing.map((i) => i.label), ["Automated builds in CI", "Some new signal"]);
});

test("briefview: verdict bands follow what the pipeline does with a score", () => {
  assert.equal(verdictFor(0.85, 0.55, 0.8).word, "Ready to send");
  assert.equal(verdictFor(0.6, 0.55, 0.8).word, "Worth a look");
  assert.equal(verdictFor(0.4, 0.55, 0.8).word, "Thin");
  assert.equal(verdictFor(0.4, 0.55, 0.8).tone, "warn");
  assert.equal(verdictFor(1.4, 0.55, 0.8).pct, 100);
});

test("briefview: an account with no evidence and no brief still renders honestly", () => {
  const bare: Account = { org: "x", stage: "discovered", evidence: [], updated: date };
  const v = buildBriefView(bare, { gate: 0.8 });
  assert.equal(v.company, "x");
  assert.equal(v.location, null);
  assert.deepEqual(v.stats, []);
  assert.equal(v.about, null);
  assert.deepEqual(v.opener, []);
  assert.equal(v.verdict.word, "Not scored yet");
  assert.equal(v.verdict.pct, 0);
});

test("briefview: claim templates and the small words", () => {
  assert.equal(sentence("CI workflows in a/b"), "CI workflows in a/b — builds are automated.");
  assert.equal(sentence("1 App Store release in the last 90 days"), "1 App Store release in the last 90 days.");
  assert.equal(sentence("something the template does not know"), "Something the template does not know.");
  assert.equal(sentence("already stopped."), "Already stopped.");

  assert.deepEqual(segmentCites("a ([source](https://x/1)) b"), [{ text: "a", url: "https://x/1" }, { text: " b" }]);
  assert.deepEqual(parseOpener("# t\n\n## Who\nx\n"), []);

  assert.equal(countWord(2), "Two");
  assert.equal(countWord(40), "40");
  assert.equal(keptRatio(2, 3), "2 in 3");
  assert.equal(keptRatio(4, 6), "2 in 3");
  assert.equal(keptRatio(0, 0), "—");
  assert.equal(keptRatio(3, 3), "all");
  assert.equal(keptRatio(0, 5), "none");
});
