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
