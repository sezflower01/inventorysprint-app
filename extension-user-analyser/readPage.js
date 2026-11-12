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
  // Lives in a detail-bullets row whose label contains "Best Sellers Rank".
  // Scanning rows by LABEL rather than by position: the row order differs
  // between the two detail layouts and between categories.
  function readBsr(doc) {
    const rows = [];
    for (const sel of ['#productDetails_detailBullets_sections1 tr', '#detailBullets_feature_div li', '#detailBulletsWrapper_feature_div li', '#productDetails_db_sections tr']) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const n of nodes || []) rows.push(n);
    }
    for (const row of rows) {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/best sellers? rank/i.test(text)) continue;
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
      gating: gatingNotice(),
      readAt: null, // set by content.js; left null so extract() stays pure
    };
  }

  const api = {
    extract: extract,
    parseMoney: parseMoney,
    NOT_FOUND: NOT_FOUND,
    SRC_PAGE: SRC_PAGE,
  };

  root.ISUA = Object.assign(root.ISUA || {}, { readPage: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
