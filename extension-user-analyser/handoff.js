// Runs on inventorysprint.com only. Bridges the web app's sign-in session into
// this extension's service worker, so the extension NEVER sees a password.
//
// ── THE EXACT CONTRACT ────────────────────────────────────────────────────
//
// src/contexts/AuthContext.tsx:56 broadcasts this on every page once the user
// is signed in and email-verified (src/pages/tools/ExtHandoff.tsx:43 sends the
// identical shape from the dedicated handoff page):
//
//   window.postMessage(
//     { type: 'ARBIPRO_EXT_SESSION',
//       session: { access_token, refresh_token, expires_at } },
//     window.location.origin,
//   );
//
// and AuthContext.tsx:308 broadcasts { type: 'ARBIPRO_EXT_LOGOUT' }, also with
// window.location.origin as the targetOrigin.
//
// ── WHY THIS FILE CHECKS event.origin AND extension/handoff.js DOES NOT ───
//
// The shipped extension checks only `event.source !== window`. The emitter's
// targetOrigin already stops delivery to a different origin, so that is safe
// against a cross-origin sender. What it does NOT stop is a script running ON
// our own page -- an injected third-party tag, or an XSS -- posting a forged
// ARBIPRO_EXT_SESSION with attacker-chosen tokens, which the extension would
// then store and use as the signed-in user. Cheap to close, so this build
// closes it: the origin must be on the allowlist below, by exact string match.
//
// Note there is no wildcard. "https://inventorysprint.com" and
// "https://www.inventorysprint.com" are listed explicitly rather than matched
// by a /\.inventorysprint\.com$/ regex, because that regex also accepts
// "evil-inventorysprint.com" (note: no dot before "inventorysprint") unless
// the dot is escaped and anchored --
// a classic near-miss. An exact-match Set cannot have that bug.
const ALLOWED_ORIGINS = new Set([
  'https://inventorysprint.com',
  'https://www.inventorysprint.com',
]);

function safeSend(msg, onAck) {
  try {
    if (!chrome?.runtime?.id) return;
    chrome.runtime.sendMessage(msg, () => {
      // Swallow lastError so it does not surface in the page as an unchecked
      // runtime error during an extension reload.
      const err = chrome.runtime?.lastError;
      if (err) return;
      try { onAck && onAck(); } catch (_) { /* ignore */ }
    });
  } catch (_) { /* extension context invalidated mid-reload */ }
}

window.addEventListener('message', (event) => {
  // 1. Same window only -- rejects iframes and other frames on the page.
  if (event.source !== window) return;
  // 2. Exact origin match -- rejects anything not served from our own site.
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'ARBIPRO_EXT_SESSION') {
    const s = data.session;
    // Both tokens or nothing. A half-session would leave the worker unable to
    // refresh and looking signed in.
    if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return;
    if (!s.access_token || !s.refresh_token) return;
    safeSend(
      { type: 'ISUA_SET_SESSION', session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at } },
      // Ack back to the page on its own origin, never "*", so the token-bearing
      // conversation is not observable by another frame.
      () => window.postMessage({ type: 'ARBIPRO_EXT_SESSION_ACK' }, event.origin),
    );
    return;
  }

  if (data.type === 'ARBIPRO_EXT_LOGOUT') {
    // Explicit sign-out is the ONLY thing that clears the session. Slow auth,
    // 504s and offline must never clear it -- that lesson is already recorded
    // in extension/handoff.js and it applies identically here.
    safeSend(
      { type: 'ISUA_SIGN_OUT' },
      () => window.postMessage({ type: 'ARBIPRO_EXT_LOGOUT_ACK' }, event.origin),
    );
  }
});
