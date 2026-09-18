# InventorySprint — Amazon Analyzer Chrome Extension

A local Manifest V3 Chrome extension that auto-detects the ASIN on any Amazon
product page and shows InventorySprint scanner data (Buy Box, FBA/FBM lowest,
Keepa 90-day stability, Amazon presence %, BSR, est. monthly sales,
eligibility, fees, ROI/profit, and Decision Signal) — same logic as the
mobile UPC scanner.

## How it works

```
Amazon PDP → content.js (detects ASIN + marketplace)
           → panel.html (iframe UI)
           → background.js (auth + token refresh)
           → Supabase Edge Functions:
               fetch-listing-snapshot
               check-product-eligibility
               mobile-scan-price-stability
               mobile-scan-price-history
```

No Keepa/AWS/service-role keys ever ship with the extension. Only the public
Supabase anon key + the user's own session JWT are used.

## Install (local, "Load unpacked")

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this `extension/` folder
5. Open any Amazon product page (e.g. `https://www.amazon.com/dp/B07ZPKBL9V`)
6. The floating panel appears top-right

## Sign in

The first time you open the panel, click **Open sign-in**. It opens
`https://inventorysprint.com/tools/ext-handoff?ext=1`. After login, the web app must
post the session to the extension:

```js
window.postMessage({
  type: 'ARBIPRO_EXT_SESSION',
  session: { access_token, refresh_token, expires_at }
}, '*');
```

`handoff.js` (registered as a content script on `inventorysprint.com`)
catches that message and stores the session in `chrome.storage.local`.

> **Action item for the web app side**: add a small `/ext-handoff` route
> (or hook it into the existing `/login` page when `?ext=1` is present)
> that fires the postMessage above after Supabase auth succeeds.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, host permissions, content scripts |
| `background.js` | Service worker — session storage, token refresh, EF proxy |
| `content.js` | Runs on Amazon pages — detects ASIN + mounts iframe |
| `handoff.js` | Runs on inventorysprint.com — captures session postMessage |
| `panel.html/js/css` | Floating SellerAmp-style panel UI |
| `decisionSignal.js` | Mirrors `computeDecisionSignal()` from the web app |
| `popup.html/js` | Toolbar popup — sign in / out |
| `config.js` | Public anon key + Supabase URL (safe) |
| `icons/` | 16/48/128 toolbar icons |

## Marketplaces supported

US, CA, MX, BR, GB, DE, FR, IT, ES, JP. Detected from hostname.

## Dev tips

- Reload extension after edits: `chrome://extensions` → click ↻ on the card.
- Inspect the panel iframe: right-click inside the panel → **Inspect**.
- Inspect the service worker: extension card → **service worker** link.
- Per-ASIN cache lives 10 min in `chrome.storage.local` (`cache:US:B0...`).
- Per-ASIN cost inputs persist under (`cost:B0...`).

## Security notes

- Never put `KEEPA_API_KEY`, `AWS_*`, or `SUPABASE_SERVICE_ROLE_KEY` here.
- All Keepa + SP-API access stays server-side in the existing edge functions.
- The extension only carries the Supabase publishable anon key and the
  end-user's own session JWT.
