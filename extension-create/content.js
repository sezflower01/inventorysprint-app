// Detects ASIN + marketplace, mounts a draggable Create-Listing panel,
// supports collapse / close / reset / Alt+A — clone of analyzer extension
// but uses its own storage key + panel id so both extensions can coexist.
(function () {
  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?]|$)/;

  const HOST_TO_MARKET = [
    [/amazon\.com\.mx/, "MX"], [/amazon\.com\.br/, "BR"],
    [/amazon\.co\.uk/, "GB"], [/amazon\.co\.jp/, "JP"],
    [/amazon\.ca/, "CA"], [/amazon\.de/, "DE"], [/amazon\.fr/, "FR"],
    [/amazon\.it/, "IT"], [/amazon\.es/, "ES"], [/amazon\.com/, "US"],
  ];

  const DEFAULT_POS = { top: 96, right: 16, left: null };
  const SIZE = { width: 380, height: 720, collapsedHeight: 48 };
  const STORE_KEY = "arbipro_create_panel_state";

  const detectMarketplace = () => {
    for (const [re, code] of HOST_TO_MARKET) if (re.test(location.hostname)) return code;
    return "US";
  };
  const detectAsin = () => {
    const m = location.pathname.match(ASIN_RE);
    if (m) return m[1];
    const input = document.querySelector("input#ASIN, input[name='ASIN.0'], input[name='ASIN']");
    if (input?.value && /^[A-Z0-9]{10}$/.test(input.value)) return input.value;
    const v = document.querySelector("[data-asin]")?.getAttribute("data-asin");
    return v && /^[A-Z0-9]{10}$/.test(v) ? v : null;
  };

  // ── Surviving an extension update (2026-09-18) ─────────────────────────
  // Same scheme as the analyser's content.js. background.js re-injects this
  // script into open tabs on update; each copy stamps an instance id on
  // <html> and removes the previous copy's panel, launcher and drag overlay.
  // An older copy -- cut off (chrome.runtime gone) or superseded -- counts as
  // an invalid context and goes quiet through handleContextInvalidated().
  const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const INSTANCE_ATTR = "data-invsprnt-create";
  // Legacy "arbipro-create-*" ids too: tabs still running a pre-rename copy
  // (<= 1.5.2) carry those, and the copy injected on update must clear them.
  for (const id of [
    "invsprnt-create-panel-frame", "invsprnt-create-launcher", "invsprnt-create-drag-overlay",
    "arbipro-create-panel-frame", "arbipro-create-launcher", "arbipro-create-drag-overlay",
  ]) {
    document.getElementById(id)?.remove();
  }
  document.documentElement.setAttribute(INSTANCE_ATTR, INSTANCE);

  let panelState = { pos: { ...DEFAULT_POS }, collapsed: false, hidden: false };
  async function loadState() {
    try { const o = await chrome.storage.local.get(STORE_KEY); if (o[STORE_KEY]) panelState = { ...panelState, ...o[STORE_KEY] }; } catch {}
  }
  // storage.set returns a promise; a synchronous try/catch alone let its
  // rejection escape as an unhandled "Extension context invalidated".
  const saveState = () => {
    if (!isExtensionContextValid()) { handleContextInvalidated(); return; }
    try { chrome.storage.local.set({ [STORE_KEY]: panelState }).catch(() => {}); } catch {}
  };

  // ─── Sourcing context capture ───
  // When the user lands on an Amazon page from a supplier site, persist
  // that referrer as the "current sourcing session" so the Create panel
  // can auto-prefill the supplier link. Also accumulate a rolling list of
  // recent supplier domains for quick re-pick.
  const SOURCING_KEY = "arbipro_sourcing_session";
  const RECENT_SUPPLIERS_KEY = "arbipro_recent_suppliers";
  const SOURCING_TTL_MS = 30 * 60 * 1000; // 30 min — covers typical OA flow
  const AMAZON_HOST_RE = /(^|\.)amazon\./i;
  const SUPPLIER_HOST_BLOCKLIST = /(google\.|bing\.|duckduckgo\.|youtube\.|facebook\.|reddit\.|t\.co|chrome:|chrome-extension:)/i;

  async function captureSourcingFromReferrer() {
    try {
      const ref = document.referrer || "";
      if (!ref) return;
      let u;
      try { u = new URL(ref); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      if (AMAZON_HOST_RE.test(u.hostname)) return;
      if (SUPPLIER_HOST_BLOCKLIST.test(u.hostname)) return;

      const session = {
        supplier_url: u.href,
        supplier_domain: u.hostname.replace(/^www\./, ""),
        supplier_title: null,
        source_timestamp: Date.now(),
      };
      await chrome.storage.local.set({ [SOURCING_KEY]: session });

      // Update recent suppliers (dedup by domain, max 10, most-recent first).
      const cur = await chrome.storage.local.get(RECENT_SUPPLIERS_KEY);
      const list = Array.isArray(cur[RECENT_SUPPLIERS_KEY]) ? cur[RECENT_SUPPLIERS_KEY] : [];
      const filtered = list.filter((r) => r && r.domain !== session.supplier_domain);
      filtered.unshift({ domain: session.supplier_domain, url: session.supplier_url, ts: session.source_timestamp });
      await chrome.storage.local.set({ [RECENT_SUPPLIERS_KEY]: filtered.slice(0, 10) });

      // Notify panel if mounted.
      try { postToPanel({ type: "SOURCING_SESSION", session }); } catch {}
    } catch {}
  }

  async function getSourcingSession() {
    try {
      const o = await chrome.storage.local.get(SOURCING_KEY);
      const s = o[SOURCING_KEY];
      if (!s || !s.supplier_url) return null;
      if (Date.now() - (s.source_timestamp || 0) > SOURCING_TTL_MS) return null;
      return s;
    } catch { return null; }
  }

  function isOnScreen(pos) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if ((pos.top ?? 0) < -40 || (pos.top ?? 0) > vh - 40) return false;
    if (pos.left != null && (pos.left < -40 || pos.left > vw - 60)) return false;
    if (pos.right != null && (pos.right < -40 || pos.right > vw - 60)) return false;
    return true;
  }

  function applyPosition() {
    if (!iframe) return;
    if (!isOnScreen(panelState.pos)) panelState.pos = { ...DEFAULT_POS };
    const { top, left, right } = panelState.pos;
    iframe.style.top = `${top}px`;
    if (left != null) { iframe.style.left = `${left}px`; iframe.style.right = "auto"; }
    else { iframe.style.right = `${right ?? 16}px`; iframe.style.left = "auto"; }
    const maxW = Math.min(SIZE.width, window.innerWidth - 24);
    iframe.style.width = `${maxW}px`;
    iframe.style.height = `${panelState.collapsed ? SIZE.collapsedHeight : Math.min(SIZE.height, window.innerHeight - 32)}px`;
  }

  const isExtensionContextValid = () => {
    if (contextInvalidated) return false;
    // A newer injected copy owns the page now.
    if (document.documentElement.getAttribute(INSTANCE_ATTR) !== INSTANCE) return false;
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; }
  };

  let domObserver = null;
  let contextInvalidated = false;
  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    try { domObserver?.disconnect(); } catch {}
    domObserver = null;
    // Put history back only if our wrapper is still the installed one; a newer
    // copy may have wrapped ours.
    try { if (history.pushState.__invsprnt === INSTANCE) history.pushState = _push; } catch {}
    try { if (history.replaceState.__invsprnt === INSTANCE) history.replaceState = _replace; } catch {}
    // These remove only THIS copy's own elements (a newer copy already took
    // the shared ids off the page before mounting its own).
    unmountPanel();
    hideLauncher();
  }

  let iframe = null;
  function mountPanel() {
    if (iframe) return iframe;
    if (!isExtensionContextValid()) { handleContextInvalidated(); return null; }
    iframe = document.createElement("iframe");
    iframe.id = "invsprnt-create-panel-frame";
    iframe.src = chrome.runtime.getURL("panel.html");
    iframe.allow = "clipboard-write";
    document.documentElement.appendChild(iframe);
    applyPosition();
    if (panelState.hidden) iframe.style.display = "none";
    return iframe;
  }
  const unmountPanel = () => { iframe?.remove(); iframe = null; };
  const postToPanel = (msg) => iframe?.contentWindow?.postMessage({ source: "invsprnt-host", ...msg }, "*");

  let launcher = null;
  function ensureLauncher() {
    if (launcher) return launcher;
    if (!isExtensionContextValid()) { handleContextInvalidated(); return null; }
    launcher = document.createElement("button");
    launcher.id = "invsprnt-create-launcher";
    launcher.type = "button";
    launcher.title = "Open Create Listing (Alt+A)";
    const launcherIcon = document.createElement("img");
    launcherIcon.src = chrome.runtime.getURL("icons/icon48.png");
    launcherIcon.alt = "";
    launcherIcon.style.width = "28px";
    launcherIcon.style.height = "28px";
    launcherIcon.style.pointerEvents = "none";
    launcher.appendChild(launcherIcon);
    Object.assign(launcher.style, {
      position: "fixed", right: "16px", bottom: "70px", zIndex: "2147483647",
      width: "44px", height: "44px", borderRadius: "999px", border: "none",
      background: "#2563eb", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    });
    launcher.addEventListener("click", () => {
      panelState.hidden = false;
      hideLauncher();
      mountPanel();
      pushCurrentAsin(true);
      saveState();
    });
    document.documentElement.appendChild(launcher);
    return launcher;
  }
  function hideLauncher() { launcher?.remove(); launcher = null; }

  // Drag — uses a transparent host overlay so mousemove keeps firing on the
  // host page even while the cursor is over the iframe (cross-frame events
  // don't bubble). Coordinates use screenX/Y for jitter-free tracking.
  let dragStart = null; // { startLeft, startTop, startSX, startSY }
  let overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "invsprnt-create-drag-overlay";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483646",
      cursor: "grabbing", background: "transparent",
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }
  function removeOverlay() { overlay?.remove(); overlay = null; }

  function beginDrag(sx, sy) {
    if (!iframe) return;
    const r = iframe.getBoundingClientRect();
    dragStart = { startLeft: r.left, startTop: r.top, startSX: sx, startSY: sy };
    ensureOverlay();
    iframe.style.pointerEvents = "none";
  }
  let rafPending = false, lastSX = 0, lastSY = 0;
  function onHostMove(e) {
    if (!dragStart || !iframe) return;
    lastSX = e.screenX; lastSY = e.screenY;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!dragStart || !iframe) return;
      const dx = lastSX - dragStart.startSX;
      const dy = lastSY - dragStart.startSY;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(-40, Math.min(vw - 40, dragStart.startLeft + dx));
      const top = Math.max(0, Math.min(vh - 40, dragStart.startTop + dy));
      panelState.pos = { top, left, right: null };
      iframe.style.left = `${left}px`;
      iframe.style.right = "auto";
      iframe.style.top = `${top}px`;
    });
  }
  function endDrag() {
    if (!dragStart) return;
    dragStart = null;
    removeOverlay();
    if (iframe) iframe.style.pointerEvents = "";
    saveState();
  }
  window.addEventListener("mousemove", onHostMove, true);
  window.addEventListener("mouseup", endDrag, true);

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "invsprnt-create-panel") return;
    // The panel's "Reload page" button. Needs no chrome.* API, so it works
    // even in a cut-off copy. Accepted only from our own panel frame.
    if (d.type === "RELOAD_PAGE") {
      const frame = document.getElementById("invsprnt-create-panel-frame");
      if (frame && e.source === frame.contentWindow) location.reload();
      return;
    }
    if (!isExtensionContextValid()) { handleContextInvalidated(); return; }
    switch (d.type) {
      case "READY":
        postToPanel({ type: "RESTORE_STATE", collapsed: panelState.collapsed });
        pushCurrentAsin(true);
        // Push current sourcing session (if any) so panel can prefill supplier link.
        getSourcingSession().then((s) => { if (s) postToPanel({ type: "SOURCING_SESSION", session: s }); });
        break;
      case "DRAG_BEGIN": beginDrag(d.sx, d.sy); break;
      case "DRAG_END": endDrag(); break;
      case "COLLAPSE_TOGGLE":
        panelState.collapsed = !!d.collapsed;
        applyPosition(); saveState();
        break;
      case "RESET_POS":
        panelState.pos = { ...DEFAULT_POS };
        applyPosition(); saveState();
        break;
      case "CLOSE":
        panelState.hidden = true; unmountPanel(); ensureLauncher(); saveState();
        break;
      case "TOGGLE_VISIBILITY": togglePanel(); break;
    }
  });

  function togglePanel() {
    if (!iframe) {
      panelState.hidden = false; hideLauncher(); mountPanel(); pushCurrentAsin(true);
    } else if (iframe.style.display === "none") {
      panelState.hidden = false; iframe.style.display = ""; hideLauncher();
    } else {
      panelState.hidden = true; iframe.style.display = "none"; ensureLauncher();
    }
    saveState();
  }
  // Alt+L (avoid clash with analyzer's Alt+A)
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "l" || e.key === "L")) {
      if (!isExtensionContextValid()) { handleContextInvalidated(); return; }
      e.preventDefault(); togglePanel();
    }
  });
  window.addEventListener("resize", () => iframe && applyPosition());

  let lastSent = null;
  function pushCurrentAsin(force = false) {
    if (!isExtensionContextValid()) { handleContextInvalidated(); return; }
    const asin = detectAsin();
    const marketplace = detectMarketplace();
    const key = `${asin}|${marketplace}`;
    if (!force && key === lastSent) return;
    lastSent = key;
    if (!panelState.hidden) mountPanel();
    postToPanel({ type: "ASIN_CHANGED", asin, marketplace, url: location.href });
  }

  const _push = history.pushState, _replace = history.replaceState;
  const wrappedPush = function () { _push.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  const wrappedReplace = function () { _replace.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  wrappedPush.__invsprnt = INSTANCE; wrappedReplace.__invsprnt = INSTANCE;
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  window.addEventListener("popstate", () => setTimeout(pushCurrentAsin, 200));

  (async () => {
    await loadState();
    // Capture supplier referrer at first paint — must run before any pushState.
    captureSourcingFromReferrer();
    domObserver = new MutationObserver(() => pushCurrentAsin());
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
    if (panelState.hidden) ensureLauncher();
    pushCurrentAsin(true);
  })();
})();
