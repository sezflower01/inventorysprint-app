// Mounts the panel as an iframe on the Amazon page, and feeds it what this
// script reads from the page.
//
// ── WHY AN IFRAME, HAVING FIRST BUILT A SHADOW ROOT ──────────────────────
//
// This file used to attach a closed shadow root, so that nothing had to be
// listed in web_accessible_resources. That is genuinely the tighter choice and
// it was the right default -- but the goal changed: the panel must now be
// visually identical to extension/'s, whose stylesheet is 34 KB authored for a
// DOCUMENT (html/body rules, inherited fonts, a cascade that starts at :root).
// Re-hosting that inside a shadow root makes "identical" into "very close",
// and every divergence becomes its own hunt. An iframe gives the stylesheet
// the document it was written for, so the UI matches by construction.
//
// The cost is paid back down: web_accessible_resources is limited to the
// amazon.com hosts this extension already runs on, so no other site can load
// panel.html or probe for the extension.
//
// ── GEOMETRY IS COPIED, NOT INVENTED ────────────────────────────────────
//
// panel.css carries a `#invsprnt-panel-frame` rule that positions the OLD
// extension's frame. This frame deliberately uses a DIFFERENT id, because both
// extensions will be installed side by side for comparison and two elements
// answering to one id is its own bug. So the frame's styles are applied here
// inline, with values copied from that rule. A test asserts the two agree, so
// they cannot drift.
//
// Reads once at document_idle, then only when the user asks. No polling, no
// MutationObserver -- the page is static once loaded, and a watcher on an
// Amazon product page fires constantly for carousels and ads.

(function () {
  'use strict';

  const FRAME_ID = 'isua-panel-frame';
  const LAUNCHER_ID = 'isua-launcher';
  const STORE_KEY = 'isua.panel';

  // Copied from panel.css #invsprnt-panel-frame. Kept in sync by a test.
  const FRAME_STYLE = {
    position: 'fixed',
    top: '96px',
    right: '16px',
    width: '360px',
    height: '640px',
    border: '0',
    borderRadius: '14px',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.35)',
    zIndex: '2147483647',
    background: 'transparent',
    colorScheme: 'light dark',
  };
  const SIZE = { width: 360, height: 640, collapsedHeight: 48 };
  const DEFAULT_POS = { top: 96, right: 16 };

  if (document.getElementById(FRAME_ID)) return;

  const readPage = globalThis.ISUA?.readPage;
  if (!readPage) {
    console.warn('[ISUA] readPage.js did not load; panel not shown');
    return;
  }

  // chrome.runtime goes away when the extension is reloaded or updated while a
  // tab is still open. Every chrome.* call below is guarded by this, because
  // the alternative is an "Extension context invalidated" thrown from a
  // listener the page cannot see.
  const alive = () => {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  };

  let state = { pos: { ...DEFAULT_POS }, collapsed: false, hidden: false };

  async function loadState() {
    if (!alive()) return;
    try {
      const o = await chrome.storage.local.get(STORE_KEY);
      if (o[STORE_KEY]) state = { ...state, ...o[STORE_KEY] };
    } catch { /* first run, or storage unavailable */ }
  }

  // storage.set returns a promise: a synchronous try/catch alone lets its
  // rejection escape as an unhandled error.
  const saveState = () => {
    if (!alive()) return;
    try { chrome.storage.local.set({ [STORE_KEY]: state }).catch(() => {}); } catch {}
  };

  function onScreen(pos) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if ((pos.top ?? 0) < -40 || (pos.top ?? 0) > vh - 40) return false;
    if (pos.left != null && (pos.left < -40 || pos.left > vw - 60)) return false;
    if (pos.right != null && (pos.right < -40 || pos.right > vw - 60)) return false;
    return true;
  }

  let frame = null;

  function applyPosition() {
    if (!frame) return;
    if (!onScreen(state.pos)) state.pos = { ...DEFAULT_POS };
    const { top, left, right } = state.pos;
    frame.style.top = `${top}px`;
    if (left != null) { frame.style.left = `${left}px`; frame.style.right = 'auto'; }
    else { frame.style.right = `${right ?? 16}px`; frame.style.left = 'auto'; }
    frame.style.width = `${Math.min(SIZE.width, window.innerWidth - 24)}px`;
    frame.style.height = `${
      state.collapsed ? SIZE.collapsedHeight : Math.min(SIZE.height, window.innerHeight - 32)
    }px`;
  }

  function mount() {
    if (frame) return frame;
    if (!alive()) return null;   // getURL throws once the context is gone
    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.src = chrome.runtime.getURL('panel.html');
    frame.title = 'InventorySprint User Analyser';
    Object.assign(frame.style, FRAME_STYLE);
    document.documentElement.appendChild(frame);
    applyPosition();
    if (state.hidden) frame.style.display = 'none';
    return frame;
  }

  const unmount = () => { frame?.remove(); frame = null; };

  // Addressed to our own frame only. "*" as the target origin is fine because
  // the payload is page data the page already has; the panel side checks the
  // source tag before trusting anything.
  const toPanel = (msg) => frame?.contentWindow?.postMessage({ source: 'isua-host', ...msg }, '*');

  let launcher = null;
  function showLauncher() {
    if (launcher || !alive()) return;
    launcher = document.createElement('button');
    launcher.id = LAUNCHER_ID;
    launcher.type = 'button';
    launcher.title = 'Open InventorySprint User Analyser (Alt+U)';
    const icon = document.createElement('img');
    icon.src = chrome.runtime.getURL('icons/icon48.png');
    icon.alt = '';
    icon.style.width = '28px';
    icon.style.height = '28px';
    icon.style.pointerEvents = 'none';
    launcher.appendChild(icon);
    Object.assign(launcher.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      width: '44px', height: '44px', borderRadius: '999px', border: 'none',
      background: '#2563eb', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    });
    launcher.addEventListener('click', () => {
      state.hidden = false;
      hideLauncher();
      mount();
      saveState();
    });
    document.documentElement.appendChild(launcher);
  }
  function hideLauncher() { launcher?.remove(); launcher = null; }

  // ── page reading ────────────────────────────────────────────────────────

  function read() {
    try {
      return readPage.extract(document, location.href);
    } catch (e) {
      console.warn('[ISUA] could not read this page:', e?.message || e);
      return null;
    }
  }

  // Only the plain fields cross into the iframe: text, found, source. Not the
  // DOM nodes the reader touched, and not the whole reading object -- the
  // panel has no business with either.
  function wireFormat(reading) {
    if (!reading) return null;
    const f = (x) => (x ? { found: !!x.found, text: x.text ?? null, value: x.value ?? null, source: x.source ?? null } : null);
    return {
      asin: f(reading.asin),
      title: f(reading.title),
      price: f(reading.price),
      buyBoxSeller: f(reading.buyBoxSeller),
      sellerCount: f(reading.sellerCount),
      bsr: f(reading.bsr),
      availability: f(reading.availability),
      variationParent: f(reading.variationParent),
      isBook: f(reading.isBook),
      gating: reading.gating ? { text: reading.gating.text, sellerCentralUrl: reading.gating.sellerCentralUrl } : null,
      marketplace: reading.marketplace || 'US',
      pageUrl: location.href.split('?')[0],
    };
  }

  let reading = read();

  // No ASIN means this is not a product page we understand. Show nothing
  // rather than an empty panel.
  if (!reading || !reading.asin.found) return;

  // ── host side of the message protocol ───────────────────────────────────

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'isua-panel') return;
    // Any script on the page can postMessage, so a message claiming to be the
    // panel is only trusted when it really came from the panel's window.
    if (!frame || e.source !== frame.contentWindow) return;

    if (d.type === 'RELOAD_PAGE') { location.reload(); return; }
    if (!alive()) return;

    switch (d.type) {
      case 'READY':
        toPanel({ type: 'RESTORE_STATE', collapsed: state.collapsed });
        toPanel({ type: 'PAGE_READING', reading: wireFormat(reading) });
        break;
      case 'REREAD':
        reading = read();
        toPanel({ type: 'PAGE_READING', reading: wireFormat(reading) });
        break;
      case 'COLLAPSE_TOGGLE':
        state.collapsed = !!d.collapsed;
        applyPosition(); saveState();
        break;
      case 'RESET_POS':
        state.pos = { ...DEFAULT_POS };
        applyPosition(); saveState();
        break;
      case 'CLOSE':
        state.hidden = true; unmount(); showLauncher(); saveState();
        break;
      case 'TOGGLE_VISIBILITY':
        toggle();
        break;
    }
  });

  function toggle() {
    if (!frame) {
      state.hidden = false; hideLauncher(); mount();
    } else if (frame.style.display === 'none') {
      state.hidden = false; frame.style.display = ''; hideLauncher();
    } else {
      state.hidden = true; frame.style.display = 'none'; showLauncher();
    }
    saveState();
  }

  // Alt+U, not the old extension's Alt+A: both will be installed at once while
  // the two panels are compared, and one shortcut toggling both is useless.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'u' || e.key === 'U')) {
      if (!alive()) return;
      e.preventDefault();
      toggle();
    }
  });

  window.addEventListener('resize', () => frame && applyPosition());

  loadState().then(() => {
    if (state.hidden) showLauncher();
    else mount();
  });
})();
