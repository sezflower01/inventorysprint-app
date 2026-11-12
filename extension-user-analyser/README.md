# InventorySprint — User Analyser (0.1.0, test build)

A **separate, self-contained** Chrome extension. It does not share a single
file with `extension/` or `extension-create/`, and nothing outside this folder
was changed to add it.

It reads the Amazon product page you already have open and shows what that page
says, each field labelled with where it came from. It makes **no Amazon API
call** and uses **no seller credentials** — which is the whole point: the
existing analyser falls back to the account owner's Amazon account when a user
has no SP-API connection, and this build cannot do that even by accident.

## Install for testing (no store needed)

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → choose this folder
3. Open any `https://www.amazon.com/dp/...` page — the panel appears bottom-right
4. Sign in: open <https://inventorysprint.com> and sign in there. The panel
   picks the session up automatically; there is no password field here.

**Test the isolation properly:** use a second Chrome profile signed in as a
user with **no** Amazon connection, and confirm nothing from the owner's
account appears. The lint proves it statically; the second profile proves it
end to end.

## Commands

```bash
npm install     # jsdom, for the parser tests — this folder only
npm test        # node --test over __tests__/
npm run build   # writes inventorysprint-user-analyser-0.1.0.zip
```

`npm run build` here is **not** part of the repo's root `npm run build`. That
one has a hardcoded target list for the two shipped extensions and writes into
`public/`, where the app's "Download .zip" buttons point — so wiring this in
would publish a test build on the app's download page. Left manual on purpose.

## What it shows

ASIN · Title · Price · Buy Box seller · Sellers · BSR · Availability ·
Variation parent · Book — each with the label **"read from this page"**.

**"Can I sell this?" says "Not checked in this version"** and links to your own
Seller Central. No verdict, no colour. Gating is per seller account and a
buyer-facing page does not show it, so a "no restriction found" here would be
permanent and would read as "yes you can" — the same false reassurance the old
panel produced from the owner's restrictions.

Any field whose selectors miss says **"not found"**. There is no fallback that
ends in a default and no inference from a neighbouring field.

## Two things to know before trusting it

**1. The fixtures are synthetic.** `__tests__/fixtures/` is hand-written HTML,
not captured Amazon pages. It proves the parser's logic; it does not prove the
parser survives Amazon's real markup, which is malformed in places, has many
A/B variants and changes without notice. See `__tests__/fixtures/README.md` for
how to check against real captures.

**2. There was no selector library to inherit.** Verified 2026-11-12: neither
shipped extension scrapes anything but the ASIN — every other number in the old
panel comes from the backend. So this whole layer is new code with no
production mileage. Expect selector drift and keep the fixtures current.

## Why `inventorysprint.com` is not in `host_permissions`

It is a `content_scripts` match (for `handoff.js`) but not a host permission,
because MV3 grants statically declared content scripts through their `matches`
and host permissions are only needed for fetches from extension contexts — and
this extension never fetches that host. That keeps `host_permissions` to the
two entries you asked for: amazon.com and Supabase. If Chrome's install prompt
suggests otherwise when you load it unpacked, adding the host back is a
one-line change in `manifest.json`.

## The lint is the real safety net

`__tests__/noOwnerFallback.test.js` fails if any shipped file:

- names `fetch-listing-snapshot`, `asin-dimensions` or
  `check-fba-listing-eligibility` (the three that fall back to the owner's
  Amazon token)
- names an SP-API credential or `seller_authorizations`
- fetches any host other than Supabase
- mentions Keepa (held back to 0.2.0 deliberately — removing it is an explicit
  edit to that test, not a drift)
- reads a cookie or an Amazon auth header
- widens `permissions` / `host_permissions`, or adds
  `web_accessible_resources`

## Before the store

- Developer registration is a one-time fee and takes a little setting up.
- Submit as **Unlisted** or to **trusted testers** first.
- A panel that mostly restates the page it is on can attract Chrome's
  "minimal functionality" rejection. Saving to your own account is the
  functional claim to lead with in the listing.
- `PRIVACY.md` is written to be checked against the code; reviewers ask why
  each permission exists and every one is justified there.

## Not in this version

Keepa (0.2.0), fee and ROI estimates, gating verdicts, marketplaces other than
`amazon.com`.
