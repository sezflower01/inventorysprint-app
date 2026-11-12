# Privacy — InventorySprint User Analyser 0.1.0

Written to be checkable against the code, not reassuring. Every claim below is
enforced by `__tests__/noOwnerFallback.test.js`, which fails the build if it
stops being true.

## What leaves your browser

Nothing, until you press **Save to my account**.

The panel reads the Amazon product page already open in your tab and renders
the result locally. No request is made to any server to produce it.

When you press Save, exactly these fields are sent to InventorySprint:

| Field | Source |
| --- | --- |
| ASIN | the page URL, or the page's ASIN field |
| Title | the page |
| Price (as text) | the page |
| Buy Box seller | the page |
| Seller count | the page |
| BSR | the page |
| Page URL | the address bar, query string removed |

They are stored against your own account and protected by row-level security:
no other user, including the InventorySprint account owner, can read your rows.

## What is never read or sent

- **Your Amazon sign-in.** No cookie, session token or auth header is read.
  The extension holds no `cookies` permission and cannot request one without a
  new install prompt. The lint fails on `chrome.cookies`, `document.cookie`,
  `x-amz-access-token` and `set-cookie` appearing anywhere in the code.
- **Your password.** There is no password field. You sign in on
  inventorysprint.com and the website hands this extension a session token.
- **Your Amazon seller credentials.** This version makes no Amazon API call of
  any kind.
- **Keepa.** Not present in this version at all; the lint fails if the word
  appears.

## Hosts this extension may contact

One: `mstibdszibcheodvnprm.supabase.co`, the InventorySprint backend.

`amazon.com` is listed in the manifest because the panel runs *on* those pages.
No request is ever made to Amazon. `inventorysprint.com` appears only as a
content-script match for the sign-in handover and as a link you can click — it
is deliberately **not** in `host_permissions`, because the extension never
fetches it.

## Permissions, and why each one exists

| Permission | Why |
| --- | --- |
| `storage` | keeps your session token so you are not signed out on every page |
| `activeTab` | lets the panel act on the tab you are looking at |
| `https://*.amazon.com/*` | the pages the panel is displayed on |
| `https://mstibdszibcheodvnprm.supabase.co/*` | saving a reading to your account |

There is no `<all_urls>`, no broad wildcard host, no `scripting`, no `cookies`,
no `webRequest`, and nothing is exposed to the page via
`web_accessible_resources`. The panel renders inside a **closed** shadow root,
so no website can read it or detect it.

## What this version does not tell you

**Whether you are allowed to sell a product.** Gating is per seller account,
and a buyer-facing product page does not show it. The panel says "Not checked
in this version" and links you to your own Seller Central. It shows no verdict
and no colour, because any colour would read as an answer.

**Fee or ROI estimates.** Not in this version.

## Deleting your data

Readings you saved are rows in your own account. Removing them removes them —
there is no separate copy.
