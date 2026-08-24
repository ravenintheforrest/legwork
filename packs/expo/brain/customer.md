# Who we sell to

The ideal account is an organization where a React Native app is a revenue-critical
surface, maintained by a JS-first team, shipping fast. Segments, with the tell that gives
each away in public (the weights and thresholds live in icp.yaml and qualify.ts):

- **A — mobile-first startup.** The app is the product; no native team by design.
  Example: Partiful. Tell: eas.json in a public repo, an active store listing, a small org.
- **B — app-as-channel mid-market / enterprise.** A web-strength company extending to mobile,
  often under compliance pressure. Example: Mollie. Tell: regulated category, a store app
  with real volume, hiring React Native.
- **C — JS-forward established org.** Many repos, older org, web teams who want the OTA
  speed. Example: MTA. Tell: old, large org with an RN app and slow release cadence.
- **D — agency / studio.** One org, many store developer accounts, build volume. Tell:
  client apps, many repos with eas.json.

## Pains we solve
- Maintaining Xcode / Gradle / CI pipelines instead of the product.
- Credentials, provisioning profiles, and store submission across 20+ engineers.
- Waiting on store review to ship a fix; no staged rollouts; no rollback.
- Two native codebases, or a web team that cannot reach mobile.
- Upgrades: stuck on an old SDK or React Native version, afraid to move.

## Buying triggers (what shows up in public)
- Hiring React Native / Expo engineers, especially with a salary band.
- A new or recently updated store app; frequent releases.
- An upgrade PR, an EAS issue filed by their engineer, an "expo upgrade" discussion.
- A careers page that names the stack; a conference talk about their mobile pipeline.

## Objections we hear
- "Lock-in" — answer with the open-source framework and that EAS is optional per feature.
- "We need a custom native module" — answer with config plugins and development builds.
- "Performance" — answer with the new architecture and named apps at scale.
- "We already have CI" — answer with what EAS does that CI does not: credentials, store
  submission, updates, rollbacks, and not owning the runners.

## How they decide
Engineering leadership decides on cost and risk (headcount not hired, pipeline not
maintained, compliance met); staff engineers decide on whether it feels like their stack.
A brief is read by an AE and then, ideally, by the engineer it names. It has to be true
for the engineer and useful for the AE.
