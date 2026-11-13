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
//   the user's OWN Seller Central session (NOT YET WIRED -- next step)
//              gating, FBA fees, dimensions; and from fees, everything
//              arithmetic: profit, ROI, max cost, margin.
//
//              Their browser is already signed in to Seller Central, so the
//              answers are theirs and are correct for their account. No
//              InventorySprint-to-Amazon connection is involved, which is the
//              whole reason this extension exists apart from the Analyzer:
//              the Analyzer asks the SERVER, holding one seller's SP-API
//              credentials, and that is precisely how one account's catalogue
//              once ended up written under another's.
//
//   rank data  est/mo sales and price history. Neither can come from Seller
//              Central at all; they are rank-derived. Planned for 0.2.0.
//
// Until those are wired, each dependent field reads "Not checked yet" in
// place: the tile keeps its size and position and shows no number, no colour
// and no verdict. A blank or a zero would both read as information. The one
// thing this panel must never do is show a figure computed from somebody
// else's seller account.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const toHost = (msg) => parent.postMessage({ source: 'isua-panel', ...msg }, '*');

  // WHY A REPLY CAN BE UNRECOGNISED, AND WHY IT IS NOT THE USER'S PROBLEM
  //
  // Chrome does not restart a registered service worker when its file changes
  // on disk -- only the reload button on chrome://extensions does. Refreshing
  // the Amazon tab reloads THIS file from disk while leaving an older worker
  // answering it, so the panel can be newer than the code it talks to. The
  // symptom is a reply naming a message the worker has never heard of, which
  // is the ONLY thing that reply can mean. Cost a confused report on
  // 2026-11-13, where it surfaced raw as "unknown message: ISUA_PROVIDER_SET_KEY".
  const WORKER_DOWN = 'The extension worker is not running. Reload the extension.';
  const WORKER_STALE = 'The extension changed on disk. Reload it on chrome://extensions, then refresh this page.';

  function workerFault(res) {
    if (chrome.runtime.lastError) return WORKER_DOWN;
    if (typeof res?.error === 'string' && res.error.startsWith('unknown message')) return WORKER_STALE;
    return null;
  }

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

  // NOT "Connect Amazon". That message was wrong about this product: nothing
  // here requires an InventorySprint-to-Amazon connection. Gating and fees are
  // meant to come from the user's OWN Seller Central session, already signed in
  // in this browser -- which is the reason this extension exists apart from the
  // Analyzer. Until that call is wired these fields are simply not read yet,
  // and the label should say that and nothing more.
  const NOT_READ = 'Not checked yet';

  function setUnavailable(el, text, why) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(...VERDICT_CLASSES);
    el.classList.add('apx-sa-unknown');
    el.title = why || 'Not read yet — this comes from your own Seller Central session.';
  }

  function renderNeedsAmazon() {
    for (const id of NEEDS_AMAZON) setUnavailable($(id), NOT_READ);
    for (const id of NEEDS_AMAZON_CHIPS) setUnavailable($(id), NOT_READ);
    for (const id of VERDICT_PILLS) setUnavailable($(id), '—');

    // Est/mo is the one field no Seller Central call can answer -- it is an
    // estimate derived from sales-rank history, so it waits on the rank-data
    // provider planned for 0.2.0, not on the Seller Central wiring. Saying so
    // stops it looking like a bug when everything around it fills in.
    setUnavailable($('apx-sa-sales'), NOT_READ, 'Sales estimates need sales-rank history, which this version does not have.');

    // The decision strip must not imply a decision.
    const emoji = $('apx-fd-emoji');
    if (emoji) emoji.textContent = '⏳';
    const action = $('apx-dm-action');
    if (action) action.textContent = 'No decision yet';
    setUnavailable($('apx-fd-confidence'), '—');
    const why = $('apx-dm-why');
    if (why) {
      why.textContent =
        'Gating and fees are read from your own Amazon Seller Central session, '
        + 'in this browser — no account connection is needed. That call is not '
        + 'wired up yet, so nothing below is a verdict. Everything above was '
        + 'read from this page and is already correct.';
    }
    const fd = $('apx-final-decision');
    if (fd) { fd.className = 'apx-final-decision unknown'; }

    setUnavailable($('apx-history-verdict'), NOT_READ, 'Price history needs sales-rank history, which this version does not have.');
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
    setUnavailable($('apx-fba'), NOT_READ);
    setUnavailable($('apx-fbm'), NOT_READ);
    setUnavailable($('apx-amz'), NOT_READ);
    setUnavailable($('apx-swing'), NOT_READ);

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
      setUnavailable($(id), NOT_READ);
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

  // ── which of the three screens is showing ───────────────────────────────
  //
  // Exactly one at a time, and the order is a rule, not a preference: the
  // API-key gate comes before sign-in, and sign-in before any content.
  //
  // The gate also hides the fields read free from the page, which costs
  // nothing to produce and would work without a key. That is deliberate: the
  // rule is that nobody analyses anything without their own key, the owner
  // included. Showing half a panel would invite "why is this bit empty".
  let hasKey = false;

  function show(which) {
    const map = {
      keepa: 'apx-keepa-gate',
      signin: 'apx-signin',
      content: 'apx-content',
    };
    for (const [name, id] of Object.entries(map)) {
      $(id)?.classList.toggle('hidden', name !== which);
    }
  }

  function showSignedOut() { show(hasKey ? 'signin' : 'keepa'); }
  function showSignedIn() { show(hasKey ? 'content' : 'keepa'); }

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

  // ── in-panel sign in / create account ───────────────────────────────────
  //
  // One form, two modes. The credentials are read here and handed to the
  // worker in a single message; nothing is kept afterwards, and the fields
  // are cleared on success so a password does not sit in a DOM node for the
  // life of the tab.

  let mode = 'signin';                       // 'signin' | 'signup'
  const emailEl = () => $('apx-signin-email');
  const passEl = () => $('apx-signin-password');

  function showAuthError(text) {
    const box = $('apx-signin-error');
    if (box) box.textContent = text || '';
  }

  function applyMode() {
    const intro = $('apx-signin-intro');
    const submit = $('apx-signin-btn');
    const toggle = $('apx-signup-btn');
    const pass = passEl();
    showAuthError('');
    if (mode === 'signup') {
      if (intro) intro.textContent = 'Create an InventorySprint account. No Amazon connection needed to read product pages.';
      if (submit) submit.textContent = 'Create account';
      if (toggle) toggle.textContent = 'I already have an account';
      // Tells a password manager to offer a NEW password rather than fill an
      // old one. Getting this wrong is why sign-up forms silently autofill.
      if (pass) pass.setAttribute('autocomplete', 'new-password');
    } else {
      if (intro) intro.textContent = "You're signed out of InventorySprint. Sign in to load product data.";
      if (submit) submit.textContent = 'Sign in';
      if (toggle) toggle.textContent = 'Create an account instead';
      if (pass) pass.setAttribute('autocomplete', 'current-password');
    }
  }

  $('apx-signup-btn')?.addEventListener('click', () => {
    mode = mode === 'signin' ? 'signup' : 'signin';
    applyMode();
  });

  $('apx-signin-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = (emailEl()?.value || '').trim();
    const password = passEl()?.value || '';
    const submit = $('apx-signin-btn');

    if (!email || !password) { showAuthError('Enter your email and password.'); return; }

    showAuthError('');
    if (submit) { submit.disabled = true; submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…'; }

    const type = mode === 'signup' ? 'ISUA_SIGN_UP_PASSWORD' : 'ISUA_SIGN_IN_PASSWORD';
    chrome.runtime.sendMessage({ type, email, password }, (res) => {
      if (submit) submit.disabled = false;
      applyMode();

      const fault = workerFault(res);
      if (fault) { showAuthError(fault); return; }
      if (!res?.ok) { showAuthError(res?.error || 'Could not sign in.'); return; }

      // Clear both fields whatever happened next: nothing is served by
      // leaving a password in the DOM.
      if (emailEl()) emailEl().value = '';
      if (passEl()) passEl().value = '';

      if (res.confirmationRequired) {
        mode = 'signin';
        applyMode();
        showAuthError('Account created. Check your email for the confirmation link, then sign in.');
        return;
      }
      showSignedIn();
      toHost({ type: 'REREAD' });
    });
  });

  applyMode();

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

  // ── the API-key gate ────────────────────────────────────────────────────
  //
  // The panel never sees the key. It asks the worker for state -- saved or
  // not, valid or not, how many tokens are left -- and the worker is the only
  // thing that ever holds the value. There is no message that returns it.

  function describeTokens(s) {
    if (!s || s.tokensLeft == null) return '';
    if (s.tokensLeft > 0) return `${s.tokensLeft.toLocaleString()} tokens`;
    // Out of tokens is an ordinary state on a working key, not a fault, and
    // it must not read as "no data for this product".
    const mins = s.refillIn != null ? Math.max(1, Math.round(s.refillIn / 60000)) : null;
    return mins ? `0 tokens — refills in about ${mins} min` : '0 tokens left';
  }

  function renderKeepaStatus(s) {
    const el = $('apx-keepa-status');
    const btn = $('apx-keepa-change');
    if (!el) return;
    if (!s?.hasKey) { el.textContent = ''; if (btn) btn.hidden = true; return; }
    if (btn) btn.hidden = false;
    const tokens = describeTokens(s);
    el.textContent = s.valid
      ? `Key ${s.masked}${tokens ? ' · ' + tokens : ''}`
      : `Key ${s.masked} · not working`;
    el.title = s.valid ? '' : (s.message || '');
  }

  function keepaError(text) {
    const box = $('apx-keepa-error');
    if (box) box.textContent = text || '';
  }

  function refreshKeepa(then) {
    try {
      chrome.runtime.sendMessage({ type: 'ISUA_PROVIDER_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          hasKey = false;
          show('keepa');
          keepaError(workerFault(res) || WORKER_DOWN);
          return;
        }
        // A saved key that no longer works is NOT a key. Sending the user
        // back to the gate with the reason is the only honest handling; the
        // alternative is a panel that silently returns nothing.
        hasKey = !!res.hasKey && res.valid !== false;
        renderKeepaStatus(res);
        if (res.hasKey && res.valid === false) {
          keepaError(res.message || 'The saved key is no longer working. Paste it again.');
        }
        if (typeof then === 'function') then();
      });
    } catch {
      hasKey = false;
      show('keepa');
    }
  }

  $('apx-keepa-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('apx-keepa-key');
    const btn = $('apx-keepa-save');
    const value = input?.value || '';
    if (!value.trim()) { keepaError('Enter your API key.'); return; }

    keepaError('');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    chrome.runtime.sendMessage({ type: 'ISUA_PROVIDER_SET_KEY', key: value }, (res) => {
      if (btn) { btn.disabled = false; btn.textContent = 'Save key'; }
      const fault = workerFault(res);
      if (fault) { keepaError(fault); return; }
      if (!res?.ok) { keepaError(res?.error || 'That key was not accepted.'); return; }

      // Never leave it in a DOM node once the worker has it.
      if (input) input.value = '';
      hasKey = true;
      renderKeepaStatus({ hasKey: true, valid: true, masked: res.masked, tokensLeft: res.tokensLeft, refillIn: res.refillIn });
      refreshAuth();
    });
  });

  $('apx-keepa-change')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ISUA_PROVIDER_CLEAR_KEY' }, () => {
      hasKey = false;
      renderKeepaStatus({ hasKey: false });
      keepaError('');
      show('keepa');
    });
  });

  renderNeedsAmazon();
  // The gate decides first; only once a working key exists does auth state
  // get to choose between the sign-in card and the content.
  refreshKeepa(() => { if (hasKey) refreshAuth(); else show('keepa'); });
  toHost({ type: 'READY' });
})();
