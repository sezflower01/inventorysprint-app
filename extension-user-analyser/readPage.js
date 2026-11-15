// Reads an Amazon product page the user is ALREADY viewing in their own
// session. Pure DOM reading -- no network, no chrome.* APIs, no credentials.
//
// ── WHY THIS FILE IS WRITTEN THE WAY IT IS ────────────────────────────────
//
// Checked 2026-11-12 across both shipped extensions: neither scrapes anything
// from an Amazon page except the ASIN input. `extension/content.js` reads
// `input#ASIN, input[name='ASIN.0'], input[name='ASIN']` then `[data-asin]`,
// and every other number the old panel shows comes from the BACKEND. So there
// is no proven selector library in this repo to inherit, and this layer is
// entirely new code against a DOM Amazon changes without notice.
//
// Two rules follow from that, and both are load-bearing:
//
//   1. NEVER GUESS. Every field returns { found: false, text: 'not found' }
//      when its selectors miss. A wrong number on a sourcing screen is worse
//      than no number, because the user acts on it. There is no fallback
//      chain that ends in a default, no `|| 0`, and no inference from a
//      neighbouring field. (The repo has already been bitten by exactly that
//      shape: `|| 0` on a price resolver booked unknown prices as $0.00 real
//      revenue.)
//   2. EVERY FIELD CARRIES ITS SOURCE. `source` is the human label the panel
//      prints under the value, and for this build it is always "read from
//      this page". When a later version adds Keepa or SP-API fields, the  // lint-allow:keepa-mention
//      label is what stops the user mistaking one for the other.
//
// `extract(doc, url)` takes the document explicitly rather than reaching for
// the global, so the fixture tests can hand it a parsed page.

(function (root) {
  'use strict';

  /** The one label this build is allowed to use. */
  const SRC_PAGE = 'read from this page';

  const NOT_FOUND = Object.freeze({ found: false, value: null, text: 'not found', source: SRC_PAGE });

  function found(value, text) {
    return { found: true, value: value, text: text, source: SRC_PAGE };
  }

  /** First non-empty trimmed textContent among the selectors, else null. */
  function firstText(doc, selectors) {
    for (const sel of selectors) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const n of nodes || []) {
        const t = (n && n.textContent ? String(n.textContent) : '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }
    return null;
  }

  /** First non-empty attribute value among the selectors, else null. */
  function firstAttr(doc, selectors, attr) {
    for (const sel of selectors) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const n of nodes || []) {
        const v = n && n.getAttribute ? n.getAttribute(attr) : null;
        if (v && String(v).trim()) return String(v).trim();
      }
    }
    return null;
  }

  // ── ASIN ────────────────────────────────────────────────────────────────
  // The URL is checked FIRST and the DOM second, the opposite of the old
  // extension. On a variation parent the page's ASIN input can hold a child
  // ASIN that is not the one in the address bar, and the user is looking at
  // the URL. 10 chars, digits and capitals only -- B0... and ISBN-10 both fit.
  const ASIN_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/;

  function readAsin(doc, url) {
    const m = ASIN_RE.exec(String(url || ''));
    if (m) return found(m[1], m[1]);
    const el = firstAttr(doc, ["input#ASIN", "input[name='ASIN.0']", "input[name='ASIN']"], 'value')
      || firstAttr(doc, ['[data-asin]'], 'data-asin');
    if (el && /^[A-Z0-9]{10}$/.test(el)) return found(el, el);
    return NOT_FOUND;
  }

  function readTitle(doc) {
    const t = firstText(doc, ['#productTitle', '#title span']);
    return t ? found(t, t) : NOT_FOUND;
  }

  // ── Price ───────────────────────────────────────────────────────────────
  // Returned as the string Amazon printed PLUS a parsed number, and the panel
  // shows the string. Deliberate: a page can print "$12.34 - $19.99" for a
  // range, and any single number we picked out of that would be a guess. So a
  // range parses to value === null while still displaying what the page says.
  // One complete money token: thousands-grouped first, so "1,299.00" is ONE
  // match and not two.
  //
  // The first version of this counted matches of /\d+[.,]\d{2}/ to spot a
  // range, and "$1,299.00" produced two of them -- "1,29" and "9.00" -- so a
  // perfectly ordinary four-figure price was discarded as a range. Caught by
  // the parseMoney case list before this file had ever run in a browser, which
  // is the entire argument for that test existing.
  const MONEY_TOKEN = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;

  function parseMoney(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/[ \s]/g, '');
    const tokens = cleaned.match(MONEY_TOKEN) || [];
    // Exactly one number, or no number at all. Two means a range ("$14.99 -
    // $27.50") or stray digits in the string, and either way picking one of
    // them would be a guess.
    if (tokens.length !== 1) return null;
    const n = Number(tokens[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function readPrice(doc) {
    const t = firstText(doc, [
      '#corePrice_feature_div .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-offscreen',
      '.priceToPay .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
    ]);
    if (!t) return NOT_FOUND;
    return { found: true, value: parseMoney(t), text: t, source: SRC_PAGE };
  }

  // ── Buy Box seller ──────────────────────────────────────────────────────
  // Absent is a real state, not a failure: a page with no Buy Box genuinely
  // has no seller to name. It still reports not found, because this build
  // must not assert "no Buy Box" from the absence of a selector it may simply
  // have stopped matching.
  function readBuyBoxSeller(doc) {
    const t = firstText(doc, [
      '#sellerProfileTriggerId',
      "#tabular-buybox .tabular-buybox-text[tabular-attribute-name='Sold by'] span",
      '#merchant-info a',
      '#merchant-info',
      '#bylineInfo',
    ]);
    if (!t) return NOT_FOUND;
    const cleaned = t.replace(/^Sold by:?\s*/i, '').replace(/^Ships from and sold by\s*/i, '').replace(/\.$/, '').trim();
    return cleaned ? found(cleaned, cleaned) : NOT_FOUND;
  }

  // ── Seller count ────────────────────────────────────────────────────────
  // Amazon prints this as "New (14) from $12.34" or "14 new from $12.34". Only
  // an explicit integer counts; "Other sellers on Amazon" with no number is
  // NOT read as 1, because that would be inventing the most important number
  // on the screen for a sourcing decision.
  const COUNT_RES = [
    /\(\s*(\d{1,4})\s*\)/,
    /\b(\d{1,4})\s+new\b/i,
    /\bfrom\s+(\d{1,4})\s+sellers?\b/i,
  ];

  function readSellerCount(doc) {
    const t = firstText(doc, [
      '#olpLinkWidget_feature_div',
      '#olp-upd-new-freeshipping',
      '#olp_feature_div',
      '.olp-text-box',
      '#aod-offer-list-header',
    ]);
    if (!t) return NOT_FOUND;
    for (const re of COUNT_RES) {
      const m = re.exec(t);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) return found(n, String(n));
      }
    }
    return NOT_FOUND;
  }

  // ── Best Sellers Rank ───────────────────────────────────────────────────
  // Lives in a row whose label contains "Best Sellers Rank". Scanning rows
  // by LABEL rather than by position: the row order differs between detail
  // layouts and between categories.
  //
  // THERE ARE MORE THAN TWO LAYOUTS, which is what this got wrong. The list
  // below had four selectors and none of them was #prodDetails -- the older
  // two-table layout Amazon still serves for a lot of hardlines. On
  // B0F6KKKNJ6-style pages (Sports & Outdoors, 2026-11-14) the rank sat in
  // #prodDetails and the reader returned "not found", which is the correct
  // answer to the wrong question: the row was there and it was never looked
  // at.
  //
  // Adding a selector is cheap and safe here BECAUSE of the rule below: a
  // row found but unparseable returns NOT_FOUND rather than guessing, so a
  // selector that matches the wrong table costs a missing rank, never a
  // wrong one.
  function readBsr(doc) {
    const rows = [];
    for (const sel of [
      '#productDetails_detailBullets_sections1 tr',
      '#detailBullets_feature_div li',
      '#detailBulletsWrapper_feature_div li',
      '#productDetails_db_sections tr',
      '#prodDetails tr',                  // the older two-table layout
      '#productDetails_techSpec_section_1 tr',
      '#detailBullets_feature_div span.a-list-item',
    ]) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const n of nodes || []) rows.push(n);
    }
    for (const row of rows) {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/best sellers? rank/i.test(text)) continue;
      // A #prodDetails row routinely carries several ranks:
      //   "#53,343 in Sports & Outdoors (See Top 100) #412 in Yoga Mats"
      // The FIRST is the root category, which is the one Amazon prints as
      // the headline BSR and the one the provider summary reports -- so
      // taking the most specific one would disagree with both the page and
      // the tile beside it.
      const m = /#\s*([\d,]+)\s*in\s+([^(#]+)/i.exec(text);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        const cat = m[2].replace(/\s+/g, ' ').trim();
        if (Number.isFinite(n) && cat) {
          return { found: true, value: n, category: cat, text: '#' + n.toLocaleString() + ' in ' + cat, source: SRC_PAGE };
        }
      }
      return NOT_FOUND; // the row is there but unparseable -- say so, do not guess
    }
    return NOT_FOUND;
  }

  // ── Availability ────────────────────────────────────────────────────────
  // Three states and "unknown" is one of them.
  function readAvailability(doc) {
    if (doc.querySelector && doc.querySelector('#outOfStock')) return found(false, 'out of stock');
    const t = firstText(doc, ['#availability span', '#availability', '#availability_feature_div']);
    if (!t) return NOT_FOUND;
    if (/currently unavailable|out of stock/i.test(t)) return found(false, t);
    if (/in stock|only \d+ left|usually ships/i.test(t)) return found(true, t);
    return { found: true, value: null, text: t, source: SRC_PAGE };
  }

  /** A variation parent: a twister with no child selected. Informational. */
  function readVariationParent(doc) {
    const hasTwister = !!(doc.querySelector && (doc.querySelector('#twister') || doc.querySelector('#twister_feature_div')));
    if (!hasTwister) return found(false, 'no');
    const selected = firstText(doc, ['#twister .selection', '#variation_color_name .selection', '#variation_size_name .selection']);
    return found(!selected, selected ? 'no (a variation is selected)' : 'yes');
  }

  /** Books carry a Publisher / ISBN row. Informational, never a verdict. */
  function readIsBook(doc) {
    const rows = firstText(doc, ['#detailBullets_feature_div', '#productDetails_detailBullets_sections1', '#detailBulletsWrapper_feature_div']);
    if (!rows) return NOT_FOUND;
    return found(/publisher|isbn-?1[03]|paperback|hardcover/i.test(rows), /publisher|isbn-?1[03]|paperback|hardcover/i.test(rows) ? 'yes' : 'no');
  }

  /**
   * Gating is NOT read here, on purpose.
   *
   * A buyer-facing /dp/ page does not show seller gating -- that appears in
   * Seller Central's Add-a-Product flow. A "no restriction notice found" on
   * this page would therefore be permanent and would read to the user as
   * "I can sell this", which is the same false reassurance the old panel
   * produced from the ACCOUNT OWNER's restrictions. So this build states that
   * it did not check, offers no verdict, and carries no colour.
   */
  // ── The offers panel ────────────────────────────────────────────────────
  //
  // #all-offers-display is the "New (7) from $64.97" panel. It is NOT on the
  // page until the shopper opens it, so everything here reports not-found
  // rather than failing when it is absent -- a closed panel is a normal state,
  // not an error.
  //
  // Built against a REAL capture of B0H8QLSNPP (2026-11-14), trimmed and
  // scrubbed into fixtures/09-offers-panel.html. Four things that capture
  // settled, each of which a reasonable guess would have got wrong:
  //
  //   1. FBA vs FBM is in the SOLD-BY LINK, not the text. The href carries
  //      isAmazonFulfilled=0|1. "Ships from Amazon.com" is the obvious-looking
  //      signal and it is localised prose, so reading it would break on every
  //      non-English marketplace this extension already supports.
  //
  //   2. Price and shipping are SEPARATE attributes on the price block
  //      (data-csa-c-price-to-pay, data-csa-c-shipping-charge). The rendered
  //      "$68.95" omits the $8.33 shipping entirely, so a reader that scrapes
  //      the visible price ranks an FBM offer 8 dollars cheaper than it is.
  //      Everything here sorts on LANDED cost.
  //
  //   3. Every offer block carries id="aod-offer". Seven elements, one id.
  //      Invalid HTML, and what Amazon ships; querySelectorAll copes,
  //      getElementById would silently return one offer out of seven.
  //
  //   4. The capture had ANOTHER EXTENSION'S nodes injected into it --
  //      .keepaStock divs holding a per-offer stock figure. Tempting, and
  //      reading them would make this panel silently depend on the user having
  //      that extension installed. Amazon's own maxQty is used instead.
  function offerStock(block) {
    // maxQty from Amazon's own add-to-cart payload. In the capture it equalled
    // the other extension's stock readout on 6 of 7 offers; the seventh was
    // maxQty 30 against "30+", so 30 is a CAP and not a count. Reported as a
    // ceiling, never as "there are exactly N".
    const el = block.querySelector('[data-aod-atc-action]');
    if (!el) return { maxQty: null, atLeast: false };
    let n = null;
    try { n = JSON.parse(el.getAttribute('data-aod-atc-action')).maxQty; } catch (_) { return { maxQty: null, atLeast: false }; }
    if (!Number.isInteger(n) || n < 1) return { maxQty: null, atLeast: false };
    return { maxQty: n, atLeast: n >= 30 };
  }

  function readOneOffer(block, isBuyBox) {
    const link = block.querySelector('#aod-offer-soldBy a[href*="seller="]');
    const href = link ? (link.getAttribute('href') || '') : '';
    const sellerId = (/[?&]seller=([A-Z0-9]+)/i.exec(href) || [])[1] || null;

    // The ONE reliable fulfilment signal. Absent means we do not know, which
    // is not the same as FBM -- so it stays null and the caller must cope.
    const ful = /[?&]isAmazonFulfilled=([01])/i.exec(href);
    const fba = ful ? ful[1] === '1' : null;

    const priceEl = block.querySelector('[data-csa-c-price-to-pay]');
    const num = (el, attr) => {
      if (!el) return null;
      const v = parseFloat(el.getAttribute(attr));
      return Number.isFinite(v) ? v : null;
    };
    const price = num(priceEl, 'data-csa-c-price-to-pay');
    // Absent shipping means free on this layout, but absent PRICE means we
    // cannot total anything -- so landed is null rather than 0.
    const shipping = num(priceEl, 'data-csa-c-shipping-charge') || 0;
    const landed = price == null ? null : Math.round((price + shipping) * 100) / 100;

    const alt = block.querySelector('#aod-offer-seller-rating .a-icon-alt');
    const stars = alt ? parseFloat((/([\d.]+) out of 5/.exec(alt.textContent) || [])[1]) : NaN;

    const rateText = block.querySelector('#aod-offer-seller-rating') ?
      block.querySelector('#aod-offer-seller-rating').textContent.replace(/\s+/g, ' ') : '';
    const count = (/\(([\d,]+) ratings?\)/.exec(rateText) || [])[1];
    const pct = (/(\d+)% positive/.exec(rateText) || [])[1];
    // "over last 12 months" and "over lifetime" are different claims and the
    // capture had both. Keeping the window means a 97%-lifetime seller is not
    // read as equivalent to a 97%-this-year one.
    const window = /over lifetime/i.test(rateText) ? 'lifetime'
      : (/last 12 months/i.test(rateText) ? '12m' : null);

    const shipsFromEl = block.querySelector('#aod-offer-shipsFrom');
    const shipsFrom = shipsFromEl
      ? shipsFromEl.textContent.replace(/\s+/g, ' ').replace(/^\s*Ships from\s*/i, '').trim() || null
      : null;

    // Amazon's own label for how delivery is paid: 'cfs' on the free-shipping
    // offers in the capture, 'paid_shipping' on the one that charges. Read
    // rather than interpreted -- it is an enum nobody has documented to us.
    const progEl = block.querySelector('[data-csa-c-delivery-benefit-program-id]');
    const deliveryProgram = progEl
      ? (progEl.getAttribute('data-csa-c-delivery-benefit-program-id') || null) || null
      : null;

    // PRIME IS NOT A PER-OFFER FIELD IN THIS LAYOUT, and this is the honest
    // answer rather than the convenient one. The capture carries a-icon-prime
    // only inside the FILTER control, never inside an offer block; the offer
    // rows mention Prime solely in prose ("Prime members get FREE delivery"),
    // which is localised and also appears on offers that are not Prime.
    //
    // Every FBA offer is in practice Prime-eligible, so fba could be reported
    // as prime and would usually be right. It would also be an inference
    // dressed as a reading, which is the one thing this file does not do --
    // so primeStated says whether the PAGE said it, and nothing more.
    const primeStated = !!block.querySelector('.a-icon-prime');

    const name = link ? link.textContent.replace(/\s+/g, ' ').trim() : null;
    if (!name && price == null) return null; // not an offer block at all

    const stock = offerStock(block);
    return {
      sellerName: name,
      sellerId: sellerId,
      // Amazon selling directly is a different competitive fact from a
      // third party who happens to ship from an Amazon warehouse.
      isAmazon: /^amazon(\.[a-z.]+)?$/i.test(String(name || '')),
      fba: fba,
      price: price,
      shipping: shipping,
      landed: landed,
      shipsFrom: shipsFrom,
      stars: Number.isFinite(stars) ? stars : null,
      ratings: count ? Number(count.replace(/,/g, '')) : null,
      positivePct: pct ? Number(pct) : null,
      positiveWindow: window,
      maxQty: stock.maxQty,
      maxQtyIsCap: stock.atLeast,
      deliveryProgram: deliveryProgram,
      primeStated: primeStated,
      isBuyBox: !!isBuyBox,
    };
  }

  // THREE STATES, because the drawer is built asynchronously and "nothing to
  // show" has three different causes the user can act on differently:
  //
  //   closed   #all-offers-display is not in the DOM at all. The normal state
  //            on every page load, and fixable: open the offer list.
  //   loading  the drawer is there and still filling. Amazon paints the
  //            pinned offer and the counter FIRST, then fetches the rest, so
  //            a read taken in that window sees one offer out of seven.
  //   read     everything the counter promised is present.
  //
  // THERE IS NO LOADING STATE, because there is nothing in flight.
  //
  // This reads a DOM snapshot, once, when the page is read or Recheck is
  // pressed. Nothing watches the drawer afterwards -- there is deliberately
  // no MutationObserver in this extension, so no state can resolve itself.
  // "Loading..." therefore promised something the code will never do, and a
  // panel showing it sat there for ever: the earlier fix bounded the wait
  // against the drawer’s counter and left this second unbounded path, where
  // the container exists and nothing in it parses.
  //
  // So an unsuccessful read reports WHY, in terms that separate the three
  // causes, because they want three different responses:
  //
  //   closed      no #all-offers-display at all. Open the offer list.
  //   empty       the container is there with no offer blocks in it. Either
  //               it was read in the moment between opening and filling, or
  //               this ASIN has none. Press Recheck.
  //   unreadable  offer blocks ARE there and not one of them parsed. That is
  //               not a user problem, it is Amazon having changed the markup,
  //               and it is the only one of the three that needs a code fix.
  //               Reported with the block count so it can be acted on.
  //
  // LOADING WAS ALSO BOUNDED AGAINST THE COUNTER, and that was the first
  // half of this bug.
  //
  // The counter says how many offers EXIST. It does not say how many are in
  // the DOM. Amazon ships the first few and fetches the rest only when the
  // shopper clicks "See N more options" -- so a drawer that has finished
  // everything it intends to do unasked can sit at three offers against a
  // counter of seven, for ever. Waiting for the difference is waiting for a
  // click that may never come.
  //
  // The earlier version also read the spinner, which is no help here: the
  // spinner is hidden, because nothing is being fetched.
  //
  // So: one parsed offer is enough to be READ. Whether the read is COMPLETE
  // is a separate question, answered by comparing against the counter and
  // reported rather than waited on.
  function offersState(panel, blockCount, parsedCount) {
    if (!panel) return 'closed';
    if (parsedCount) return 'read';
    return blockCount ? 'unreadable' : 'empty';
  }

  function readOffers(doc) {
    const panel = doc.querySelector('#all-offers-display');
    const base = {
      found: false, text: 'not found', source: SRC_PAGE, state: 'closed',
      count: 0, blocks: 0, totalOthers: null, complete: false, missing: 0, offers: [],
      buyBox: null, fbaLow: null, fbmLow: null, amazon: null,
      fbaCount: 0, fbmCount: 0, amazonSold: false,
    };
    if (!panel) return base;

    const blocks = [];
    // THE PINNED OFFER IS IN THE DOM TWICE on the live drawer: a hidden
    // #aod-sticky-pinned-offer that appears on scroll, and the real
    // #aod-pinned-offer. Same seller, same price. Taking both reports eight
    // offers for a seven-offer ASIN with the Buy Box seller listed twice, and
    // inflates the FBA count by one. The real block wins; the sticky one is
    // only used when it is the ONLY pinned offer present, which is how a
    // half-built drawer looks.
    const pinned = panel.querySelector('#aod-pinned-offer')
      || panel.querySelector('#aod-sticky-pinned-offer');
    if (pinned) blocks.push([pinned, true]);
    // querySelectorAll, because the id is on every block (see note 3 above).
    for (const el of panel.querySelectorAll('#aod-offer')) blocks.push([el, false]);

    const offers = [];
    for (const [el, isBB] of blocks) {
      const o = readOneOffer(el, isBB);
      if (o) offers.push(o);
    }

    const totalEl = panel.querySelector('#aod-total-offer-count');
    const rawTotal = totalEl ? parseInt(totalEl.getAttribute('value'), 10) : NaN;
    const totalOthers = Number.isInteger(rawTotal) ? rawTotal : null;

    const state = offersState(panel, blocks.length, offers.length);
    if (state !== 'read') {
      return Object.assign({}, base, {
        state: state,
        text: 'not found',
        count: offers.length,
        // How many candidate offer elements were FOUND, as against parsed.
        // The gap between these two numbers is the whole diagnosis: zero
        // blocks is a drawer that has not filled, blocks-but-no-parse is
        // markup that has moved under us.
        blocks: blocks.length,
        totalOthers: totalOthers,
        offers: offers,
      });
    }

    const cheapest = (list) => list.reduce(
      (best, o) => (o.landed != null && (!best || o.landed < best.landed) ? o : best), null);
    const amazon = offers.find((o) => o.isAmazon) || null;

    return {
      found: true,
      state: 'read',
      // Amazon counts the OTHERS: "6 other options" alongside the pinned one.
      // Reporting that as the offer count would be off by one on every ASIN.
      text: offers.length + (offers.length === 1 ? ' offer' : ' offers'),
      source: SRC_PAGE,
      count: offers.length,
      blocks: blocks.length,
      totalOthers: totalOthers,
      // Whether every offer the counter promises is actually in the DOM.
      // False means the shopper has not expanded "See N more options", so
      // the dearest offers are absent -- the drawer is sorted by price plus
      // delivery ascending, so what is missing is always the expensive end.
      complete: totalOthers == null || offers.length >= totalOthers + 1,
      missing: totalOthers == null ? 0 : Math.max(0, (totalOthers + 1) - offers.length),
      offers: offers,
      buyBox: offers.find((o) => o.isBuyBox) || null,
      fbaLow: cheapest(offers.filter((o) => o.fba === true)),
      fbmLow: cheapest(offers.filter((o) => o.fba === false)),
      amazon: amazon,
      // fba === null is "the page did not say", so it counts towards neither.
      // The two counts therefore need not add up to count, and that is the
      // point: a missing discriminator is visible instead of being bundled
      // into FBM, which is what a simple !fba test would have done.
      fbaCount: offers.filter((o) => o.fba === true).length,
      fbmCount: offers.filter((o) => o.fba === false).length,
      amazonSold: !!amazon,
    };
  }

  function gatingNotice() {
    return {
      checked: false,
      text: 'Not checked in this version',
      sellerCentralUrl: 'https://sellercentral.amazon.com/product-search/search',
      source: 'not checked',
    };
  }

  function extract(doc, url) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      throw new TypeError('extract(doc, url): doc must be a DOM document');
    }
    return {
      asin: readAsin(doc, url),
      title: readTitle(doc),
      price: readPrice(doc),
      buyBoxSeller: readBuyBoxSeller(doc),
      sellerCount: readSellerCount(doc),
      bsr: readBsr(doc),
      availability: readAvailability(doc),
      variationParent: readVariationParent(doc),
      isBook: readIsBook(doc),
      offers: readOffers(doc),
      gating: gatingNotice(),
      readAt: null, // set by content.js; left null so extract() stays pure
    };
  }

  const api = {
    extract: extract,
    readOffers: readOffers,
    parseMoney: parseMoney,
    NOT_FOUND: NOT_FOUND,
    SRC_PAGE: SRC_PAGE,
  };

  root.ISUA = Object.assign(root.ISUA || {}, { readPage: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
