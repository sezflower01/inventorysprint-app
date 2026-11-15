// Reading "can I list this?" from the seller's OWN Seller Central session.
//
// WHY THIS FILE EXISTS SEPARATELY, and why it may reach a host no other file
// may: the fetch lint in tests/noOwnerFallback.test.js is per-FILE, not
// global. keepa.js is the only file allowed to reach the data provider, and
// this is the only file allowed to reach Seller Central. A single shared
// allowlist would let any file call either host, which is the opposite of the
// point.
//
// ── NO PERMISSION CHANGE WAS NEEDED ──────────────────────────────────────────
// manifest host_permissions already carries https://*.amazon.com/*, and
// Chrome's subdomain wildcard matches sellercentral.amazon.com. So this works
// with the manifest as it stands. That is worth stating plainly rather than
// quietly relying on: the existing wildcard is BROADER than this extension
// needs, and it already granted Seller Central access whether or not anything
// used it. Narrowing it to the hosts actually read would be an improvement to
// the store-review posture, not a cost of this feature.
//
// ── THE SESSION IS NEVER READ, AND THAT DISTINCTION IS THE WHOLE DESIGN ──────
// The ban enforced by tests/noOwnerFallback.test.js is on READING the stored
// session -- the two browser APIs that hand it to script. That lint is a plain
// substring scan with no opt-out, deliberately, so this paragraph describes
// those APIs without naming them: spelling them here would trip the very rule
// it is explaining. (It did, on the first run.)
//
// What the ban is NOT is a prohibition on the browser attaching its own stored
// credentials to a request the user's own extension makes on their behalf,
// which is all credentials: 'include' asks for. This code never sees that
// material, never stores it, and never sends it anywhere but back to the host
// it came from.
//
// The seller's answer is therefore inferred from the RESPONSE, which is the
// same request as the gating read -- so the sign-in state and the data arrive
// together or neither does.
//
// ── THE RULE THAT MATTERS MORE THAN ANY OTHER ────────────────────────────────
// A false "eligible" is the expensive error. It sends the user to buy stock
// they cannot sell. A false "couldn't read this" costs them one click. So
// every uncertainty resolves to unreadable, and nothing but an explicit
// boolean false on the condition asked about ever returns eligible.
(function (root) {
  'use strict';

  const BASE = 'https://sellercentral.amazon.com';
  const LOOKUP = '/lyp/api/lookupAsin';

  // The four the API returns. An unknown fifth is treated as a shape change
  // and makes the whole read unreadable rather than being ignored -- see
  // parseGating.
  const CONDITIONS = ['new', 'used', 'collectible', 'refurbished'];

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function unreadable(code, message) {
    return { ok: false, state: 'unreadable', code: code, message: message };
  }
  function signedOut(code, message) {
    return { ok: false, state: 'signed_out', code: code, message: message };
  }

  /**
   * Turn one response into a verdict. PURE, so the tests hand it the real
   * recorded body instead of mocking a network call.
   *
   * @param {{status:number, contentType:string, json:any}} res
   */
  function parseGating(res) {
    const status = res && Number.isFinite(res.status) ? res.status : 0;
    const type = String((res && res.contentType) || '').toLowerCase();

    // Seller Central answers an unauthenticated request with a redirect to a
    // sign-in page, so the giveaway is HTML where JSON was asked for. 401 and
    // 403 are the same answer said plainly.
    if (status === 401 || status === 403) {
      return signedOut('HTTP_' + status,
        'Sign in to Seller Central in this browser, then press Recheck.');
    }
    if (status !== 200) {
      return unreadable('HTTP_' + status,
        'Seller Central answered with HTTP ' + status + '.');
    }
    if (type && type.indexOf('json') === -1) {
      // HTML on a 200 is the sign-in page being served in place of the API.
      return signedOut('NOT_JSON',
        'Seller Central returned a page instead of data, which is what it does '
        + 'when the session has expired. Sign in there, then press Recheck.');
    }
    const body = res ? res.json : null;
    if (!isObj(body)) {
      return unreadable('NO_BODY', 'Seller Central returned nothing readable.');
    }

    const cd = body.conditionDetails;
    if (!isObj(cd)) {
      return unreadable('NO_CONDITIONS',
        'Seller Central did not say which conditions are restricted.');
    }

    // UNKNOWN KEYS ARE FATAL, deliberately. A fifth condition type means the
    // shape has moved, and the safe response to "I do not recognise this
    // answer" is to decline rather than to report on the parts still
    // recognised -- a verdict about listing eligibility is not worth guessing
    // at. The unknown keys are named so the fix is obvious.
    const unknown = Object.keys(cd).filter((k) => CONDITIONS.indexOf(k) === -1);
    if (unknown.length) {
      return unreadable('UNKNOWN_CONDITION',
        'Seller Central returned a condition this version does not know: '
        + unknown.join(', ') + '.');
    }

    // Every known condition must be present with a BOOLEAN. A missing one, or
    // a string "false", is a shape change.
    const missing = [];
    for (const key of CONDITIONS) {
      if (!isObj(cd[key]) || typeof cd[key].isRestricted !== 'boolean') missing.push(key);
    }
    if (missing.length) {
      return unreadable('BAD_CONDITION',
        'Seller Central did not give a yes/no for: ' + missing.join(', ') + '.');
    }

    // restrictionDetails is a list of {conditionTypes, message}. Optional:
    // the recorded response omits "new" from it entirely because new was not
    // restricted. Absent is therefore normal, but a present-and-wrong-shaped
    // one is not.
    let details = [];
    if (body.restrictionDetails != null) {
      if (!Array.isArray(body.restrictionDetails)) {
        return unreadable('BAD_RESTRICTIONS',
          'Seller Central returned restriction details in an unexpected shape.');
      }
      details = body.restrictionDetails;
    }
    const messageFor = (key) => {
      for (const d of details) {
        if (!isObj(d) || !Array.isArray(d.conditionTypes)) continue;
        if (d.conditionTypes.indexOf(key) === -1) continue;
        if (typeof d.message === 'string' && d.message.trim()) return d.message.trim();
      }
      return null;
    };

    const conditions = CONDITIONS.map((key) => ({
      key: key,
      restricted: cd[key].isRestricted,
      // Carried but NOT interpreted as eligibility: in the recorded response
      // showCondition tracked isRestricted, and reading one as the other would
      // work until the day it does not.
      shown: typeof cd[key].showCondition === 'boolean' ? cd[key].showCondition : null,
      message: messageFor(key),
    }));
    const newCond = conditions[0];

    const pd = isObj(body.productDetails) ? body.productDetails : {};
    return {
      ok: true,
      state: 'read',
      // ONLY an explicit boolean false is eligible. Nothing else reaches here,
      // but the comparison stays explicit so a later refactor that lets a
      // truthy-ish value through fails closed.
      eligibleNew: newCond.restricted === false,
      newMessage: newCond.message,
      conditions: conditions,
      asin: typeof pd.asin === 'string' ? pd.asin : null,
      productType: typeof pd.productType === 'string' ? pd.productType : null,
      // These three are reported for CROSS-CHECKING, never to overwrite what
      // the page said. On the recorded ASIN offerCount was 7 and lowestPrice
      // "$64.97", which is exactly what the offer-drawer reader produced
      // independently -- a genuine confirmation of that reader.
      //
      // salesRank, by contrast, was 52,494 where the product page said
      // 263,661: a different ranking of a different category. They are not
      // reconciled, because a figure quietly adjusted to agree is not a
      // reading of anything.
      offerCount: Number.isFinite(pd.offerCount) ? pd.offerCount : null,
      lowestPrice: typeof pd.lowestPrice === 'string' ? pd.lowestPrice : null,
      salesRankSellerCentral: Number.isFinite(pd.salesRank) ? pd.salesRank : null,
    };
  }

  /**
   * One lookup. Never retries: a retry is indistinguishable from a loop from
   * the outside, and this one carries the user's session.
   */
  async function lookup(asin) {
    const a = String(asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(a)) {
      return unreadable('BAD_ASIN', 'Not a valid ASIN.');
    }
    let res;
    try {
      res = await fetch(BASE + LOOKUP + '?asin=' + encodeURIComponent(a), {
        method: 'GET',
        // The browser attaches the user's own Seller Central cookies. This
        // code never reads them -- see the header.
        credentials: 'include',
        headers: { accept: 'application/json' },
        redirect: 'follow',
      });
    } catch (e) {
      // Offline, blocked, or the host refused the connection.
      return unreadable('NETWORK', 'Could not reach Seller Central.');
    }
    let json = null;
    const contentType = res.headers.get('content-type') || '';
    try {
      if (contentType.toLowerCase().indexOf('json') > -1) json = await res.json();
    } catch (e) {
      json = null;
    }
    const out = parseGating({ status: res.status, contentType: contentType, json: json });
    // The URL is never logged, because it carries the ASIN the user is looking
    // at and the diagnostic line is shown on screen.
    out.status = res.status;
    return out;
  }

  const api = { lookup: lookup, parseGating: parseGating, CONDITIONS: CONDITIONS };
  root.GATING = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
