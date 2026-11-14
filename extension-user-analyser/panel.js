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

  // ── fields that need the user signed in to Seller Central ────────────────────
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
  // The label on every tile that waits on Seller Central. It names the
  // REQUIREMENT, not our implementation status: “Not checked yet” described
  // this code's state, which is not something the user can act on.
  //
  // The honest caveat lives in the tooltip and in the paragraph under the
  // decision strip: being signed in is necessary but not yet sufficient,
  // because the read itself is not wired up. Without that caveat this label
  // would send an already-signed-in user to sign in again.
  const NOT_READ = 'Sign in to Seller Central';

  function setUnavailable(el, text, why) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(...VERDICT_CLASSES);
    el.classList.add('apx-sa-unknown');
    el.title = why
      || 'Read from your own Amazon Seller Central session, in this browser. '
       + 'Sign in to Seller Central in this tab’s browser — no account connection '
       + 'is needed. This version does not make that read yet, so signing in will '
       + 'not fill this field on its own.';
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
        'Please sign in to Amazon Seller Central in this browser. Gating and fees '
        + 'are read from your own Seller Central session — no account connection is '
        + 'needed, and no seller credentials are used. That read is not wired up in '
        + 'this version yet, so nothing below is a verdict. Everything above was read '
        + 'from this page, or from your own data provider key, and is already correct.';
    }
    const fd = $('apx-final-decision');
    if (fd) { fd.className = 'apx-final-decision unknown'; }

    setUnavailable($('apx-history-verdict'), NOT_READ, 'Price history needs sales-rank history, which this version does not have.');
    const alerts = $('apx-sa-alerts');
    if (alerts) { alerts.textContent = '—'; alerts.title = ''; }

    renderSellersPending();
  }

  // ── the seller list ───────────────────────────────────────────
  //
  // Empty on purpose, and SAYING so. The ported markup ships the string
  // "Loading offers…", which in the Analyzer is true for about a second and
  // here would be a permanent lie -- a spinner that never resolves reads as
  // a broken panel, and the user waits instead of getting on with it.
  //
  // Why it is not wired: the Analyzer fills this from SP-API getItemOffers,
  // server-side, under ONE seller’s credentials. That is the exact thing
  // this extension exists not to do -- it is how one account’s catalogue
  // once ended up written under another’s. The replacement has to read the
  // offers from the user’s own browser instead, and that needs the real
  // markup of the offers panel, which is not guessable from here.
  function renderSellersPending() {
    const count = $('apx-sellers-count');
    if (count) { count.textContent = '—'; count.title = 'Not read yet'; }
    const list = $('apx-sellers-list');
    if (list) {
      list.textContent = '';
      const d = document.createElement('div');
      d.className = 'apx-sellers-empty apx-k';
      d.textContent = 'Not read yet — the seller list is not wired up in this version.';
      d.title = 'It will be read from the offers panel in your own browser session, '
        + 'not from any seller account.';
      list.appendChild(d);
    }
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
    lastSale = r.price && r.price.found ? money(r.price.text) : null;

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
        // NOT “needs an Amazon connection”. It does not, and saying so told the
        // user to go and do something that would not help -- the whole point of
        // this extension is that no account connection exists. What the full
        // list needs is a read of the offers panel in this browser.
        ? `Buy Box: ${r.buyBoxSeller.text} — full offer list not read yet`
        : 'Offer list not read yet';
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
      if (intro) intro.textContent = 'Create an InventorySprint account. Reading product pages needs no Amazon connection — just be signed in to Amazon Seller Central in this browser.';
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
      requestRank(d.reading);
    }
  });

  // ── rank and units, from the user’s own provider key ────────────────
  //
  // These two fields can come from nowhere else. Seller Central does not
  // publish a competitor-visible rank history, and units sold a month is
  // Amazon’s own figure that only the provider mirrors. So unlike fees and
  // gating, they do NOT wait on the Seller Central wiring -- they wait on a
  // key, which the gate has already made certain exists.
  //
  // Cost: one token per ASIN, then free for six hours (the worker caches).

  let rankFor = null;

  function renderRank(res) {
    const bsr = $('apx-sa-bsr');
    const bsrTop = $('apx-bsr');
    const sales = $('apx-sa-sales');

    if (!res || !res.ok) {
      // A failure here must not overwrite a rank the PAGE already gave us.
      const why = (res && res.error) || 'Could not reach the data provider.';
      setUnavailable(sales, 'not available', why);
      if (bsr && bsr.classList.contains('apx-sa-unknown')) setUnavailable(bsr, 'not found', why);
      return;
    }

    // Rank: the page is preferred when it had one -- it is this minute’s
    // value from the page the user is looking at. The provider fills the gap
    // when the page layout hid it, and the tooltip says which source spoke.
    if (res.rank && res.rank.found) {
      for (const el of [bsr, bsrTop]) {
        if (!el) continue;
        if (!el.classList.contains('apx-sa-unknown')) continue; // the page already answered
        el.textContent = res.rank.text;
        el.classList.remove('apx-sa-unknown');
        el.title = 'From your data provider' + (res.cached ? ' (cached)' : '');
      }
    }

    lastFees = res.fees || null;
    renderMoney();

    // Units: Amazon’s own "bought in past month", passed straight through.
    // Absent is a REAL answer -- Amazon does not publish it for every ASIN --
    // and it is not the same as "not checked".
    const est = estMonthly(res.monthlySold, res.rank);
    if (est && sales) {
      sales.textContent = est.text;
      sales.classList.remove('apx-sa-unknown');
      sales.title = est.estimated
        ? 'ESTIMATED from sales rank, using the same formula as the Analyzer. '
          + 'Amazon does not publish a units figure for this ASIN. The estimate is '
          + 'category-blind, so treat it as an order of magnitude, not a number.'
        : 'Units bought in the past month, as published by Amazon'
          + (res.cached ? ' (cached)' : '');
    } else {
      setUnavailable(sales, 'not available',
        'Neither a published units figure nor a sales rank came back for this ASIN.');
    }
  }

  function requestRank(reading) {
    const a = reading && reading.asin;
    const asin = a && a.found ? String(a.value || a.text || '').trim() : '';
    if (!/^[A-Za-z0-9]{10}$/.test(asin)) return;
    if (!hasKey) return; // the gate is showing; nothing to spend a token on

    const mkt = reading.marketplace || 'US';
    const tag = mkt + ':' + asin;
    if (rankFor === tag) return; // already answered for this page
    rankFor = tag;

    setUnavailable($('apx-sa-sales'), 'checking…', 'Asking your data provider.');
    try {
      chrome.runtime.sendMessage({ type: 'ISUA_PROVIDER_PRODUCT', asin, marketplace: mkt }, (res) => {
        const fault = workerFault(res);
        if (fault) { rankFor = null; renderRank({ ok: false, error: fault }); return; }
        if (!res || !res.ok) rankFor = null; // let a later read retry
        renderRank(res);
        refreshKeepa(); // tokens left moved; keep the footer honest
      });
    } catch (e) {
      rankFor = null;
      renderRank({ ok: false, error: 'Could not reach the extension worker.' });
    }
  }

  // ── money ──────────────────────────────────────────────────
  //
  // Every formula here is copied from extension/panel.js so the two panels
  // cannot disagree about the same ASIN. A test pins the Est/mo coefficients
  // to that file, because a silent drift between the two would be invisible
  // until a seller compared them and stopped trusting both.

  let lastFees = null;   // { found, fbaFee, referralPct } from the provider
  let lastSale = null;   // the page price, as a number

  const money = (s) => {
    const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (n) => (n == null ? '\u2014' : '$' + n.toFixed(2));
  const pct = (n) => (n == null ? '\u2014' : n.toFixed(0) + '%');

  /**
   * Units a month. Amazon’s own published figure when there is one; otherwise
   * the SAME power-law fallback extension/panel.js uses, so the two panels
   * agree. It is a heuristic with no citation and it is category-blind -- a
   * rank of 263,045 means something different in Tools than in Books -- so it
   * is labelled as an estimate wherever it is shown, and the published figure
   * always wins when Amazon supplies one.
   */
  function estMonthly(published, rank) {
    if (published && published.found) return { value: published.value, text: published.text, estimated: false };
    if (!(rank && rank.found && rank.value > 0)) return null;
    const n = Math.max(1, Math.round(100000 * Math.pow(rank.value, -0.6)));
    return { value: n, text: '~' + n.toLocaleString(), estimated: true };
  }

  function setMoney(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('apx-sa-unknown', 'apx-good', 'apx-warn', 'apx-bad');
    if (cls) el.classList.add(cls);
  }

  const roiClass = (r) => (r == null ? null : r >= 30 ? 'apx-good' : r >= 15 ? 'apx-warn' : 'apx-bad');
  const marginClass = (m) => (m == null ? null : m >= 20 ? 'apx-good' : m >= 10 ? 'apx-warn' : 'apx-bad');

  /**
   * Fees, and everything that follows from them.
   *
   * FBM deliberately drops the fulfilment fee and says so: the seller’s own
   * shipping and packing replace it, and this panel does not know that cost.
   * Leaving the FBA fee in would overstate fees; silently dropping it without
   * a note would understate them.
   */
  function renderMoney() {
    const sale = lastSale != null ? lastSale : money($('apx-sale') && $('apx-sale').value);
    const cost = money($('apx-cost') && $('apx-cost').value);
    const mode = ($('apx-seller-mode') && $('apx-seller-mode').value) || 'FBA';
    const isFbm = /fbm/i.test(String(mode));

    if (!lastFees || !lastFees.found || sale == null || sale <= 0) {
      const why = !lastFees
        ? 'Not read yet.'
        : (lastFees.found ? 'No sale price was read from this page.'
            : 'Your data provider did not return ' + ((lastFees.missing || []).join(' or ') || 'the fee fields') + ' for this ASIN.');
      for (const id of ['apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-margin', 'apx-sa-maxcost']) {
        setUnavailable($(id), NOT_READ, why);
      }
      renderSim(null, null);
      return;
    }

    const referral = sale * (lastFees.referralPct / 100);
    const fulfil = isFbm ? 0 : lastFees.fbaFee;
    const fees = referral + fulfil;

    const feesEl = $('apx-fees');
    setMoney('apx-fees', fmt(fees));
    if (feesEl) {
      feesEl.title = 'Referral ' + fmt(referral) + ' at ' + lastFees.referralPct + '%'
        + (isFbm ? ' \u2014 no fulfilment fee on FBM, and your own shipping is NOT included'
                 : ' + fulfilment ' + fmt(fulfil))
        + '. From your data provider. Storage and long-term fees are not included.';
    }

    // Max Cost authorises what you may pay, so it uses the same 30% ROI
    // target as the Analyzer. It does not depend on the cost you entered.
    setMoney('apx-sa-maxcost', fmt(Math.max(0, (sale - fees) / 1.30)), 'apx-good');

    if (cost == null || cost <= 0) {
      for (const id of ['apx-profit', 'apx-roi-out', 'apx-sa-margin']) {
        setUnavailable($(id), '\u2014', 'Enter your total cost.');
      }
      renderSim(sale, fees);
      return;
    }

    const profit = sale - fees - cost;
    const roi = (profit / cost) * 100;
    const margin = (profit / sale) * 100;
    setMoney('apx-profit', fmt(profit), profit >= 0 ? 'apx-good' : 'apx-bad');
    setMoney('apx-roi-out', pct(roi), roiClass(roi));
    setMoney('apx-sa-margin', pct(margin), marginClass(margin));
    renderSim(sale, fees);
  }

  /** The slider walks the sale price; fees follow it, because referral is a %. */
  function renderSim(sale, fees) {
    const slider = $('apx-sim-slider');
    const cost = money($('apx-cost') && $('apx-cost').value);
    if (sale == null || fees == null || !slider) {
      for (const id of ['apx-sim-sale', 'apx-sim-profit', 'apx-sim-roi']) setUnavailable($(id), NOT_READ);
      return;
    }
    // 0..100 maps to half..double the live price, with 50 sitting on it.
    const f = Number(slider.value);
    const simSale = sale * (f <= 50 ? 0.5 + (f / 50) * 0.5 : 1 + ((f - 50) / 50));
    const mode = ($('apx-seller-mode') && $('apx-seller-mode').value) || 'FBA';
    const fulfil = /fbm/i.test(String(mode)) ? 0 : (lastFees ? lastFees.fbaFee : 0);
    const simFees = simSale * (lastFees.referralPct / 100) + fulfil;
    setMoney('apx-sim-sale', fmt(simSale));
    const v = $('apx-sim-val');
    if (v) v.textContent = fmt(simSale);
    if (cost == null || cost <= 0) {
      for (const id of ['apx-sim-profit', 'apx-sim-roi']) setUnavailable($(id), '\u2014', 'Enter your total cost.');
      return;
    }
    const p = simSale - simFees - cost;
    setMoney('apx-sim-profit', fmt(p), p >= 0 ? 'apx-good' : 'apx-bad');
    setMoney('apx-sim-roi', pct((p / cost) * 100), roiClass((p / cost) * 100));
  }

  $('apx-cost')?.addEventListener('input', renderMoney);
  $('apx-seller-mode')?.addEventListener('change', renderMoney);
  $('apx-sim-slider')?.addEventListener('input', () => renderSim(lastSale, lastFees && lastFees.found && lastSale != null
    ? lastSale * (lastFees.referralPct / 100) + lastFees.fbaFee
    : null));

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
