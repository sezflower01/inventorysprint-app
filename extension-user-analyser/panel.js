// The panel's own script. Runs inside panel.html, which is an extension page
// loaded in an iframe on the Amazon tab.
//
// WHAT THIS FILE IS, AND IS NOT
//
// It is the data layer for a panel whose markup and stylesheet are copies of
// extension/'s. It is NOT a copy of extension/panel.js: that file is 177 KB
// and its job is to turn one seller's SP-API answers into a verdict. This one
// fills the same fields from two much smaller sources:
//
//   the page   ASIN, market, price, Buy Box, sellers, BSR -- read by
//              readPage.js in the content script and posted in. Free, works
//              for everybody, no account needed.
//
//   the user's own backend data (NOT YET WIRED -- next step) fees, ROI,
//              profit, max cost, margin, eligibility, confidence.
//
// Until the second source is wired, every field that depends on it renders as
// "Connect Amazon" in place. That is deliberate and it is also the correct
// end state for a user with no Amazon connection: the tile keeps its size and
// position and shows no number, no colour and no verdict. A blank or a zero
// would both read as information. The one thing this panel must never do is
// show a figure computed from somebody else's seller account -- which is the
// bug the whole user-analyser effort exists to avoid.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const toHost = (msg) => parent.postMessage({ source: 'isua-panel', ...msg }, '*');

  // ── version, from the manifest ──────────────────────────────────────────
  //
  // extension/panel.html hardcodes "v1.5.1" while its manifest says 1.6.0.
  // Reading it means the two cannot disagree.
  try {
    const v = chrome.runtime.getManifest().version;
    $('apx-version').textContent = `v${v}`;
  } catch {
    $('apx-version').textContent = '';
  }

  // ── fields that need an Amazon connection ───────────────────────────────
  //
  // Listed explicitly rather than derived, so that adding a tile is a
  // decision about where its number comes from and not an oversight.
  const NEEDS_AMAZON = [
    'apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost',
    'apx-sa-margin', 'apx-sa-sales',
    'apx-sim-sale', 'apx-sim-profit', 'apx-sim-roi',
  ];
  const NEEDS_AMAZON_CHIPS = ['apx-sa-eligible', 'apx-sa-pl'];
  const VERDICT_PILLS = [
    'apx-dm-profit', 'apx-dm-trend', 'apx-dm-comp', 'apx-dm-elig', 'apx-dm-sales',
  ];

  // Any class that paints a judgement. Stripped wherever we could not compute
  // the thing being judged, so a stale colour cannot imply a verdict.
  const VERDICT_CLASSES = ['apx-good', 'apx-bad', 'apx-warn', 'apx-sa-good', 'apx-sa-bad', 'apx-sa-warn'];

  function setUnavailable(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(...VERDICT_CLASSES);
    el.classList.add('apx-sa-unknown');
    el.title = 'Connect your Amazon account in InventorySprint to see this';
  }

  function renderNeedsAmazon() {
    for (const id of NEEDS_AMAZON) setUnavailable($(id), 'Connect Amazon');
    for (const id of NEEDS_AMAZON_CHIPS) setUnavailable($(id), 'Connect Amazon');
    for (const id of VERDICT_PILLS) setUnavailable($(id), '—');

    // The decision strip must not imply a decision.
    const emoji = $('apx-fd-emoji');
    if (emoji) emoji.textContent = '🔌';
    const action = $('apx-dm-action');
    if (action) action.textContent = 'Connect Amazon for a decision';
    setUnavailable($('apx-fd-confidence'), '—');
    const why = $('apx-dm-why');
    if (why) {
      why.textContent =
        'Fees, ROI and eligibility are computed from your own Amazon account. '
        + 'Connect it in InventorySprint and this panel fills in. '
        + 'Everything above that was read from this page is already shown.';
    }
    const fd = $('apx-final-decision');
    if (fd) { fd.className = 'apx-final-decision unknown'; }

    setUnavailable($('apx-history-verdict'), 'Connect Amazon');
    const alerts = $('apx-sa-alerts');
    if (alerts) { alerts.textContent = '—'; alerts.title = ''; }
  }

  // ── page-read fields ────────────────────────────────────────────────────

  const MARKET_NAME = { US: 'US', CA: 'CA', MX: 'MX', BR: 'BR', UK: 'UK', DE: 'DE', FR: 'FR', IT: 'IT', ES: 'ES', JP: 'JP' };

  /** Never guess: a field that was not found says so, and says nothing else. */
  function put(id, field, fallback) {
    const el = $(id);
    if (!el) return;
    if (field && field.found && field.text != null && String(field.text).trim() !== '') {
      el.textContent = String(field.text);
      el.classList.remove('apx-sa-unknown');
    } else {
      el.textContent = fallback || 'not found';
      el.classList.add('apx-sa-unknown');
    }
  }

  function renderReading(r) {
    if (!r) return;

    put('apx-asin', r.asin);
    const mkt = $('apx-mkt');
    if (mkt) mkt.textContent = MARKET_NAME[r.marketplace] || r.marketplace || '—';

    put('apx-bb', r.buyBoxSeller);
    put('apx-sellers', r.sellerCount);
    put('apx-bsr', r.bsr);
    put('apx-sa-bsr', r.bsr);

    // Price goes to the read-only Sale input, same as the original.
    const sale = $('apx-sale');
    if (sale) sale.value = r.price && r.price.found ? String(r.price.text) : '';

    // Status pill: the gating statement, with no verdict attached. readPage's
    // gatingNotice() exists precisely because this cannot be answered from a
    // product page -- see its comment.
    const pill = $('apx-elig');
    if (pill) {
      pill.textContent = 'Not checked';
      pill.classList.add('apx-sa-unknown');
      pill.title = (r.gating && r.gating.text) || '';
    }

    // Offer-derived prices come from the seller's own API in the original.
    // Here only the Buy Box owner is known, from the page.
    setUnavailable($('apx-fba'), 'Connect Amazon');
    setUnavailable($('apx-fbm'), 'Connect Amazon');
    setUnavailable($('apx-amz'), 'Connect Amazon');
    setUnavailable($('apx-swing'), 'Connect Amazon');

    const list = $('apx-sellers-list');
    if (list) {
      list.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'apx-sellers-empty apx-k';
      empty.textContent = r.buyBoxSeller && r.buyBoxSeller.found
        ? `Buy Box: ${r.buyBoxSeller.text} — the full offer list needs an Amazon connection`
        : 'The offer list needs an Amazon connection';
      list.appendChild(empty);
    }
    const count = $('apx-sellers-count');
    if (count) count.textContent = r.sellerCount && r.sellerCount.found ? String(r.sellerCount.text) : '—';

    // Dimensions are an SP-API catalogue field in the original.
    for (const id of ['apx-dims-pkg', 'apx-dims-pkg-wt', 'apx-dims-item', 'apx-dims-item-wt']) {
      setUnavailable($(id), 'Connect Amazon');
    }
    const dsrc = $('apx-dims-source');
    if (dsrc) dsrc.textContent = '—';

    const cached = $('apx-cached');
    if (cached) cached.textContent = 'Read from this page in your browser. No seller account was used.';

    const hist = $('apx-open-history-btn');
    if (hist && r.asin && r.asin.found) {
      hist.href = `https://inventorysprint.com/tools/product-library?asin=${encodeURIComponent(r.asin.value || r.asin.text)}`;
    }
  }

  // ── auth ────────────────────────────────────────────────────────────────

  let authUrls = { signInUrl: 'https://inventorysprint.com/login', signUpUrl: 'https://inventorysprint.com/signup' };

  function showSignedOut() {
    $('apx-signin')?.classList.remove('hidden');
    $('apx-content')?.classList.add('hidden');
  }
  function showSignedIn() {
    $('apx-signin')?.classList.add('hidden');
    $('apx-content')?.classList.remove('hidden');
  }

  function refreshAuth() {
    try {
      chrome.runtime.sendMessage({ type: 'ISUA_AUTH_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) { showSignedOut(); return; }
        if (res.signInUrl) authUrls.signInUrl = res.signInUrl;
        if (res.signUpUrl) authUrls.signUpUrl = res.signUpUrl;
        if (res.signedIn) showSignedIn(); else showSignedOut();
      });
    } catch {
      showSignedOut();
    }
  }

  // DIFFERENCE 1 of 3 (see panel.html): a button, not a password form. The
  // panel is injected into amazon.com, and a password field on a third party's
  // page is the one part of the original not worth copying. Sign-in happens on
  // our own origin, in a tab the user can see the address bar of.
  $('apx-signin-btn')?.addEventListener('click', () => {
    chrome.tabs?.create
      ? chrome.tabs.create({ url: authUrls.signInUrl })
      : window.open(authUrls.signInUrl, '_blank', 'noopener');
  });
  $('apx-signup-btn')?.addEventListener('click', () => {
    chrome.tabs?.create
      ? chrome.tabs.create({ url: authUrls.signUpUrl })
      : window.open(authUrls.signUpUrl, '_blank', 'noopener');
  });

  // ── header controls, identical behaviour to the original ────────────────

  let collapsed = false;
  $('apx-collapse')?.addEventListener('click', () => {
    collapsed = !collapsed;
    document.body.classList.toggle('apx-collapsed', collapsed);
    toHost({ type: 'COLLAPSE_TOGGLE', collapsed });
  });
  $('apx-close')?.addEventListener('click', () => toHost({ type: 'CLOSE' }));
  $('apx-reset')?.addEventListener('click', () => toHost({ type: 'RESET_POS' }));
  $('apx-refresh')?.addEventListener('click', () => toHost({ type: 'REREAD' }));
  $('apx-meta-recheck')?.addEventListener('click', () => toHost({ type: 'REREAD' }));

  // ── messages from the host ──────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'isua-host') return;
    // Only the window that framed us. Any page script could postMessage, and
    // the reading drives what is displayed.
    if (e.source !== parent) return;

    if (d.type === 'RESTORE_STATE') {
      collapsed = !!d.collapsed;
      document.body.classList.toggle('apx-collapsed', collapsed);
      return;
    }
    if (d.type === 'PAGE_READING') {
      renderNeedsAmazon();
      renderReading(d.reading);
    }
  });

  renderNeedsAmazon();
  refreshAuth();
  toHost({ type: 'READY' });
})();
