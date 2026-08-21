# Receipt drawer — build contract

## The problem
Every brief sentence carries a receipt. Clicking them opens a new tab each time: death by
a million tabs. Receipts are meant to be *checked in passing*, not navigated to.

## The fix
Clicking a receipt opens a **right-hand drawer** with the source previewed in place. The
page stays behind a dimmed scrim; Esc, scrim-click, or Close returns you exactly where you
were. Modeled on the sidebar-note system from ravenhoward.org (same interaction, legwork's
palette).

## Interaction (lifted from ravenhoward.org, keep it exact)
- Drawer: fixed right, `width:min(470px,94vw)`, full height, `border-left:1px solid var(--line)`,
  `transform:translateX(103%)` when closed, slides in on `.on`.
- **The box-shadow exists only while open** — a closed drawer's shadow bleeds a pale band
  down the viewport's right edge. This bug was found and fixed once already; do not
  reintroduce it.
- Scrim: `position:fixed;inset:0`, tinted from `--text` at ~26%, fades in, click closes.
- Close on: Esc, scrim click, and an explicit Close control. Focus returns to the receipt
  that opened it.
- Mobile (`max-width:700px`): full-width sheet, no left border, a 40×4px rounded "notch"
  at the top, and a visible ✕.
- Motion: calm easing, ~.45–.55s. No bounce, no spring overshoot on the drawer itself.
- Link convention: **dashed underline = opens in the drawer** (stays here), solid = leaves
  the page. Apply consistently — that convention is the whole affordance.

## Content of the drawer
Header: a small uppercase pill (the "kind": `github file`, `github repo`, `github profile`,
`app store`, `homepage`, `issue`, `hn`), then the claim text as the title.

Meta row: which unit produced it (`discover`, `qualify`, `people`…), the date, and the
account it belongs to. These come from the `Evidence` record — do not invent fields.

Body: **the preview**, then the full URL as monospace text, then `Open in new tab ↗`
(the only thing that leaves the page).

## Preview strategy — the actual engineering
Most sources cannot be iframed (GitHub sends `X-Frame-Options: DENY`). So fetch and render
text, never embed a frame.

**Served mode (`legwork serve`)** — the reliable path. Add to the server:
`GET /api/receipt?url=<encoded>` → `{ ok, kind, title?, text?, meta?, error? }`.
Server-side fetch has no CORS limits. Rules:
- Only fetch `https:` URLs whose host is in an allowlist: `github.com`,
  `raw.githubusercontent.com`, `api.github.com`, `apps.apple.com`, `play.google.com`,
  `news.ycombinator.com`, plus the account's own domain. Anything else → `{ok:false}` and
  the drawer shows metadata only. **This allowlist is a security boundary, not a
  convenience** — the server must never become an open proxy.
- GitHub blob URL → convert to `raw.githubusercontent.com` and return the file text,
  truncated to 200 lines / 20KB, with a note when truncated. `eas.json` and `package.json`
  are the common cases and are exactly what a reviewer wants to see.
- GitHub tree/org/repo URL → `api.github.com` for description, language, pushed_at,
  and (for a directory) the file list.
- GitHub user URL → `api.github.com/users/<login>` for name, company, bio, location.
- App Store URL → iTunes Lookup API by the numeric id (already used by `appstore.ts`):
  rating count, current version, last release date.
- Anything else (homepage, HN) → fetch the HTML, return `<title>` + meta description only.
  Never dump raw HTML into the drawer.
- 6s timeout, cache responses in-process for the session, and cap concurrent fetches.

**Static mode (GitHub Pages copy)** — no server. Degrade honestly:
- Try `raw.githubusercontent.com` directly for GitHub blob URLs (it sends
  `Access-Control-Allow-Origin: *`, so this works from a static page) and
  `api.github.com` for repo/user (unauthenticated, 60/hr — handle 403 gracefully).
- For everything else, show the claim, the unit, the date, the URL, and the
  `Open in new tab ↗` button, with one quiet line: `preview unavailable in the static
  console — run legwork serve for inline previews`.
- Never let a failed fetch look like a broken page: a caught error renders as that same
  metadata-only view.

## Where it applies
Every receipt link the console renders: review-queue cards, published briefs, retirement
memos, and the score-math table's `receipt` links. One shared implementation.

## Visual polish to pull across (from ravenhoward.org)
- Generous body line-height (~1.7) and a `max-width:60ch` measure inside the drawer.
- The small uppercase pill chips (letter-spaced, tinted background, 1px tinted border).
- Calm transitions everywhere; nothing snaps.
- Keep legwork's existing expo.dev palette and tokens — adopt the *shapes and motion*,
  not the green/serif garden theme. Inter for text, mono for URLs, code, and numbers.

## Definition of done
`npx tsc --noEmit` clean · receipts in served mode open the drawer with a real preview for
a GitHub file, a repo, a person, and an App Store listing · static mode still generates and
degrades to metadata-only without console errors · Esc / scrim / Close all work and restore
focus · no closed-drawer shadow bleed · mobile sheet behaves · the static Pages output still
makes zero network calls on load.
