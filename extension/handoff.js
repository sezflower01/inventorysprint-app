// Runs on inventorysprint.com. Bridges postMessage events from the web app
// (page-context) into the extension service worker.
//
// Two events are accepted:
//   ARBIPRO_EXT_SESSION → log in / refresh the session
//   ARBIPRO_EXT_LOGOUT  → user explicitly signed out of the web app
//
// LOGOUT is the only signal that should clear the extension's session.
// Slow auth, 504s, and transient network errors must NOT trigger logout
// (handled in background.js).
//
// ── ORIGIN CHECK, ADDED 2026-11-12 ────────────────────────────────────────
//
// This file used to check only `event.source !== window`. That is not nothing:
// both emitters (src/contexts/AuthContext.tsx:56 and
// src/pages/tools/ExtHandoff.tsx:43) pass `window.location.origin` as the
// targetOrigin, so the browser itself refuses to deliver the message to a
// different origin. What it does NOT stop is a script running ON our own page
// -- an injected third-party tag, or an XSS -- posting a forged
// ARBIPRO_EXT_SESSION. The worker would store those tokens and act as that
// user. Cheap to close, so it is closed.
//
// The check is scoped to what the manifest already allows this script to run
// on ("https://inventorysprint.com/*" and "https://*.inventorysprint.com/*"),
// NOT to the single origin the app happens to use today, so moving the app to
// a subdomain cannot silently break sign-in.
//
// hostname.endsWith('.inventorysprint.com') is deliberate and the leading dot
// is load-bearing: without it the test also accepts
// "evil-inventorysprint.com". The equivalent regex /inventorysprint\.com$/ has
// the same hole. Comparing a parsed URL's hostname, rather than matching the
// origin string, also means a credentials-in-the-URL or port trick cannot slip
// past.
function isAllowedAppOrigin(origin) {
  try {
    const u = new URL(String(origin));
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "inventorysprint.com" || h.endsWith(".inventorysprint.com");
  } catch (_) {
    return false;
  }
}

// Safely send a message to the extension service worker. Guards against:
//  - extension reloads/updates where chrome.runtime is briefly invalidated
//  - chrome.runtime.lastError ("Extension context invalidated", "Receiving end
//    does not exist") that otherwise surfaces as an unhandled error in the page
function safeSend(msg, onAck) {
  try {
    if (!chrome?.runtime?.id) return;
    chrome.runtime.sendMessage(msg, () => {
      // Swallow lastError so it doesn't bubble as "Unchecked runtime.lastError".
      const err = chrome.runtime?.lastError;
      if (err) {
        try { console.debug("[InvSPRNT-auth] sendMessage ignored:", err.message); } catch (_) {}
        return;
      }
      try { onAck && onAck(); } catch (_) {}
    });
  } catch (e) {
    try { console.debug("[InvSPRNT-auth] sendMessage threw (ignored):", e?.message); } catch (_) {}
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isAllowedAppOrigin(event.origin)) return;
  const data = event.data;
  if (!data) return;

  if (data.type === "ARBIPRO_EXT_SESSION") {
    const s = data.session;
    if (!s?.access_token || !s?.refresh_token) return;
    safeSend(
      { type: "INVSPRNT_SET_SESSION", session: s },
      () => window.postMessage({ type: "ARBIPRO_EXT_SESSION_ACK" }, event.origin),
    );
    return;
  }

  if (data.type === "ARBIPRO_EXT_LOGOUT") {
    try { console.log("[InvSPRNT-auth]", "extension_logout_signal_received"); } catch (_) {}
    safeSend(
      { type: "INVSPRNT_EXPLICIT_SIGN_OUT" },
      () => window.postMessage({ type: "ARBIPRO_EXT_LOGOUT_ACK" }, event.origin),
    );
  }
});
