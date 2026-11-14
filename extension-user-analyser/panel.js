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
//              Central at all; they are rank-derived. The provider IS wired
//              now, so est/mo fills; the price-history chart is not drawn.
//
// Until those are wired, each dependent field says so in place: the tile
// keeps its size and position and shows no number, no colour and no
// verdict. A blank or a zero would both read as information. The one thing
// this panel must never do is show a figure computed from somebody else’s
// seller account.
//
// WHICH it says is now two different labels, and the difference is the
// whole point -- see LOADING and NOT_IN_VERSION below.
//
// The label is referred to by its CONSTANT here, never quoted. Quoting it
// left a third, retired wording in this header while the code said another,
// and a reader has no way to tell which of the two is current.

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

  // ── fields nothing has answered yet, at first paint ──────────────────────────
  //
  // Listed explicitly rather than derived, so that adding a tile is a
  // decision about where its number comes from and not an oversight.
  //
  // These two lists are NOT the same wait, and one shared label hid it:
  //
  //   NEEDS_AMAZON        the money tiles. They wait on the PROVIDER KEY,
  //                       which already answers -- renderMoney fills every
  //                       one of them as soon as fees arrive. The not-read
  //                       state here is first paint only.
  //
  //   NEEDS_AMAZON_CHIPS  gating and P&L eligibility. These wait on the
  //                       Seller Central read, which is not wired, so they
  //                       stay not-read for the whole session.
  //
  // The names stay as they are because panel.html uses the same ids; what
  // the comment must not do is give both lists one wrong cause.
  const NEEDS_AMAZON = [
    'apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost',
    'apx-sa-margin', 'apx-sa-sales',
    'apx-sim-sale', 'apx-sim-profit', 'apx-sim-roi',
  ];
  // The two gating chips USED to share this list and the one label. They
  // are blanked separately now, because they are not the same kind of
  // empty: eligibility is a read this build does not make, private-label
  // risk is a judgement nobody has defined.
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
  // The label on every tile that waits on the Seller Central read.
  //
  // IT MUST NOT NAME AN ACTION, and this went wrong twice in one day:
  //
  //   “Connect Amazon”      wrong mechanism. There is no OAuth connection
  //                        and there will not be one, so this sent the user
  //                        looking for a button that does not exist.
  //
  //   “Sign in to Seller    right mechanism, but UNCONDITIONAL. Nothing in
  //    Central”             this extension checks the session, so an
  //                        already-signed-in user read it as broken
  //                        detection -- reported within minutes.
  //
  // Detection cannot be added cheaply either: the two browser cookie APIs
  // are both banned by a test in tests/noOwnerFallback (deliberately -- reading
  // a seller’s Amazon session is the thing this extension must never do), so
  // the session can only be inferred from a RESPONSE. That is the same
  // request as the gating read itself, so the state and the data arrive
  // together or not at all.
  //
  // Until then the label states our own position, which is the only thing
  // that is actually known here. The source and the requirement live in the
  // tooltip, where they inform without instructing.
  // TWO STATES, because one label was answering two different questions.
  //
  // "Not read yet" sat on a tile that fills in two seconds AND on a tile
  // that will never fill in this build. The user cannot tell those apart,
  // and asked the only reasonable question: when WILL it be read? A label
  // that cannot be acted on is the same fault as one that asserts a state
  // nothing checks -- it just fails quietly instead of loudly.
  //
  //   LOADING         an answer is on its way THIS session. Only ever a
  //                   first paint. If one of these is still showing, the
  //                   lookup failed and the failure path names the reason
  //                   in its place.
  //   NOT_IN_VERSION  nothing in this build computes it. Final, and honest,
  //                   so the row stops reading as broken.
  //
  // A field that is NEITHER -- not loading, not missing from the build, just
  // not applicable to THIS page -- gets its own inline reason instead of
  // either global label. Two states are enough for the panel, not for every
  // field in it; the price simulator on a variation parent is the live
  // example, and forcing it into one of these two would be a third lie.
  const LOADING = 'Loading…';
  const NOT_IN_VERSION = 'Not available in this version';

  function setUnavailable(el, text, why) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(...VERDICT_CLASSES);
    el.classList.add('apx-sa-unknown');
    el.title = why
      || 'Comes from your own Amazon Seller Central session in this browser — '
       + 'no account connection, and no seller credentials. This version does not '
       + 'make that read yet, so being signed in is not what is missing.';
  }

  function renderNeedsAmazon() {
    // Provider-fed money tiles. These DO fill, seconds later, so they get
    // the loading label and not the absent one.
    for (const id of NEEDS_AMAZON) {
      setUnavailable($(id), LOADING, 'Asking your data provider for this ASIN.');
    }
    for (const id of VERDICT_PILLS) setUnavailable($(id), '—');

    // Eligibility: a real read, but not one this build makes. The tooltip
    // keeps saying that your sign-in is not the thing missing, because that
    // is the wrong conclusion a reader reaches first.
    setUnavailable($('apx-sa-eligible'), NOT_IN_VERSION);

    // Private-label risk: deliberately NOT defined for v1, so there is
    // nothing here to be waiting on. Brand-risk research is the user’s own
    // and stays manual on purpose; a verdict synthesised from brand plus
    // seller count would put a number on a judgement nobody made.
    setUnavailable($('apx-sa-pl'), NOT_IN_VERSION,
      'Not defined in this version. Brand risk is a judgement this build '
      + 'does not make, so it shows no verdict rather than a guessed one.');

    // Est/mo is the one field no Seller Central call can answer, so it is
    // blanked here with a reason of its own rather than the Seller Central one.
    //
    // The reason CHANGED once the provider was wired. It used to read that this
    // needed sales-rank HISTORY from a provider planned for 0.2.0. Both halves
    // are now false: the provider answers today, and the estimate is a power
    // law over the ONE CURRENT rank, not a history. A tooltip claiming the
    // version cannot do what it just did is the same fault as a label
    // asserting a state nothing checks -- it teaches the reader to distrust
    // the tiles that ARE right.
    setUnavailable($('apx-sa-sales'), LOADING,
      'Waiting on your data provider. Where Amazon publishes no units figure '
      + 'for a product, this is estimated from its current sales rank and '
      + 'marked with a ~.');

    // The decision strip must not imply a decision.
    const emoji = $('apx-fd-emoji');
    if (emoji) emoji.textContent = '⏳';
    const action = $('apx-dm-action');
    if (action) action.textContent = 'No decision yet';
    setUnavailable($('apx-fd-confidence'), '—');
    const why = $('apx-dm-why');
    if (why) {
      why.textContent =
        'Gating comes from your own Amazon Seller Central session in this browser, '
        + 'while you are signed in to it — no account connection, and no seller '
        + 'credentials. This version does not make that read yet, so nothing in the '
        + 'two rows above is a verdict and your sign-in is not what is missing. '
        + 'Everything else was read from this page or from your own data provider '
        + 'key, and is already correct.';
    }
    const fd = $('apx-final-decision');
    if (fd) { fd.className = 'apx-final-decision unknown'; }

    // Says only what is true: the chart is not drawn. The old wording blamed
    // missing provider data, which stopped being the reason once the provider
    // was answering -- and it sat directly under a rank the panel had read.
    setUnavailable($('apx-history-verdict'), NOT_IN_VERSION,
      'This version does not draw the price-history chart yet. Whether the '
      + 'provider answer already carries the series is reported on the '
      + 'diagnostic line at the bottom of the panel.');
    const alerts = $('apx-sa-alerts');
    if (alerts) { alerts.textContent = '—'; alerts.title = ''; }

    renderSellersPending();
  }

  // ── the seller list ───────────────────────────────────────────
  //
  // WIRED NOW, from the page. The Analyzer fills this from SP-API
  // getItemOffers, server-side, under ONE seller’s credentials -- the exact
  // thing this extension exists not to do, and how one account’s catalogue
  // once ended up written under another’s. This reads #all-offers-display out
  // of the page the user is already looking at: no account, no credentials,
  // and no provider tokens.
  //
  // The panel is CLOSED until the shopper opens it, so "not read" here is a
  // real and fixable state rather than a missing feature. That makes it the
  // one empty label in this file that names an action, and it may: the thing
  // it asks for is on screen, and pressing Recheck afterwards does work.
  const OFFERS_CLOSED_WHY =
    'Open the "New (N) from ..." offer list on the page, then press Recheck. '
    + 'It is read from the page in your own browser -- no seller account, and '
    + 'no provider tokens.';

  function renderSellersPending() {
    const count = $('apx-sellers-count');
    if (count) { count.textContent = '—'; count.title = OFFERS_CLOSED_WHY; }
    const list = $('apx-sellers-list');
    if (list) {
      list.textContent = '';
      const d = document.createElement('div');
      d.className = 'apx-sellers-empty apx-k';
      d.textContent = 'Offer list not open on this page.';
      d.title = OFFERS_CLOSED_WHY;
      list.appendChild(d);
    }
    for (const id of ['apx-fba', 'apx-fbm', 'apx-amz']) {
      setUnavailable($(id), 'not open', OFFERS_CLOSED_WHY);
    }
  }

  // ── the offers panel, once it is open ───────────────────────────────────
  //
  // EVERY figure here is LANDED cost, price plus shipping. The page shows the
  // FBM offer in the capture as "$68.95" and charges $8.33 to deliver it, so
  // ranking on the displayed price puts it below three FBA offers it is in
  // fact 12 dollars dearer than. On a sourcing panel that is not a rounding
  // error, it is the wrong buy.
  function offerLine(o) {
    const bits = [o.sellerName || 'unnamed seller'];
    bits.push(fmt(o.landed));
    // null is "the page did not say", which is not FBM.
    bits.push(o.fba === true ? 'FBA' : (o.fba === false ? 'FBM' : 'fulfilment not stated'));
    if (o.stars != null) {
      const r = o.ratings != null ? ' (' + o.ratings.toLocaleString() + ')' : '';
      const p = o.positivePct != null
        ? ' ' + o.positivePct + '%' + (o.positiveWindow === 'lifetime' ? ' lifetime' : '')
        : '';
      bits.push(o.stars + '\u2605' + r + p);
    }
    if (o.maxQty != null) bits.push('qty ' + o.maxQty + (o.maxQtyIsCap ? '+' : ''));
    if (o.isBuyBox) bits.push('Buy Box');
    return bits.join(' \u00b7 ');
  }

  function putOffer(id, o, absentLabel, absentWhy) {
    const el = $(id);
    if (!el) return;
    if (!o || o.landed == null) { setUnavailable(el, absentLabel, absentWhy); return; }
    el.textContent = fmt(o.landed);
    el.classList.remove('apx-sa-unknown');
    el.title = o.sellerName
      + (o.shipping > 0
          ? ' \u2014 ' + fmt(o.price) + ' plus ' + fmt(o.shipping) + ' delivery. The page '
            + 'shows only ' + fmt(o.price) + '; this is what it costs to receive.'
          : ' \u2014 delivered, no separate shipping charge.');
  }

  function renderOffers(o) {
    if (!o || !o.found) { renderSellersPending(); return; }

    const count = $('apx-sellers-count');
    if (count) {
      count.textContent = String(o.count);
      // Amazon's own hidden counter says "6 other options" -- the others,
      // excluding the pinned Buy Box offer. Reporting that as the number of
      // sellers is off by one on every ASIN, so the count here is the offers
      // actually read. The page's own "Competitors" figure up top comes from a
      // different element and CAN disagree; neither is reconciled into the
      // other, because a figure silently adjusted to match is not a reading.
      count.title = o.count + ' offers read from the open list'
        + (o.totalOthers != null ? '; the page\u2019s own counter says ' + o.totalOthers + ' besides the Buy Box' : '');
    }

    putOffer('apx-fba', o.fbaLow, 'none', 'No FBA offer in the open list.');
    putOffer('apx-fbm', o.fbmLow, 'none', 'No FBM offer in the open list.');
    // Amazon absent is an ANSWER about the competition, not a gap in the read.
    putOffer('apx-amz', o.amazon, 'not selling',
      'Amazon itself is not one of the offers on this page.');

    const list = $('apx-sellers-list');
    if (!list) return;
    list.textContent = '';
    for (const offer of o.offers) {
      const row = document.createElement('div');
      row.className = 'apx-sellers-row apx-k';
      // textContent, never innerHTML: a seller name is third-party text on a
      // page we do not control, and this panel runs inside the extension.
      row.textContent = offerLine(offer);
      if (offer.sellerId) row.title = 'Seller ' + offer.sellerId;
      list.appendChild(row);
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
    renderOffers(r.offers);
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

    // Lowest FBA, Lowest FBM and Amazon USED TO BE BLANKED HERE, and this
    // block ran AFTER renderOffers above -- so once the offers panel was
    // wired, three freshly-read prices were overwritten with "Not available
    // in this version" a few lines later. The read worked; the panel threw it
    // away. Only the swing is still unread, and it is unread for a different
    // reason, so it keeps its own message.
    //
    // "3M swing" is a PRICE-HISTORY figure -- the three-month spread -- not
    // the spread across today's offers. It sits beside the three offer cards
    // and belongs with the chart, which is why it was grouped wrongly here in
    // the first place.
    setUnavailable($('apx-swing'), NOT_IN_VERSION,
      'The three-month price spread needs the price-history series, which '
      + 'this version does not chart yet. It is not an offer-list figure.');

    // THE FALLBACK, and it must not run when the offer list is open.
    //
    // renderOffers() above already filled the rows and the count from the open
    // panel. This block ran unconditionally and a few lines later, so it wiped
    // seven parsed offers and replaced the count with the detail page's own
    // figure -- the same overwrite that hit Lowest FBA above, from a second
    // writer nobody had noticed. Two writers to one element is the bug; the
    // guard names which one owns it.
    //
    // When the list IS closed the page still knows the Buy Box owner and a
    // competitor count, so those are worth showing rather than a dash.
    const offersOpen = !!(r.offers && r.offers.found);
    if (!offersOpen) {
      const list = $('apx-sellers-list');
      if (list) {
        list.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'apx-sellers-empty apx-k';
        empty.textContent = r.buyBoxSeller && r.buyBoxSeller.found
          ? `Buy Box: ${r.buyBoxSeller.text} — open the offer list for the rest`
          : 'Offer list not open on this page.';
        empty.title = OFFERS_CLOSED_WHY;
        list.appendChild(empty);
      }
      // The page's own competitor count. It can DISAGREE with the number of
      // offers in the panel -- different elements, different inclusion rules --
      // and neither is adjusted to match the other, because a figure quietly
      // reconciled is not a reading of anything.
      const count = $('apx-sellers-count');
      if (count) count.textContent = r.sellerCount && r.sellerCount.found ? String(r.sellerCount.text) : '—';
    }

    // Dimensions are an SP-API catalogue field in the original.
    for (const id of ['apx-dims-pkg', 'apx-dims-pkg-wt', 'apx-dims-item', 'apx-dims-item-wt']) {
      setUnavailable($(id), NOT_IN_VERSION,
        'A catalogue field this build does not fetch.');
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
      if (intro) intro.textContent = 'Create an InventorySprint account. Reading product pages needs no Amazon connection, and no seller credentials.';
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
      // KEPT, because requestRank may not be allowed to run yet. The key
      // state arrives from the worker, which is a slower round trip than
      // this postMessage from the host, so on load the first reading lands
      // BEFORE hasKey is known. See the startup note at the foot of this
      // file: refreshKeepa replays this reading once it knows.
      lastReading = d.reading;

      renderNeedsAmazon();
      renderReading(d.reading);

      // renderNeedsAmazon has just blanked every provider-fed tile, so a
      // REREAD would otherwise throw away an answer already paid for and
      // NOT ask for it again -- rankFor still matches, so the request is
      // skipped. Re-applying the held answer is what makes a re-read free.
      if (lastRank) renderRank(lastRank);

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
  let lastReading = null;
  let lastRank = null;

  /**
   * The per-call diagnostic. Deliberately a plain sentence rather than a
   * status light: the thing being diagnosed is "did this call happen and
   * what did it cost", and a colour cannot say that.
   *
   * NEVER the key and never a token value read from it. The balance shown
   * here is the one Keepa reports for the account, which the footer already
   * shows; what is new is the COST of this one call.
   */
  function renderDiag(res) {
    const row = $('apx-diag-row');
    const el = $('apx-diag');
    if (!row || !el) return;

    const d = (res && res.diag) || null;
    if (!d) {
      // No diag at all means the answer did not come from the worker path
      // that carries one -- a worker fault, usually. Say that rather than
      // showing a blank line that looks like "nothing happened".
      const why = res && res.error ? String(res.error) : '';
      row.hidden = !why;
      el.textContent = why ? 'Lookup failed before it reached the worker — ' + why : '';
      el.title = why || '';
      return;
    }

    const bits = [];
    bits.push(d.asin + ' (' + (d.marketplace || 'US') + ')');

    // Whether the answer we PAID FOR carried the price/rank series. The
    // chart canvas has existed in panel.html all along with nothing drawing
    // to it, and summariseProduct dropped the arrays before the cache was
    // even written -- so this has been bought and binned on every lookup.
    // Reported as a shape so the caching decision rests on real sizes.
    const h = d.history;
    const histBit = !h ? null
      : (h.present
          ? 'history: ' + h.series + ' series, ' + h.points.toLocaleString()
            + ' pts, ~' + Math.round(h.bytes / 1024) + ' KB'
          : 'history: absent from the response');

    if (d.outcome === 'cached') {
      const mins = Number.isFinite(d.ageMs) ? Math.round(d.ageMs / 60000) : null;
      bits.push('cached' + (mins != null ? ' ' + mins + 'm ago' : '') + ', 0 tokens');
    } else if (d.outcome === 'skipped') {
      bits.push('skipped (' + (d.reason || 'guard') + '), 0 tokens');
    } else {
      bits.push('called');
      if (d.status != null) bits.push('HTTP ' + d.status);
      bits.push(Number.isFinite(d.tokensConsumed)
        ? d.tokensConsumed + ' token' + (d.tokensConsumed === 1 ? '' : 's')
        : 'cost not reported');
      if (Number.isFinite(d.callsThisMinute)) bits.push(d.callsThisMinute + '/3 this minute');
    }

    // The history note goes LAST but before any error, so the line still
    // leads with what the lookup cost.
    if (histBit) bits.push(histBit);

    if (d.error) bits.push('error: ' + d.error);

    row.hidden = false;
    el.textContent = bits.join(' · ');
    el.title = 'One line per data-provider lookup. 0 tokens means nothing was spent.';

    // Also to the console, where it can be read across a whole session
    // rather than only for the latest call.
    try { console.info('[InventorySprint Analyser] lookup', JSON.stringify(d)); } catch (_) {}
  }

  function renderRank(res) {
    lastRank = res || null;
    renderDiag(res);

    const bsr = $('apx-sa-bsr');
    const bsrTop = $('apx-bsr');
    const sales = $('apx-sa-sales');

    if (!res || !res.ok) {
      // A failure here must not overwrite a rank the PAGE already gave us.
      const why = (res && res.error) || 'Could not reach the data provider.';

      // The failure REPLACES the not-read label on every dependent tile.
      // Leaving them reading "Not read yet" after a call that failed is how
      // a provider error got mistaken for a token-burning loop: the panel
      // looked identical whether it had never called or had called and been
      // refused, so there was nothing to tell the two apart from outside.
      const short = (res && res.code === 'PAUSED') ? 'paused' : 'not available';
      for (const id of NEEDS_AMAZON) setUnavailable($(id), short, why);
      setUnavailable(sales, short, why);
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

    // THE BUG THIS GUARDS, AND WHY IT LOOKED LIKE THE OPPOSITE ONE.
    //
    // hasKey is set by refreshKeepa, which is a sendMessage round trip to
    // the service worker. The host answers READY with PAGE_READING over
    // postMessage in the same document. The second is always faster, so on
    // page load this returned here EVERY TIME and nothing re-triggered it:
    // no timer, no observer, nothing. The panel sat on "Not read yet"
    // forever and spent ZERO tokens.
    //
    // Reported on 2026-11-14 as a loop burning 46 tokens. It was the exact
    // inverse -- a call that never fired -- and the tiles could not say so
    // because "never asked" and "asked and refused" rendered identically.
    // The replay in refreshKeepa is the fix; this guard stays because a
    // keyless panel must still not call.
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
      // THREE different answers reach this one branch, and they used to
      // render identically as "Not read yet" -- which is how a provider that
      // returned half a fee answer looked the same as one that had not
      // replied at all.
      let label = LOADING;
      let why = 'Asking your data provider for this ASIN.';
      if (lastFees && !lastFees.found) {
        label = 'fees not returned';
        why = 'Your data provider did not return '
          + ((lastFees.missing || []).join(' or ') || 'the fee fields')
          + ' for this ASIN. A fee total built from one half is the exact '
          + 'understatement that turns a thin margin into a good-looking one, '
          + 'so nothing is shown instead.';
      } else if (lastFees && (sale == null || sale <= 0)) {
        label = 'no price on page';
        why = 'No sale price was read from this page, so there is nothing for '
          + 'fees to come out of.';
      }
      for (const id of ['apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-margin', 'apx-sa-maxcost']) {
        setUnavailable($(id), label, why);
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
    if (!slider) return;
    if (sale == null || fees == null) {
      // The one place two states are not enough. Fees still coming is
      // Loading; a page that shows a price RANGE instead of one price is
      // neither loading nor missing from the build -- it is a fact about
      // THIS page, so it says that and nothing more.
      const loading = fees == null;
      const label = loading ? LOADING : 'no single price';
      const why = loading
        ? 'Asking your data provider for the fee figures.'
        : 'This page shows a price range rather than one price, so there is '
          + 'no sale price to simulate from.';
      for (const id of ['apx-sim-sale', 'apx-sim-profit', 'apx-sim-roi']) {
        setUnavailable($(id), label, why);
      }
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
  //
  // READY is sent BEFORE this resolves, on purpose: everything read from
  // the page is free and should paint at once. What must not depend on the
  // ordering is the provider call, so the reading that arrived meanwhile is
  // replayed here, now that hasKey is actually known.
  refreshKeepa(() => {
    if (hasKey) refreshAuth(); else show('keepa');
    if (hasKey && lastReading) requestRank(lastReading);
  });
  toHost({ type: 'READY' });
})();
