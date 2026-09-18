// Detects ASIN + marketplace on Amazon pages, mounts the floating panel,
// and handles draggable / collapsible / Alt+A toggle behavior.
(function () {
  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?]|$)/;

  const HOST_TO_MARKET = [
    [/amazon\.com\.mx/, "MX"], [/amazon\.com\.br/, "BR"],
    [/amazon\.co\.uk/, "GB"], [/amazon\.co\.jp/, "JP"],
    [/amazon\.ca/, "CA"], [/amazon\.de/, "DE"], [/amazon\.fr/, "FR"],
    [/amazon\.it/, "IT"], [/amazon\.es/, "ES"], [/amazon\.com/, "US"],
  ];

  const DEFAULT_POS = { top: 96, right: 16, left: null };
  const SIZE = { width: 360, height: 640, collapsedHeight: 48 };
  const STORE_KEY = "arbipro_panel_state";

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
  //
  // Updating or reloading the extension does not remove this script from
  // pages that are already open: it keeps running, cut off from the new
  // extension, and every chrome.* call throws "Extension context
  // invalidated". The seller hit it on the panel's sign-in form.
  //
  // background.js now injects a fresh copy into open tabs on update. Each
  // copy stamps an instance id on <html>; a newer copy removes the old panel
  // and launcher, and an older copy that notices it is stale or cut off
  // retires -- disconnects its observer, restores history, stops touching
  // chrome.* -- instead of throwing on every Amazon DOM mutation.
  const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const INSTANCE_ATTR = "data-invsprnt-analyzer";
  // Legacy "arbipro-*" ids too: tabs still running a pre-rename copy (<= 1.4.4)
  // carry those, and the copy injected on update must clear them as well.
  for (const id of ["invsprnt-panel-frame", "invsprnt-launcher", "arbipro-panel-frame", "arbipro-launcher"]) {
    document.getElementById(id)?.remove();
  }
  document.documentElement.setAttribute(INSTANCE_ATTR, INSTANCE);

  let retired = false;
  const extensionAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const superseded = () => document.documentElement.getAttribute(INSTANCE_ATTR) !== INSTANCE;
  let observer = null;
  let _push = null, _replace = null;
  function retire() {
    if (retired) return;
    retired = true;
    try { observer?.disconnect(); } catch {}
    // Only restore history if ours is still the installed wrapper; a newer
    // copy may have wrapped ours, and unwinding would drop its hook.
    try { if (_push && history.pushState.__invsprnt === INSTANCE) history.pushState = _push; } catch {}
    try { if (_replace && history.replaceState.__invsprnt === INSTANCE) history.replaceState = _replace; } catch {}
  }
  // True when this copy may still act. Retires it the first time it isn't.
  const usable = () => {
    if (retired) return false;
    if (superseded() || !extensionAlive()) { retire(); return false; }
    return true;
  };

  let panelState = { pos: { ...DEFAULT_POS }, collapsed: false, hidden: false };
  async function loadState() {
    if (!usable()) return;
    try { const o = await chrome.storage.local.get(STORE_KEY); if (o[STORE_KEY]) panelState = { ...panelState, ...o[STORE_KEY] }; } catch {}
  }
  // storage.set returns a promise: a synchronous try/catch alone let its
  // rejection escape as an unhandled "Extension context invalidated".
  const saveState = () => {
    if (!usable()) return;
    try { chrome.storage.local.set({ [STORE_KEY]: panelState }).catch(() => {}); } catch {}
  };

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

  let iframe = null;
  function mountPanel() {
    if (iframe) return iframe;
    if (!usable()) return null; // getURL throws once the context is gone
    iframe = document.createElement("iframe");
    iframe.id = "invsprnt-panel-frame";
    iframe.src = chrome.runtime.getURL("panel.html");
    iframe.allow = "clipboard-write";
    document.documentElement.appendChild(iframe);
    applyPosition();
    if (panelState.hidden) iframe.style.display = "none";
    return iframe;
  }
  const unmountPanel = () => { iframe?.remove(); iframe = null; };
  const postToPanel = (msg) => iframe?.contentWindow?.postMessage({ source: "invsprnt-host", ...msg }, "*");

  // Floating launcher shown when the panel is hidden so users can re-open
  // it without needing to remember Alt+A.
  let launcher = null;
  function ensureLauncher() {
    if (launcher) return launcher;
    if (!usable()) return null;
    launcher = document.createElement("button");
    launcher.id = "invsprnt-launcher";
    launcher.type = "button";
    launcher.title = "Open InventorySprint (Alt+A)";
    const launcherIcon = document.createElement("img");
    launcherIcon.src = chrome.runtime.getURL("icons/icon48.png");
    launcherIcon.alt = "";
    launcherIcon.style.width = "28px";
    launcherIcon.style.height = "28px";
    launcherIcon.style.pointerEvents = "none";
    launcher.appendChild(launcherIcon);
    Object.assign(launcher.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
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

  // Drag disabled — analyzer panel is fixed in its default position.
  panelState.pos = { ...DEFAULT_POS };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "invsprnt-panel") return;
    // The panel's "Reload page" button. Handled even by a retired copy -- it
    // needs no chrome.* API, and a cut-off tab is exactly when it is pressed.
    // Only from our own frame: any script on the page can postMessage.
    if (d.type === "RELOAD_PAGE") {
      const frame = document.getElementById("invsprnt-panel-frame");
      if (frame && e.source === frame.contentWindow) location.reload();
      return;
    }
    if (!usable()) return;
    switch (d.type) {
      case "READY":
        postToPanel({ type: "RESTORE_STATE", collapsed: panelState.collapsed });
        pushCurrentAsin(true);
        break;
      case "DRAG_BEGIN":
      case "DRAG_DELTA":
      case "DRAG_END":
        // ignored — drag disabled
        break;
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
      panelState.hidden = false;
      hideLauncher();
      mountPanel();
      pushCurrentAsin(true);
    } else if (iframe.style.display === "none") {
      panelState.hidden = false; iframe.style.display = "";
      hideLauncher();
    } else {
      panelState.hidden = true; iframe.style.display = "none";
      ensureLauncher();
    }
    saveState();
  }
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      if (!usable()) return;
      e.preventDefault(); togglePanel();
    }
  });
  window.addEventListener("resize", () => iframe && applyPosition());

  let lastSent = null;
  function pushCurrentAsin(force = false) {
    if (!usable()) return;
    const asin = detectAsin();
    const marketplace = detectMarketplace();
    const key = `${asin}|${marketplace}`;
    if (!force && key === lastSent) return;
    lastSent = key;
    if (!panelState.hidden) mountPanel();
    postToPanel({ type: "ASIN_CHANGED", asin, marketplace, url: location.href });
  }

  _push = history.pushState; _replace = history.replaceState;
  const wrappedPush = function () { _push.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  const wrappedReplace = function () { _replace.apply(this, arguments); setTimeout(pushCurrentAsin, 200); };
  wrappedPush.__invsprnt = INSTANCE; wrappedReplace.__invsprnt = INSTANCE;
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  window.addEventListener("popstate", () => setTimeout(pushCurrentAsin, 200));

  (async () => {
    await loadState();
    if (!usable()) return;
    observer = new MutationObserver(() => pushCurrentAsin());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (panelState.hidden) ensureLauncher();
    pushCurrentAsin(true);
  })();
})();
