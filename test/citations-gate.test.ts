import assert from "node:assert/strict";
import { test } from "node:test";
import { validateModelBrief } from "../src/agents/brief.js";
import type { Account } from "../src/types.js";

const account: Account = {
  org: "acme", stage: "qualified", updated: "2026-08-20T12:00:00.000Z",
  evidence: [
    { claim: "a", url: "https://github.com/acme/app/blob/main/eas.json", agent: "qualify", date: "2026-08-20" },
    { claim: "b", url: "https://github.com/acme", agent: "resolve", date: "2026-08-20" },
    { claim: "c", url: "https://acme.com/", agent: "enrich", date: "2026-08-20" },
  ],
};

const body = (opener: string) => `# Acme — account brief

## Who
Acme builds things ([source](https://acme.com/)). Its org is on GitHub ([source](https://github.com/acme)).

## Production Expo signals
- eas.json in acme/app ([source](https://github.com/acme/app/blob/main/eas.json)).

## Who to talk to
No evidence yet.

## Suggested opener
${opener}
`;

test("citations gate: an absence sentence may stand without a receipt; a claim may not; a URL outside the evidence never", () => {
  assert.equal(validateModelBrief(body("You ship through EAS ([source](https://github.com/acme/app/blob/main/eas.json)). The evidence does not list a named engineer, so this is addressed to whoever owns the build. Who owns it? ([source](https://github.com/acme))"), account), null);
  assert.equal(validateModelBrief(body("Ships through EAS ([source](https://github.com/acme/app/blob/main/eas.json)).\nThe evidence does not give a title for anyone there.\n- The evidence contains no React Native version, no CI configuration, and no repository activity."), account), null);
  assert.match(validateModelBrief(body("Ships through EAS ([source](https://github.com/acme/app/blob/main/eas.json)).\nAddressed to Maintainer One (Staff persona)."), account) ?? "", /lacks an evidence receipt/);
  assert.match(validateModelBrief(body("The evidence does not say ([source](https://evil.example.com/x))."), account) ?? "", /uncited URL/);
  assert.match(validateModelBrief(body("Great company ([source](https://evil.example.com/x))."), account) ?? "", /uncited URL/);
});
