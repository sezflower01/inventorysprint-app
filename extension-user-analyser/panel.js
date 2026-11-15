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
    // The gating read IS made now, from the user’s own Seller Central
    // session, so this is a first paint rather than a permanent absence.
    setUnavailable($('apx-sa-eligible'), LOADING,
      'Reading your own Seller Central session for this ASIN.');
    setUnavailable($('apx-sa-conditions'), LOADING,
      'Reading your own Seller Central session for this ASIN.');

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
      // THIS PARAGRAPH WENT STALE THE DAY GATING SHIPPED. It said "this
      // version does not make that read yet" and "your sign-in is not what is
      // missing" -- both true for weeks, both false now, and both still on
      // screen beside a row that was actively reading Seller Central. A
      // paragraph explaining why a feature is absent, printed under the
      // working feature, is the same fault as a label asserting a state
      // nothing checks: it teaches the reader to distrust the parts that are
      // right.
      //
      // It is first paint only -- the decision strip is still blank at this
      // point -- so it describes what is being read and what is not, without
      // claiming either way about the ASIN.
      why.textContent =
        'Eligibility comes from your own Amazon Seller Central session in this '
        + 'browser, while you are signed in to it — no account connection, and no '
        + 'seller credentials. If it says you are not signed in, signing in there '
        + 'and pressing Recheck is the fix. Private-label risk is not assessed in '
        + 'this version. Everything else was read from this page or from your own '
        + 'data provider key.';
    }
    const fd = $('apx-final-decision');
    if (fd) { fd.className = 'apx-final-decision unknown'; }

    // Says only what is true: the chart is not drawn. The old wording blamed
    // missing provider data, which stopped being the reason once the provider
    // was answering -- and it sat directly under a rank the panel had read.
    // The chart IS drawn now, from the series that ride in on the product
    // lookup, so this is a first paint rather than a permanent absence.
    setUnavailable($('apx-history-verdict'), LOADING,
      'Waiting on your data provider for the price history.');
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
  const OFFERS_CLOSED_TEXT = 'Open See All Buying Options to read offers';
  const OFFERS_CLOSED_WHY =
    OFFERS_CLOSED_TEXT + '. It is read from the page in your own browser -- no '
    + 'seller account, no credentials, and no provider tokens. Press Recheck '
    + 'after opening it.';

  function renderSellersPending() {
    const count = $('apx-sellers-count');
    if (count) { count.textContent = '—'; count.title = OFFERS_CLOSED_WHY; }
    const list = $('apx-sellers-list');
    if (list) {
      list.textContent = '';
      const d = document.createElement('div');
      d.className = 'apx-sellers-empty apx-k';
      d.textContent = OFFERS_CLOSED_TEXT;
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
  // Amazon host per marketplace, for the storefront link. Built from the
  // marketplace rather than from the sold-by href, which is RELATIVE on the
  // page -- resolving it correctly depends on where the panel thinks it is,
  // and the panel is an extension page, not amazon.com.
  // US, Canada, Mexico and Brazil: the account’s marketplaces and no others.
  // This listed ten; six of them were for countries this account does not
  // sell in, and all nine non-US entries were unreachable because the
  // marketplace is always the literal 'US'.
  //
  // Only the US host is reachable today. The other three are listed so the
  // storefront link is correct the day the injection list grows, and because
  // a half-written map is worse than a complete small one.
  const AMZ_HOST = {
    US: 'www.amazon.com',
    CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', BR: 'www.amazon.com.br',
  };

  function storefrontUrl(sellerId, marketplace) {
    if (!sellerId) return null;
    const host = AMZ_HOST[String(marketplace || 'US').toUpperCase()] || AMZ_HOST.US;
    return 'https://' + host + '/sp?ie=UTF8&seller=' + encodeURIComponent(sellerId);
  }

  // ROI AT SOMEONE ELSE’S PRICE: what this listing would return if you
  // matched that offer. It is the figure that makes an offer list a sourcing
  // tool rather than a price list -- $82 from a rival is only interesting
  // next to what you would earn there.
  //
  // Needs your cost AND both fee halves. Any of them missing and there is no
  // percentage at all: an ROI with a guessed cost or half a fee is the
  // understatement this repo has already shipped once.
  //
  // For an FBM rival the price used is their LANDED cost, delivery included,
  // because that is the number you would have to match to win the sale. The
  // fee side is always YOURS -- your referral rate and, unless you sell FBM,
  // your fulfilment fee. It answers "what would I make there", not "what are
  // they making".
  // THE CLOSING FEE APPLIES EVERYWHERE OR IT IS WORSE THAN NOWHERE.
//
  // Amazon charges a flat per-item closing fee on media -- books, DVDs,
  // music, games -- and the provider exposes it separately from the pick &
  // pack fee, which is why the panel was omitting it entirely. On a book that
  // understated the fees and therefore inflated Profit, ROI, Margin and the
  // Max Cost the panel AUTHORISES: the direction that loses money.
  //
  // There were FOUR places computing a fee total independently -- the tile,
  // the simulator, the slider and the per-offer ROI column. Adding it to
  // three of them would have been the worst outcome of all: two figures from
  // the same inputs disagreeing, with nothing to say which was right. One
  // function now, used by all four.
  //
  // It is charged on FBM too. The closing fee is a referral-side charge, not
  // a fulfilment one, so unlike the pick & pack fee it does not vanish when
  // the seller ships the item themselves.
  function feesAt(price, isFbm) {
    if (!lastFees || !lastFees.found || price == null) return null;
    const referral = price * (lastFees.referralPct / 100);
    const fulfil = isFbm ? 0 : lastFees.fbaFee;
    const closing = lastFees.closingFee || 0;
    return { referral, fulfil, closing, total: referral + fulfil + closing };
  }

  function offerRoi(landed) {
    if (landed == null) return null;
    if (!lastFees || !lastFees.found) return null;
    const cost = money($('apx-cost') && $('apx-cost').value);
    if (cost == null || cost <= 0) return null;
    const mode = ($('apx-seller-mode') && $('apx-seller-mode').value) || 'FBA';
    const f = feesAt(landed, /fbm/i.test(String(mode)));
    if (!f) return null;
    return ((landed - f.total - cost) / cost) * 100;
  }

  /**
   * How much of it that seller has, for the price tooltip.
   *
   * The row format has four columns and no stock one, so this would otherwise
   * be dropped -- and it is the field that says whether a rival at $64.97 is
   * one unit or thirty. 30 is Amazon's cap, not a count, so it reads "30 or
   * more" and never an exact figure.
   */
  function stockPhrase(o) {
    if (o.maxQty == null) return null;
    return o.maxQty >= 30 && o.maxQtyIsCap
      ? '30 or more in stock'
      : o.maxQty + (o.maxQty === 1 ? ' unit' : ' units') + ' in stock';
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

  // The drawer is built asynchronously, so this renders THREE states. The
  // middle one is the reason it is not a boolean: Amazon paints the pinned
  // offer and the counter first and fetches the rest after, so a read taken
  // in that window legitimately sees one offer out of seven. Showing
  // "Lowest FBA $64.97" from that partial list would put a number on screen
  // that silently changes a second later, with nothing to tell the user it
  // had -- so the half-built state says Loading and shows no figures.
  // THE DRAWER IS OPEN AND NOTHING WAS READ. Two causes, and they are not
  // interchangeable: an empty container is a timing matter the user fixes
  // with Recheck, while offer blocks that refuse to parse are Amazon having
  // moved the markup -- which no amount of Rechecking will fix and which the
  // user should be able to report rather than fight.
  //
  // Neither says "Loading". Nothing is loading: this panel reads the page
  // once, on open and on Recheck, and has no observer watching for more.
  // A spinner here was a promise the code could not keep, and it kept it for
  // as long as the user was willing to stare at it.
  function renderOffersUnread(o) {
    const unreadable = o.state === 'unreadable';
    const label = unreadable ? "can't read the list" : 'list is empty';
    const why = unreadable
      ? 'The offer list is open and ' + o.blocks + ' offer'
        + (o.blocks === 1 ? '' : 's') + ' are in it, but none could be read. '
        + 'Amazon has probably changed the markup \u2014 Recheck will not help. '
        + 'The console line beginning \u201coffers\u201d has the details to report.'
      : 'The offer list is open but has no offers in it yet. Press Recheck.';

    for (const id of ['apx-fba', 'apx-fbm', 'apx-amz']) setUnavailable($(id), label, why);
    const count = $('apx-sellers-count');
    if (count) { count.textContent = '\u2014'; count.title = why; }
    const list = $('apx-sellers-list');
    if (list) {
      list.textContent = '';
      const d = document.createElement('div');
      d.className = 'apx-sellers-empty apx-k';
      d.textContent = why;
      list.appendChild(d);
    }
  }

  // ── dimensions and weight ───────────────────────────────────────────────
  //
  // The provider answers in millimetres and grams. Shown in the unit the
  // marketplace actually sells in, ALWAYS with the unit printed, because a
  // bare "12.6 x 9.1 x 3.1" beside a US fee calculation reads as inches to a
  // US seller and as centimetres to a European one, and those differ by 2.5x.
  // The provider's own figures stay in the tooltip so the conversion can be
  // checked rather than trusted.
  // ⚠️ ALL FOUR ARE MARKED IMPERIAL AND ONLY THE US ONE IS VERIFIED.
  //
  // Amazon US lists inches and pounds. Canada, Mexico and Brazil are each
  // metric countries whose Amazon sites may well show centimetres and
  // kilograms -- this map asserts otherwise for all three on no evidence,
  // which is exactly the kind of plausible-looking wrongness the unit suffix
  // was added to prevent. It is harmless today because nothing but US is
  // reachable, and it must be CHECKED on a real page in each country before
  // that changes rather than trusted because it is written down.
  const IMPERIAL = { US: true, CA: true, MX: true, BR: true };

  function renderDims(dims, marketplace) {
    const src = $('apx-dims-source');
    const imperial = !!IMPERIAL[String(marketplace || 'US').toUpperCase()];

    const show = (dimId, wtId, set, what) => {
      const dEl = $(dimId);
      const wEl = $(wtId);
      if (!set || (!set.mm && set.grams == null)) {
        const why = 'Your data provider returned no ' + what + ' for this ASIN.';
        setUnavailable(dEl, 'not returned', why);
        setUnavailable(wEl, 'not returned', why);
        return;
      }
      if (set.mm && dEl) {
        const n = imperial ? set.mm.map((x) => x / 25.4) : set.mm.map((x) => x / 10);
        dEl.textContent = n.map((x) => x.toFixed(1)).join(' \u00d7 ') + (imperial ? ' in' : ' cm');
        dEl.classList.remove('apx-sa-unknown');
        dEl.title = 'Provider figures: ' + set.mm.join(' \u00d7 ') + ' mm.';
      } else {
        setUnavailable(dEl, 'not returned',
          'Your data provider returned no ' + what + ' dimensions for this ASIN.');
      }
      if (set.grams != null && wEl) {
        wEl.textContent = imperial
          ? (set.grams / 453.59237).toFixed(2) + ' lb'
          : (set.grams / 1000).toFixed(3) + ' kg';
        wEl.classList.remove('apx-sa-unknown');
        // NO DIMENSIONAL WEIGHT. Amazon bills bulky items on dimensional
        // weight and this is the actual weight; saying so stops the figure
        // being read as a fee input.
        wEl.title = 'Provider figure: ' + set.grams + ' g. This is ACTUAL weight. '
          + 'Amazon bills bulky items on dimensional weight, so do not use this '
          + 'to work out a fulfilment fee.';
      } else {
        setUnavailable(wEl, 'not returned',
          'Your data provider returned no ' + what + ' weight for this ASIN.');
      }
    };

    if (!dims) {
      for (const id of ['apx-dims-pkg', 'apx-dims-pkg-wt', 'apx-dims-item', 'apx-dims-item-wt']) {
        setUnavailable($(id), LOADING, 'Asking your data provider for this ASIN.');
      }
      if (src) src.textContent = '\u2014';
      return;
    }
    show('apx-dims-pkg', 'apx-dims-pkg-wt', dims.pkg, 'package');
    show('apx-dims-item', 'apx-dims-item-wt', dims.item, 'item');
    if (src) {
      const any = (dims.keysSeen || []).length;
      src.textContent = any ? 'from your data provider' : '\u2014';
      src.title = any
        ? any + ' of 8 dimension fields were returned for this ASIN.'
        : 'No dimension field was returned for this ASIN.';
    }
  }

  // ── the price-history chart ──────────────────────────────────────────────
  //
  // THE STRIDE WAS MEASURED, NOT ASSUMED. The provider stores some series as
  // [time, value] pairs and the ones carrying shipping as
  // [time, value, shipping] triples, and a chart drawn on the wrong stride
  // looks entirely plausible and is wrong -- the failure this repo keeps
  // meeting. The live lengths were 100 and 434: both divisible by 2, neither
  // by 3, which proves pairs. No triple-stride series appeared at all.
  //
  // THREE OF THE FOUR LEGEND SERIES WERE ABSENT from that response -- Buy Box,
  // FBA and FBM are offer-derived and this build does not request offers. So
  // the chart draws the series that exist and the legend greys the ones that
  // do not, with the reason on hover. Relabelling the New price as "Buy Box"
  // would have produced a chart that looked right and lied.
  const SERIES_COLOUR = {
    18: '#34d399', 0: '#f97316', 10: '#60a5fa', 7: '#a78bfa', 1: '#e879f9',
  };

  // The provider counts minutes from its own epoch. Converted here rather
  // than in the worker so the stored form stays narrow, and the decoded span
  // is printed on the diagnostic line so this constant is CHECKED against a
  // real answer instead of trusted: a 2026 product whose history starts in
  // 2011 means this number is wrong.
  const PROVIDER_EPOCH_MIN = 21564000;
  const toMs = (min) => (min + PROVIDER_EPOCH_MIN) * 60000;

  let historyRangeDays = 90;

  function seriesInRange(series, days) {
    const now = Date.now();
    const from = days === 'SINCE_LISTED' ? 0 : now - days * 86400000;
    const out = [];
    for (const sr of series) {
      const pts = sr.points
        .map(([t, v]) => [toMs(t), v / 100])
        .filter(([ms]) => ms >= from && ms <= now + 86400000);
      if (pts.length) out.push({ index: sr.index, label: sr.label, points: pts });
    }
    return out;
  }

  // The 90-day spread, from the same series the chart draws. Fixed at three
  // months whatever range the chart is showing, because the tile is labelled
  // "3M swing" and a figure that silently followed the tab would contradict
  // its own label.
  function renderSwing(all) {
    const el = $('apx-swing');
    if (!el) return;
    const pick = seriesInRange(all || [], 90);
    const main = pick.find((x) => x.index === 18) || pick.find((x) => x.index === 1) || null;
    if (!main || main.points.length < 2) {
      setUnavailable(el, 'not enough history',
        'Fewer than two price points in the last 90 days, so there is no spread '
        + 'to report.');
      return;
    }
    const vals = main.points.map((p) => p[1]);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    el.textContent = fmt(hi - lo);
    el.classList.remove('apx-sa-unknown');
    el.title = main.label + ' ranged ' + fmt(lo) + ' to ' + fmt(hi)
      + ' over the last 90 days, across ' + main.points.length + ' price points.';
  }

  function renderHistory(history) {
    const cv = $('apx-history-chart');
    const verdict = $('apx-history-verdict');
    const all = (history && Array.isArray(history.series_data)) ? history.series_data : null;

    // THE LEGEND DESCRIBES WHAT IS ON THE CANVAS, which is not the same as
    // what the provider returned.
    //
    // The first version greyed an entry only when the series was missing from
    // the response, so Amazon showed as present with one data point 200 days
    // old while the chart was on its 3-month range and drew no Amazon line at
    // all. A legend entry for a line that is not there sends the viewer
    // looking for it and makes them doubt the lines that ARE there.
    //
    // Three distinct reasons, because they want different responses: a longer
    // range, a different build, or nothing.
    const legendFor = (drawn) => {
      for (const el of document.querySelectorAll('.apx-hl-item')) {
        const idx = Number(el.getAttribute('data-series'));
        const sr = all ? all.find((x) => x.index === idx) : null;
        const inData = !!(sr && sr.points.length);
        const inView = !!(drawn && drawn.some((x) => x.index === idx));
        el.classList.toggle('apx-hl-absent', !inView);
        el.title = inView
          ? sr.points.length + (sr.points.length === 1 ? ' point' : ' points')
            + ' from your data provider.'
          : inData
            // Present but outside the selected range: a longer range shows it.
            ? 'Your data provider has ' + sr.points.length + ' point'
              + (sr.points.length === 1 ? '' : 's') + ' for this series, none of '
              + 'them inside the range selected. Try a longer one.'
            : (idx === 18 || idx === 10 || idx === 7
                ? 'Your data provider returns this series only with offer data, '
                  + 'which this version does not request \u2014 it costs extra tokens.'
                : 'Your data provider returned no history for this series.');
      }
    };
    legendFor(null);

    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);

    if (!all) {
      if (verdict) {
        setUnavailable(verdict, LOADING,
          'Waiting on your data provider for the price history.');
      }
      return;
    }

    const shown = seriesInRange(all, historyRangeDays);
    // Now that the drawn set is known, the legend can describe it.
    legendFor(shown);
    if (!shown.length) {
      if (verdict) {
        const anyAtAll = all.some((x) => x.points.length);
        setUnavailable(verdict, anyAtAll ? 'nothing in this range' : 'no history returned',
          anyAtAll
            ? 'Your data provider has history for this ASIN, but none inside the '
              + 'range selected. Try a longer one.'
            : 'Your data provider returned no price history for this ASIN.');
      }
      return;
    }

    // Bounds across every drawn series, so they share one scale and can be
    // compared by eye. A per-series scale would make the cheapest line look
    // the same as the dearest.
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const sr of shown) {
      for (const [t, v] of sr.points) {
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
    }
    // A flat series has zero span, and dividing by it puts every point on one
    // edge or produces NaN coordinates that silently draw nothing.
    const tSpan = tMax - tMin || 1;
    const vPad = (vMax - vMin) * 0.1 || Math.max(vMax * 0.05, 0.5);
    const lo = Math.max(0, vMin - vPad);
    const hi = vMax + vPad;
    const vSpan = hi - lo || 1;
    const PAD = { l: 34, r: 6, t: 8, b: 16 };
    const px = (t) => PAD.l + ((t - tMin) / tSpan) * (W - PAD.l - PAD.r);
    const py = (v) => H - PAD.b - ((v - lo) / vSpan) * (H - PAD.t - PAD.b);

    // Axis labels: cheapest and dearest, which are the two numbers anyone
    // reads off a price chart.
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.fillText('$' + hi.toFixed(2), 2, PAD.t + 7);
    ctx.fillText('$' + lo.toFixed(2), 2, H - PAD.b);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, PAD.t);
    ctx.lineTo(PAD.l, H - PAD.b);
    ctx.lineTo(W - PAD.r, H - PAD.b);
    ctx.stroke();

    for (const sr of shown) {
      ctx.strokeStyle = SERIES_COLOUR[sr.index] || '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // A STEP line, not a sloped one. These are price CHANGES: the price
      // held flat between two points and did not drift linearly towards the
      // next one, and a sloped line claims movement that never happened.
      let started = false;
      let prevY = 0;
      for (const [t, v] of sr.points) {
        const x = px(t);
        const y = py(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
        prevY = y;
      }
      // Carry the last price to the right edge: it is still in force.
      if (started) ctx.lineTo(W - PAD.r, prevY);
      ctx.stroke();
    }

    renderSwing(all);

    // The verdict says only what the drawn series support.
    if (verdict) {
      const main = shown.find((x) => x.index === 18) || shown.find((x) => x.index === 1) || shown[0];
      const vals = main.points.map((p) => p[1]);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const days = Math.max(1, Math.round((tMax - tMin) / 86400000));
      verdict.textContent = main.label + ' ' + fmt(min) + '\u2013' + fmt(max)
        + ' over ' + days + (days === 1 ? ' day' : ' days');
      verdict.classList.remove('apx-sa-unknown');
      verdict.title = main.points.length + ' price points, ' + main.label
        + '. The flat steps are real: a price holds until it changes.';
    }
  }
  // ── listing eligibility, from the user’s own Seller Central session ─────
  //
  // THE RULE THAT OUTRANKS THE OTHERS HERE: a false "eligible" sends the user
  // to buy stock they cannot sell; a false "could not read this" costs them
  // one click. So every state that is not an explicit, well-formed "new is
  // not restricted" renders as something other than eligible, and the chip
  // never carries the good colour on a doubt.
  //
  // Requested on panel open and Recheck only -- the same two triggers as the
  // page read, because PAGE_READING is the only thing that calls this. There
  // is no timer and no observer, so it cannot run unattended against the
  // user’s own logged-in account.
  let gatingFor = null;
  // THE ANSWER IS HELD, for the same reason lastRank is.
  //
  // renderNeedsAmazon() blanks both gating chips to Loading on every page
  // read, and requestGating then returns early because the ASIN has not
  // changed -- so a Recheck wiped a working “Eligible — new” and never put it
  // back. Seen live: the verdict on page load, Loading for ever after
  // pressing Recheck.
  //
  // This is the identical bug that was fixed for the provider answer, in the
  // identical way, and I did not carry the fix across at the time. Holding
  // the last answer is what makes a re-read free rather than destructive.
  let lastGating = null;

  function setChip(el, text, cls, why) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(...VERDICT_CLASSES);
    el.classList.toggle('apx-sa-unknown', !cls);
    if (cls) el.classList.add(cls);
    el.title = why || '';
  }

  /** Asked for by name, so no accidental falsy value can claim it. */
  const PENDING = Symbol('gating-pending');

  function renderGating(res) {
    const chip = $('apx-sa-eligible');
    const others = $('apx-sa-conditions');
    const pill = $('apx-elig');

    // IN FLIGHT AND GOT-NOTHING USED TO BE THE SAME BRANCH, and that is how
    // the chip stalled on “Loading…”. renderGating(null) painted the
    // in-flight state, so ANY falsy answer painted it too -- and a worker
    // that replies with no value at all hands the callback `undefined`,
    // which landed here and claimed the read was still running. For ever.
    //
    // A pending state is now something only the caller can ask for, by name.
    // Anything falsy arriving from the worker is an answer that said nothing,
    // which is a failure and must look like one.
    if (res === PENDING) {
      setUnavailable(chip, LOADING,
        'Reading your own Seller Central session for this ASIN.');
      setUnavailable(others, LOADING, 'Reading your own Seller Central session.');
      return;
    }
    if (!res) {
      res = { ok: false, state: 'no_answer',
        error: 'The worker replied with no answer at all.' };
    }

    // The three states that are NOT a verdict, each with the one action that
    // changes it. None of them is "eligible" and none is a colour.
    if (!res.ok) {
      const map = {
        signed_out: ['Sign in to Seller Central',
          res.error || 'Sign in to Seller Central in this browser, then press Recheck.'],
        paused: ['paused', res.error || 'Paused to protect your Seller Central session.'],
        unsupported_market: ['US only in this version',
          res.error || 'This version reads listing eligibility for the US marketplace only.'],
        // The deadline fired, or the context was invalidated. Both mean the
        // extension’s own worker did not answer, which the user fixes in one
        // place -- and which is NOT a statement about the ASIN.
        no_answer: ['no answer from the extension',
          'The extension\u2019s background worker did not reply. Reload the extension '
          + 'on chrome://extensions, then reload this page and press Recheck. '
          + (res.error ? '(' + res.error + ') ' : '')
          + 'This says nothing about whether you may list the ASIN.'],
      };
      const [text, why] = map[res.state] || ['couldn\u2019t read this',
        (res.error || 'Seller Central returned something this version does not '
          + 'recognise.') + ' Nothing here means you may list it \u2014 it means the '
          + 'answer could not be read.'];
      setUnavailable(chip, text, why);
      setUnavailable(others, text, why);
      if (pill) {
        pill.textContent = res.state === 'signed_out' ? 'Not signed in' : 'Not checked';
        pill.classList.remove(...VERDICT_CLASSES);
        pill.classList.add('apx-sa-unknown');
        pill.title = why;
      }
      return;
    }

    // THE PANEL DOES NOT TRUST THE SHAPE EITHER, and this was a real hole.
    //
    // parseGating cannot produce an ok:true without a boolean verdict and a
    // conditions array -- but the panel receives whatever the worker sends,
    // and a bare {ok:true} from some path nobody considered rendered as
    // "Restricted — new" with the bad colour on it. A test harness that
    // answered every message with a generic success found it; a worker
    // refactor would have found it in front of a user.
    //
    // The expensive error is a confident verdict built on an answer nobody
    // checked, so the shape is checked here as well as there.
    if (typeof res.eligibleNew !== 'boolean' || !Array.isArray(res.conditions)) {
      const why = 'The eligibility answer came back in a shape this version does '
        + 'not recognise, so it is not being shown. This does NOT mean you may '
        + 'list it.';
      setUnavailable(chip, 'couldn’t read this', why);
      setUnavailable(others, 'couldn’t read this', why);
      if (pill) {
        pill.textContent = 'Not checked';
        pill.classList.remove(...VERDICT_CLASSES);
        pill.classList.add('apx-sa-unknown');
        pill.title = why;
      }
      return;
    }

    // The verdict, and ONLY for the condition the user sells in.
    const cached = res.cached ? ' (cached)' : '';
    if (res.eligibleNew) {
      setChip(chip, 'Eligible \u2014 new', 'apx-sa-good',
        'Your Seller Central session says new is not restricted for you on this '
        + 'ASIN.' + cached);
    } else {
      setChip(chip, 'Restricted \u2014 new', 'apx-sa-bad',
        (res.newMessage || 'Your Seller Central session says you cannot list this '
          + 'ASIN as new.') + cached);
    }

    // The other three, SEPARATELY. Folding them into the verdict would have
    // reported the recorded ASIN as restricted when the condition that
    // matters was open.
    const rest = res.conditions.filter((c) => c.key !== 'new');
    const open = rest.filter((c) => !c.restricted).map((c) => c.key);
    const shut = rest.filter((c) => c.restricted).map((c) => c.key);
    setChip(others,
      open.length ? open.join(', ') + ' open' : 'all restricted',
      null,
      (open.length ? 'Also listable: ' + open.join(', ') + '. ' : '')
      + (shut.length ? 'Restricted: ' + shut.join(', ') + '. ' : '')
      + (rest.find((c) => c.message) ? rest.find((c) => c.message).message : ''));

    if (pill) {
      pill.textContent = res.eligibleNew ? 'Can list (new)' : 'Restricted (new)';
      pill.classList.remove(...VERDICT_CLASSES);
      pill.classList.remove('apx-sa-unknown');
      pill.classList.add(res.eligibleNew ? 'apx-sa-good' : 'apx-sa-bad');
      pill.title = (res.productType ? 'Product type ' + res.productType + '. ' : '')
        + 'Read from your own Seller Central session. Seller Central reports '
        + (res.offerCount != null ? res.offerCount + ' offers' : 'no offer count')
        + (res.lowestPrice ? ' from ' + res.lowestPrice : '') + '.';
    }
  }

  // HOW LONG THE PANEL MAY SAY "LOADING", which is a question I had already
  // answered once and then got wrong again.
  //
  // The offers drawer used to sit on "Loading..." for ever, and the fix was
  // that a state nothing can resolve must not be shown as progress. Then
  // this function introduced a loading state with a round trip behind it --
  // and a round trip that never returns is the same dead end. It happened on
  // a real page: "Eligible to list: Loading..." with nothing coming.
  //
  // THE CALLBACK CAN GENUINELY NEVER FIRE. If the service worker fails to
  // evaluate -- an importScripts error, or the extension reloaded under a
  // page that is still open -- Chrome may drop the message with no callback
  // and no lastError at all. Nothing in the panel finds out.
  //
  // So: a DEADLINE. It changes a label and nothing else. It does not retry,
  // does not re-request, and cannot spend a token or touch the user’s Seller
  // Central session -- the one thing a timer in this extension must never
  // do. A test holds that line.
  const GATING_DEADLINE_MS = 8000;

  function requestGating(reading) {
    const asin = reading && reading.asin && reading.asin.found ? reading.asin.value : null;
    if (!asin) return;
    const mkt = (reading && reading.marketplace) || 'US';
    const tag = mkt + ':' + asin;
    // One request per ASIN per panel session. The worker caches and caps on
    // top of this; this just stops a re-render asking again for an answer
    // already on screen.
    if (gatingFor === tag) return;
    gatingFor = tag;
    renderGating(PENDING);

    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try {
        console.info('[InventorySprint Analyser] gating', JSON.stringify({
          asin: asin, marketplace: mkt,
          state: (res && res.state) || null, ok: !!(res && res.ok),
          cached: !!(res && res.cached),
          // Never the ASIN-bearing URL and never the response body: this
          // line is about whether the read happened, not what it said.
          error: (res && res.error) || null,
        }));
      } catch (_) {}
      // Held so the next page read can re-apply it instead of discarding it.
      // Only a real answer is kept: a transport failure must not be replayed
      // as though it were a verdict about the ASIN.
      if (res && res.ok) lastGating = res;
      renderGating(res);
    };

    // A DEADLINE, not a retry. Changes the label and stops.
    const deadline = setTimeout(() => {
      finish({ ok: false, state: 'no_answer' });
    }, GATING_DEADLINE_MS);

    const reply = (res) => {
      clearTimeout(deadline);
      if (chrome.runtime.lastError) {
        finish({ ok: false, state: 'no_answer',
          error: chrome.runtime.lastError.message || null });
        return;
      }
      finish(res);
    };

    try {
      chrome.runtime.sendMessage({ type: 'ISUA_GATING', asin: asin, marketplace: mkt }, reply);
    } catch (e) {
      // sendMessage THROWS SYNCHRONOUSLY when the extension context has been
      // invalidated -- which is what happens to a panel still open in a tab
      // after the extension is reloaded. Unhandled, it aborted this function
      // one line after painting "Loading", and left it there.
      clearTimeout(deadline);
      finish({ ok: false, state: 'no_answer', error: (e && e.message) || String(e) });
    }
  }
  function renderOffers(o) {
    if (!o) { renderSellersPending(); return; }
    // Always logged, successful or not: when the offer list does not render,
    // the first question is whether the container was there and how many
    // blocks were in it, and that is not answerable from the panel alone.
    try {
      console.info('[InventorySprint Analyser] offers', JSON.stringify({
        state: o.state, blocks: o.blocks, parsed: o.count,
        counterSays: o.totalOthers, complete: o.complete,
        // WHERE the offers were looked for. The page can carry an empty
        // #all-offers-display ahead of the populated one, and reading the
        // wrong one reported an empty drawer while seven offers were on
        // screen. panels > 1 or scopedTo "document" means the page is not the
        // shape the fixtures assume, which is worth seeing before it breaks.
        panels: o.panels, scopedTo: o.scopedTo,
      }));
    } catch (_) {}
    if (o.state === 'unreadable' || o.state === 'empty') { renderOffersUnread(o); return; }
    if (!o.found) { renderSellersPending(); return; }

    // EXCLUDE THE USER’S OWN OFFER FROM THE COMPETITIVE FIGURES.
    //
    // This is the extension-side half of a bug the repricer already had:
    // holding the Buy Box read as "already lowest among eligible
    // competitors", so the price shadowed itself downwards for months. The
    // lowest offer being YOURS is not a price you have to beat.
    //
    // It is ALWAYS SHOWN, never silently dropped. A stale or mistyped id
    // would hide a real rival, and a figure that quietly excludes something
    // is indistinguishable from a wrong one.
    //
    // Declared up here rather than beside its first use: the competitor count
    // a few lines down reads `others`, and with the block further on this
    // threw a temporal-dead-zone ReferenceError that killed the whole render.
    // The panel then kept the previous "not open" labels and looked, exactly,
    // like a drawer that had never opened.
    const mine = mySellerId
      ? o.offers.find((x) => x.sellerId === mySellerId) || null
      : null;
    // TWO EXCLUSIONS, and both have to be here or the panel contradicts the
    // reader. The reader already drops non-new offers from its own lowest-
    // price figures; if the panel then recomputed over every offer to take
    // out the user’s own, it would quietly put the used ones back.
    const competing = o.offers.filter((x) => x.isNew !== false);
    const others = mine ? competing.filter((x) => x !== mine) : competing;
    const cheapestOf = (list) => list.reduce(
      (best, x) => (x.landed != null && (!best || x.landed < best.landed) ? x : best), null);
    const rivalFba = cheapestOf(others.filter((x) => x.fba === true));
    const rivalFbm = cheapestOf(others.filter((x) => x.fba === false));

    const count = $('apx-sellers-count');
    if (count) {
      count.textContent = String(o.count);
      // Amazon's own hidden counter says "6 other options" -- the others,
      // excluding the pinned Buy Box offer. Reporting that as the number of
      // sellers is off by one on every ASIN, so the count here is the offers
      // actually read. The page's own "Competitors" figure up top comes from a
      // different element and CAN disagree; neither is reconciled into the
      // other, because a figure silently adjusted to match is not a reading.
      // The FBA/FBM split belongs in the tooltip, not a fourth card: it is
      // what a seller is actually deciding against. The two need not add up
      // to the total -- an offer whose sold-by link carries no
      // isAmazonFulfilled counts towards neither, and is left visible as a
      // shortfall rather than quietly filed under FBM.
      // The number shown is COMPETITORS, so the user’s own offer comes out
      // of it. The total is kept in the tooltip, because a count that
      // dropped from 7 to 6 with no explanation is a bug report.
      // "0 of 39" WAS TWO DIFFERENT BASES SIDE BY SIDE, and on a book it
      // read as nonsense: zero new-condition competitors that are not the
      // user's own, against thirty-nine offers of every condition including
      // theirs. Eleven rows were visible underneath. A reader cannot
      // reconcile those two numbers because they are not answers to the same
      // question, and the honest fix is to stop printing them as a ratio.
      //
      // The headline is the competitor count. "so far" rather than "live"
      // when the drawer is still withholding offers, because a count that
      // quietly means "of what has loaded" is a count nobody can act on --
      // and the tooltip below spells out every base.
      count.textContent = others.length
        + (o.complete ? ' live' : ' so far')
        + (mine ? ' + you' : '');
      const split = o.fbaCount + ' FBA, ' + o.fbmCount + ' FBM';
      const unknown = o.newCount - o.fbaCount - o.fbmCount;
      // WHAT THE NUMBER COUNTS, said explicitly, because it is now two
      // subtractions away from the offers on screen: the used ones and your
      // own. A count that quietly differs from the visible rows is a bug
      // report waiting to happen.
      count.title = o.count + ' offers read from the open list'
        + (o.excludedByCondition
            ? ', ' + o.excludedByCondition + ' of them not new condition and left out of these figures'
            : '')
        + (o.conditionUnknown
            ? ', ' + o.conditionUnknown + ' with no condition shown (counted anyway)'
            : '')
        + (mine ? ', one of them yours' : '') + ' \u2014 ' + split
        + (unknown > 0 ? ', ' + unknown + ' with no fulfilment stated' : '')
        + (o.amazonSold ? '. Amazon is one of them.' : '. Amazon is not selling this.')
        // Safe to state as a total HERE, where there is room to say what it
        // counts. It is not safe beside the competitor figure, which is why
        // the headline no longer prints them as a ratio.
        + (o.totalOthers != null
            ? ' The page\u2019s own counter says ' + o.totalOthers
              + ' offers besides the Buy Box, of every condition.'
            : '');
    }

    // A "none" MEANS LESS WHEN OFFERS ARE STILL HIDDEN. The drawer is sorted
    // cheapest-first, so the LOWEST figures are trustworthy from a partial
    // list -- what is missing is the expensive end. A "none", though, is a
    // claim about offers nobody has looked at yet.
    const partly = !o.complete ? ' in the ' + o.count + ' offers loaded so far' : '';
    // "but your own" only when your own offer IS of that kind. It read "No FBM
    // offer but your own" on an ASIN where the user's offer is FBA -- true of
    // the list and false of the sentence, and the sort of wrongness that makes
    // a reader stop trusting the lines that are right.
    const noneWhy = (kind, isKind) => 'No ' + kind + ' offer'
      + (mine && isKind ? ' but your own' : '') + (partly || ' in the open list')
      + (partly ? ' \u2014 click \u201cSee more options\u201d on the page, then Recheck.' : '.');
    putOffer('apx-fba', rivalFba, partly ? 'none yet' : 'none',
      noneWhy('FBA', mine && mine.fba === true));
    putOffer('apx-fbm', rivalFbm, partly ? 'none yet' : 'none',
      noneWhy('FBM', mine && mine.fba === false));
    if (mine) {
      for (const [id, rival] of [['apx-fba', rivalFba], ['apx-fbm', rivalFbm]]) {
        const el = $(id);
        if (el && rival) {
          el.title = (el.title || '') + ' Your own offer at ' + fmt(mine.landed)
            + ' is excluded from this figure.';
        }
      }
    }
    // Amazon absent is an ANSWER about the competition, not a gap in the read.
    putOffer('apx-amz', o.amazon, 'not selling',
      'Amazon itself is not one of the offers on this page.');

    const list = $('apx-sellers-list');
    if (!list) return;
    list.textContent = '';
    // THE ROW FORMAT IS THE ANALYZER’S, and its CSS was already in
    // panel.css -- .apx-seller-row, .apx-seller-tag.self for YOU,
    // .apx-seller-roi with its colour bands -- ported with the stylesheet
    // and never built against. The markup contract was therefore already
    // decided; this follows it rather than inventing a second one.
    const mkt = (lastReading && lastReading.marketplace) || 'US';
    for (const offer of o.offers) {
      const isMine = !!(mine && offer === mine);
      const row = document.createElement('div');
      row.className = 'apx-seller-row' + (offer.isBuyBox ? ' bb' : '');

      const nameWrap = document.createElement('div');
      nameWrap.className = 'apx-seller-name-wrap';
      const url = storefrontUrl(offer.sellerId, mkt);
      // An anchor only when there is a seller id to point at; otherwise a
      // span, because a link that goes nowhere is worse than plain text.
      const name = document.createElement(url ? 'a' : 'span');
      name.className = 'apx-seller-name';
      // textContent, never innerHTML: a seller name is third-party text from
      // a page we do not control, and this panel runs inside the extension.
      name.textContent = offer.sellerName || 'unnamed seller';
      if (url) {
        name.href = url;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
        name.title = 'Open this seller\u2019s storefront \u2014 ' + offer.sellerId;
      }
      nameWrap.appendChild(name);

      if (offer.positivePct != null) {
        const rate = document.createElement('span');
        // Bands, not a raw number painted neutral: 95%+ is unremarkable,
        // below 90% is the thing worth noticing on a competitor.
        const band = offer.positivePct >= 95 ? 'good' : (offer.positivePct >= 90 ? 'warn' : 'bad');
        rate.className = 'apx-seller-rating ' + band;
        rate.textContent = '\u2605 ' + offer.positivePct + '%';
        rate.title = (offer.ratings != null ? offer.ratings.toLocaleString() + ' ratings, ' : '')
          + offer.positivePct + '% positive '
          + (offer.positiveWindow === 'lifetime' ? 'over its lifetime' : 'over the last 12 months')
          + (offer.positiveWindow === 'lifetime'
              ? ' \u2014 a lifetime figure, not comparable with a 12-month one.' : '.');
        nameWrap.appendChild(rate);
      }
      row.appendChild(nameWrap);

      const tags = document.createElement('span');
      tags.className = 'apx-seller-tags';
      const tag = (cls, text, why) => {
        const t = document.createElement('span');
        t.className = 'apx-seller-tag ' + cls;
        t.textContent = text;
        if (why) t.title = why;
        tags.appendChild(t);
      };
      if (isMine) tag('self', 'YOU',
        'Your own offer. Excluded from the competitor count and the lowest-price figures.');
      if (offer.isAmazon) tag('amz', 'AMZ', 'Amazon is selling this itself.');
      // null is "the page did not say", which is not FBM -- so it gets its
      // own badge rather than being filed under one.
      if (offer.fba === true) tag('fba', 'FBA');
      else if (offer.fba === false) tag('fbm', 'FBM', 'Merchant-fulfilled: the price shown is landed, delivery included.');
      else tag('', '?', 'This offer\u2019s sold-by link did not say how it is fulfilled.');
      if (offer.isBuyBox) tag('bb', 'BB', 'Holds the Buy Box.');
      // CONDITION, badged only when it is NOT plain New -- a New badge on
      // every row of a typical listing is noise, and the thing worth seeing
      // is the row that is a different good. On a book the drawer mixes used
      // copies in freely, and a $19.00 row at 33% beside a $36.55 row at
      // 219% with nothing to distinguish them is a trap.
      if (offer.isNew === false) {
        tag('cond', offer.condition || 'not New',
          'Condition: ' + (offer.condition || 'not New')
          + '. Excluded from the competitor count and the lowest-price figures, which are about new-condition competition.');
      } else if (offer.isNew === null) {
        // Kept in the figures, because a heading that did not parse is not
        // evidence of condition -- and dropping an offer on a failed read is
        // how a real competitor vanishes without trace.
        tag('', 'condition not shown',
          'This offer\u2019s condition could not be read from the page, so it is still counted. It is NOT evidence that the offer is used.');
      }
      row.appendChild(tags);

      const price = document.createElement('span');
      price.className = 'apx-seller-price';
      price.textContent = fmt(offer.landed);
      const stock = stockPhrase(offer);
      price.title = (offer.shipping > 0
        ? fmt(offer.price) + ' plus ' + fmt(offer.shipping) + ' delivery. The page shows '
          + 'only ' + fmt(offer.price) + '; this is what it costs to receive.'
        : 'Delivered, with no separate shipping charge.')
        + (stock ? ' ' + stock + '.' : '');
      row.appendChild(price);

      const roiEl = document.createElement('span');
      const roi = offerRoi(offer.landed);
      if (roi == null) {
        roiEl.className = 'apx-seller-roi na';
        roiEl.textContent = '\u2014';
        roiEl.title = (!lastFees || !lastFees.found)
          ? 'Needs both fee halves from your data provider.'
          : 'Enter your total cost to see what you would make at each price.';
      } else {
        // 30% is the same target the Max Cost tile authorises against, so a
        // green row and an affordable Max Cost mean the same thing.
        const band = roi >= 30 ? 'good' : (roi >= 15 ? 'warn' : 'bad');
        roiEl.className = 'apx-seller-roi ' + band;
        roiEl.textContent = Math.round(roi) + '%';
        roiEl.title = 'What you would make selling at ' + fmt(offer.landed)
          + ', using your own cost and fees \u2014 not this seller\u2019s margin.';
      }
      row.appendChild(roiEl);

      list.appendChild(row);
    }

    // THE SUPPRESSION IS STATED, in all three cases. An exclusion the user
    // cannot see is worse than none: they would read a competitive floor
    // that silently skipped an offer and have no way to know.
    const note = document.createElement('div');
    note.className = 'apx-sellers-note apx-k';
    if (o.excludedByCondition) {
      const cond = document.createElement('div');
      cond.className = 'apx-sellers-note apx-k';
      cond.textContent = o.excludedByCondition + ' offer'
        + (o.excludedByCondition === 1 ? ' is' : 's are') + ' not in new condition and are left out of the competitor count and the lowest-price figures.';
      cond.title = 'They are still listed above with their condition, because \u201cwhy is it cheaper elsewhere?\u201d deserves an answer rather than silence.';
      list.appendChild(cond);
    }
    if (!o.complete) {
      const more = document.createElement('div');
      more.className = 'apx-sellers-note apx-k';
      more.textContent = o.missing + ' more offer' + (o.missing === 1 ? '' : 's')
        + ' exist but are not on the page yet. Click \u201cSee more options\u201d there,'
        + ' then Recheck.';
      // Worth saying, because it decides whether the gap matters: the drawer
      // is sorted by price plus delivery ascending, so the ones still hidden
      // are the dearest.
      more.title = 'The offer list is sorted cheapest first, so the offers still '
        + 'hidden are more expensive than every one shown.';
      list.appendChild(more);
    }
    if (mine) {
      note.textContent = 'Your own offer (' + fmt(mine.landed) + ', '
        + (mine.fba === true ? 'FBA' : mine.fba === false ? 'FBM' : 'fulfilment not stated')
        + ') is excluded from the competitor count and the lowest-price figures.';
    } else if (mySellerId) {
      // Set, but not on this listing. Saying so distinguishes "you are not
      // selling this" from "the id is wrong", which look identical
      // otherwise and want different actions.
      note.textContent = 'None of these offers is yours, so nothing was excluded.';
    } else {
      note.textContent = 'Set your seller ID below and your own offer stops '
        + 'counting as a competitor.';
    }
    list.appendChild(note);
  }

  // ── page-read fields ────────────────────────────────────────────────────

  // The four this account sells in. Anything else falls through to the raw
  // code rather than being silently renamed, so an unexpected marketplace is
  // visible in the panel instead of looking supported.
  const MARKET_NAME = { US: 'US', CA: 'CA', MX: 'MX', BR: 'BR' };

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
    // The three-month spread WAS blanked as needing a price history this
    // build did not have. It has one now, and it is the same series the chart
    // draws -- so this is computed rather than declared missing, and only when
    // the provider answer is actually in hand.
    if (!lastRank || !lastRank.ok) {
      setUnavailable($('apx-swing'), LOADING,
        'Waiting on your data provider for the price history.');
    }

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
          ? `Buy Box: ${r.buyBoxSeller.text} — ${OFFERS_CLOSED_TEXT.toLowerCase()}`
          : OFFERS_CLOSED_TEXT;
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

    // Dimensions WERE blanked here as an SP-API field this build does not
    // fetch. They come from the data provider now -- and this block ran
    // AFTER the provider answer had already filled them, so on a re-read it
    // wiped them. That is the third instance of this exact overwrite in this
    // file: a legacy blanking block left in place downstream of the code
    // that now fills the same elements. It paints the waiting state only,
    // and only while no answer is in hand.
    if (!lastRank || !lastRank.ok) renderDims(null, r.marketplace);

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
      if (lastGating) renderGating(lastGating);

      requestRank(d.reading);
      // Same two triggers as the page read, and no others: panel open and
      // Recheck. Nothing schedules this, which is what keeps it from running
      // unattended against the user's own logged-in Seller Central account.
      requestGating(d.reading);
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
  // The viewing user's own seller id, typed by them in the field below the
  // panel. readPage.js deliberately does NOT know it: a page reader that
  // knows who is reading has an identity to leak, and its whole job is to
  // report what the page says. The exclusion therefore happens here, where
  // it is a presentation decision over a neutral reading.
  let mySellerId = null;

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
    // Which dimension keys the provider actually sent. Printed because the
    // field names above are from the docs and have never been seen in a real
    // response: "dims: 0/8 keys" means the names are wrong, not that the ASIN
    // has no box.
    const dk = d.dimKeys;
    const dimBit = !Array.isArray(dk) ? null
      : (dk.length ? 'dims: ' + dk.length + '/8 keys' : 'dims: no keys returned');

    const h = d.history;
    const histBit = !h ? null
      : (h.present
          ? 'history: ' + h.series + ' series, ' + h.points.toLocaleString()
            + ' pts, ~' + Math.round(h.bytes / 1024) + ' KB'
            // The per-series lengths, as index:length pairs. The series COUNT
            // and the byte total do not reveal the STRIDE, and a chart cannot
            // be drawn without it: some of this provider's series are
            // [time, value] pairs and the ones carrying shipping are
            // [time, value, shipping] triples. Guess wrong and the chart looks
            // plausible and is wrong, which is the failure mode this repo
            // keeps meeting. A length divisible by 3 and not by 2 proves it.
            + (Array.isArray(h.lengths) && h.lengths.length
                ? ' [' + h.lengths.map((p) => p[0] + ':' + p[1]).join(' ') + ']'
            // THE DECODED SPAN, so the provider-epoch constant is checked
            // against a real answer instead of trusted. A 2026 product whose
            // history starts in 2011 means the constant is wrong -- and that
            // is invisible on a chart, which would simply look fine.
            + (() => {
                const all = (h.series_data || []).filter((x) => x.points.length);
                if (!all.length) return '';
                let lo = Infinity, hi = -Infinity;
                for (const sr of all) for (const [t] of sr.points) {
                  if (t < lo) lo = t; if (t > hi) hi = t;
                }
                const d = (m) => new Date((m + 21564000) * 60000).toISOString().slice(0, 10);
                return ' ' + d(lo) + '..' + d(hi);
              })()
                : '')
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
    if (dimBit) bits.push(dimBit);

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
    // Same answer, same call: dimensions ride along on the product lookup
    // that was already paid for, so this costs no extra token.
    renderDims(res.dims || null, (lastReading && lastReading.marketplace) || 'US');
    // Same answer again: the history rode in with the fees and the
    // dimensions, so the chart costs no extra call.
    renderHistory(res.history || null);
    // AND re-render the offer rows, because their ROI column is computed from
    // lastFees, which only exists once this answer lands. The offers were
    // rendered on PAGE_READING -- earlier, from the page, with no fees in hand
    // -- so without this the ROI column reads an em-dash for ever and the only
    // way to populate it is to re-read the page. Fourth instance in this file
    // of a value computed in one place and consumed in another with nothing
    // connecting them.
    if (lastReading) renderOffers(lastReading.offers);

    // Units: Amazon’s own "bought in past month", passed straight through.
    // Absent is a REAL answer -- Amazon does not publish it for every ASIN --
    // and it is not the same as "not checked".
    const est = estMonthly(res.monthlySold, res.rank);
    if (est && sales) {
      sales.textContent = est.text;
      sales.classList.remove('apx-sa-unknown');
      // The deep-tail warning REPLACES the general one rather than sitting
      // beside it: two caveats on one tile and the reader keeps neither.
      sales.title = est.rough
        ? est.roughWhy
        : (est.estimated
            ? 'ESTIMATED from sales rank, using the same formula as the Analyzer. '
              + 'Amazon does not publish a units figure for this ASIN. The estimate is '
              + 'category-blind, so treat it as an order of magnitude, not a number.'
            : 'Units bought in the past month, as published by Amazon'
              + (res.cached ? ' (cached)' : ''));
      // A rough figure is not a verdict-grade number, so it does not get to
      // look like one.
      if (est.rough) sales.classList.add('apx-sa-unknown');
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

    // A POWER LAW IS NOT EQUALLY WRONG EVERYWHERE, and the tile has to say so.
    //
    // Near the top of a category the curve is fitted against plenty of real
    // sales. Deep in the tail it is extrapolation: a book at rank 868,711
    // produced "~28 a month", which is a shape-of-the-curve answer, not a
    // measurement, and on a sourcing panel a precise-looking 28 invites being
    // multiplied by a margin.
    //
    // 200,000 is the line asked for. Above it the tile reads "rough" instead
    // of a figure that implies it was counted, and the number stays in the
    // tooltip for anyone who wants the order of magnitude. Amazon's own
    // published figure, when it exists, never comes through here at all.
    const ROUGH_ABOVE_RANK = 200000;
    const rough = rank.value > ROUGH_ABOVE_RANK;
    return {
      value: n,
      text: rough ? '~' + n.toLocaleString() + ' (rough)' : '~' + n.toLocaleString(),
      estimated: true,
      rough: rough,
      roughWhy: rough
        ? 'Rank ' + rank.value.toLocaleString() + ' is deep in the category, where '
          + 'this is extrapolation from the shape of the curve rather than a fit '
          + 'against real sales. Treat ~' + n.toLocaleString() + ' as an order of '
          + 'magnitude, not a monthly figure.'
        : null,
    };
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

    const f = feesAt(sale, isFbm);
    const referral = f.referral;
    const fulfil = f.fulfil;
    const closing = f.closing;
    const fees = f.total;

    const feesEl = $('apx-fees');
    setMoney('apx-fees', fmt(fees));
    if (feesEl) {
      // Written to be CHECKED against Seller Central line by line, which is
      // the only way a disagreement tells you which half is wrong. Three
      // things it has to say that the short version did not:
      //
      //   the BASE the percentage was applied to. A referral rate is a
      //   percentage of something, and this repo has already shipped a fee
      //   that was a percentage of the MARKET price rather than the
      //   seller’s -- it hid $4.35 a unit and turned 49% ROI into 66%.
      //   Naming the base makes that class of error visible instead of
      //   arithmetically invisible.
      //
      //   the TOTAL, so the tile and the tooltip can be reconciled without
      //   the reader adding up two numbers themselves.
      //
      //   what is NOT in it. An understated fee reads as a better deal, so
      //   every exclusion is a reason the real figure is worse, never
      //   better. Listing them is not hedging.
      const parts = ['Referral ' + fmt(referral) + ' \u2014 ' + lastFees.referralPct
        + '% of your ' + fmt(sale) + ' sale price'];
      parts.push(isFbm
        ? 'No fulfilment fee on FBM'
        : 'Fulfilment ' + fmt(fulfil) + ' \u2014 a flat figure from your data provider');
      // Named whether it applies or not. "No closing fee on this product" is
      // information; silence is indistinguishable from not having looked.
      parts.push(closing > 0
        ? 'Closing fee ' + fmt(closing) + ' \u2014 Amazon\u2019s per-item media charge, and it applies on FBM too'
        : 'No closing fee on this product');
      parts.push('Total ' + fmt(fees));
      const excluded = [
        'monthly storage', 'long-term storage', 'returns processing',
        isFbm ? 'the delivery YOU pay to ship it' : null,
        'any advertising',
      ].filter(Boolean);
      parts.push('NOT included: ' + excluded.join(', ')
        + ' \u2014 so the real cost is this or higher, never lower.');
      feesEl.title = parts.join('. ') + '.';
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
    const simF = feesAt(simSale, /fbm/i.test(String(mode)));
    const simFees = simF ? simF.total : 0;
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

  // The per-offer ROI column depends on BOTH of these, so they re-render the
  // offer rows too. Without it the column stayed on its em-dash while the
  // money tiles above updated as you typed -- two figures from the same two
  // inputs, one of them live and one of them stale, with nothing to say which.
  const recomputeMoney = () => {
    renderMoney();
    if (lastReading) renderOffers(lastReading.offers);
  };
  // The range tabs. They redraw from the series already in hand -- no lookup
  // and no token, because the history arrived with the fees.
  for (const tab of document.querySelectorAll('.apx-range-tab')) {
    tab.addEventListener('click', () => {
      const raw = tab.getAttribute('data-range');
      historyRangeDays = raw === 'SINCE_LISTED' ? 'SINCE_LISTED' : Number(raw);
      for (const t of document.querySelectorAll('.apx-range-tab')) {
        t.classList.toggle('active', t === tab);
      }
      renderHistory(lastRank && lastRank.history);
    });
  }

  $('apx-cost')?.addEventListener('input', recomputeMoney);
  $('apx-seller-mode')?.addEventListener('change', recomputeMoney);
  $('apx-sim-slider')?.addEventListener('input', () => renderSim(lastSale, lastFees && lastFees.found && lastSale != null
    ? (feesAt(lastSale, false) || { total: 0 }).total
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
  // ── the seller-id field ─────────────────────────────────────────────────
  function renderMySeller() {
    const status = $('apx-me-status');
    if (status) {
      status.textContent = mySellerId
        ? 'You: ' + mySellerId
        : 'Your seller ID is not set';
      status.title = mySellerId
        ? 'Your own offer is marked and excluded from the competitor figures.'
        : 'Without it, your own offer counts as one of your competitors.';
    }
    const input = $('apx-me-input');
    if (input) input.value = mySellerId || '';

    // THE KEY CANNOT BE SAVED UNTIL THE SELLER ID IS. It used to be optional,
    // so the key saved on its own and the offer list spent the first session
    // counting the user as their own competitor -- the very thing the id
    // exists to prevent, at the one moment nobody would think to check.
    //
    // Disabled WITH THE REASON on it, because a dead button that does not say
    // why is the dead end this panel keeps being rebuilt to avoid. The
    // ordering is also written into both step labels, since the seller field
    // sits below the key field and position alone would imply the opposite.
    const keySave = $('apx-keepa-save');
    if (keySave) {
      keySave.disabled = !mySellerId;
      keySave.title = mySellerId
        ? ''
        : 'Save your seller ID first — without it the offer list counts your '
          + 'own offer as a competitor.';
    }
  }

  /**
   * "Saved" on the button, then back to its own label when the field changes.
   *
   * The status line below already said "You: A1...", and that was not enough:
   * it sits outside the form, so a save with no visible change to the thing
   * just clicked reads as a click that did not land. Confirmation belongs on
   * the control that was used.
   */
  function flashSaved(btn, restore) {
    if (!btn) return;
    btn.textContent = 'Saved';
    btn.dataset.saved = '1';
    const input = $('apx-me-input');
    if (input && !input.dataset.revertWired) {
      input.dataset.revertWired = '1';
      // Reverts on EDIT, not on a timer: a label that changes back by itself
      // after two seconds is indistinguishable from one that never changed,
      // and the user may well have looked away.
      input.addEventListener('input', () => {
        const b = $('apx-me-save');
        if (b && b.dataset.saved) { b.textContent = restore; delete b.dataset.saved; }
      });
    }
  }

  function wireMySeller() {
    const form = $('apx-me-form');
    const toggle = $('apx-me-change');
    const err = $('apx-me-error');
    const input = $('apx-me-input');
    const gate = $('apx-keepa-gate');

    // The field lives in the gate now, so "Change" reopens the gate rather
    // than revealing a second copy down here. In seller-only mode the key
    // half is hidden: the key is already saved, and showing an empty key
    // field invites retyping it for nothing.
    if (toggle && gate) {
      toggle.addEventListener('click', () => {
        gate.classList.add('apx-gate-seller-only');
        show('keepa');
        if (input) input.focus();
      });
    }
    $('apx-gate-done')?.addEventListener('click', () => {
      gate?.classList.remove('apx-gate-seller-only');
      showSignedIn();
    });
    const save = (value) => {
      toHost({ type: 'NOOP' });
      chrome.runtime.sendMessage({ type: 'ISUA_SET_MY_SELLER', sellerId: value }, (res) => {
        if (!res || !res.ok) {
          if (err) err.textContent = (res && res.error) || 'Could not save that.';
          return;
        }
        if (err) err.textContent = '';
        mySellerId = res.sellerId;
        renderMySeller();
        // Confirm on the button that was clicked -- and UNconfirm on Clear.
        //
        // Guarding only the setting of it was not enough: Clear goes through
        // this same path with sellerId null, so a "Saved" left over from the
        // previous save sat above a now-empty field, claiming the opposite of
        // what had just happened.
        const meBtn = $('apx-me-save');
        if (res.sellerId) {
          flashSaved(meBtn, 'Save seller ID');
        } else if (meBtn) {
          meBtn.textContent = 'Save seller ID';
          delete meBtn.dataset.saved;
        }
        // If the gate was reopened only to change this, go back. On first
        // run the key is still being entered, so stay put.
        if (gate && gate.classList.contains('apx-gate-seller-only')) {
          gate.classList.remove('apx-gate-seller-only');
          showSignedIn();
        }
        // Re-render against the reading already in hand. No lookup, no
        // token: the offers were read from the page and are still held.
        if (lastReading) renderOffers(lastReading.offers);
      });
    };
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        save(input ? input.value : '');
      });
    }
    const clear = $('apx-me-clear');
    if (clear) clear.addEventListener('click', () => save(''));
  }

  wireMySeller();
  chrome.runtime.sendMessage({ type: 'ISUA_GET_MY_SELLER' }, (res) => {
    mySellerId = (res && res.ok && res.sellerId) || null;
    renderMySeller();
    // The reading may already have arrived -- same race as the provider key,
    // and the same fix: replay what is held once the state is known.
    if (lastReading) renderOffers(lastReading.offers);
  });

  refreshKeepa(() => {
    if (hasKey) refreshAuth(); else show('keepa');
    if (hasKey && lastReading) requestRank(lastReading);
  });
  toHost({ type: 'READY' });
})();
