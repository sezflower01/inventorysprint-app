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
// ── Why every send is guarded (2026-09-18) ────────────────────────────────
// Updating or reloading the extension leaves THIS script running in every
// inventorysprint.com tab that was already open, cut off from the new
// extension. The web app re-sends ARBIPRO_EXT_SESSION on every token refresh,
// so an unguarded sendMessage threw on each one:
//   "Uncaught Error: Extension context invalidated."
//   "Uncaught TypeError: Cannot read properties of undefined (reading
//    'sendMessage')"  -- once Chrome removes chrome.runtime entirely.
// The analyser's copy of this file was already guarded; this one never was.
// background.js now also re-injects this script into open tabs on update,
// so the live copy takes over; the stale one below just stops sending.

// Function scope: a second injection into the same page context must not
// throw on redeclared top-level bindings.
(() => {
  let contextGone = false;

  // Safely send a message to the extension service worker. Guards against:
  //  - extension reloads/updates where chrome.runtime is invalidated or removed
  //  - chrome.runtime.lastError ("Extension context invalidated", "Receiving end
  //    does not exist") that otherwise surfaces as an unhandled error in the page
  function safeSend(msg, onAck) {
    if (contextGone) return;
    try {
      if (!chrome?.runtime?.id) { contextGone = true; return; }
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
      if (/context invalidated/i.test(String(e?.message || e))) contextGone = true;
      try { console.debug("[InvSPRNT-auth] sendMessage threw (ignored):", e?.message); } catch (_) {}
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.type === "ARBIPRO_EXT_SESSION") {
      const s = data.session;
      if (!s?.access_token || !s?.refresh_token) return;
      safeSend(
        { type: "INVSPRNT_SET_SESSION", session: s },
        () => window.postMessage({ type: "ARBIPRO_EXT_SESSION_ACK" }, "*"),
      );
      return;
    }

    if (data.type === "ARBIPRO_EXT_LOGOUT") {
      try { console.log("[InvSPRNT-auth]", "extension_logout_signal_received"); } catch (_) {}
      safeSend(
        { type: "INVSPRNT_EXPLICIT_SIGN_OUT" },
        () => window.postMessage({ type: "ARBIPRO_EXT_LOGOUT_ACK" }, "*"),
      );
    }
  });
})();
