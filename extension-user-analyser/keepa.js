// The ONLY module in this extension that talks to api.keepa.com.  // lint-allow:keepa-mention
//
// Loaded by the service worker via importScripts, so it runs in the worker and
// never in a page context. Two consequences, both deliberate:
//
//   - the key is never present in the panel, in a content script, or on any
//     Amazon page. The panel asks the worker for *state* (is there a key, how
//     many tokens are left) and never for the key itself.
//   - every outbound request carrying the key leaves from one file, which the
//     lint can check exhaustively rather than approximately.
//
// ── WHOSE KEY, AND WHY IT MATTERS ────────────────────────────────────────
//
// Every user supplies their own, the project owner included. Not a
// convenience: this project already learned, expensively, what happens when
// one account's credentials answer for everybody. A shared key would also put
// every user on the owner's token budget, where the repricer and the seller
// monitor are already contending for 25 tokens a minute -- a handful of
// extension users would starve live repricing.
//
// So: the key lives in chrome.storage.local in that user's browser. It is
// never sent to our servers, never logged, never written into a zip, and
// there is no default.
//
// ── TOKENS ───────────────────────────────────────────────────────────────
//
// Keepa meters tokens, not calls, and refills continuously. Every response
// carries tokensLeft, tokensConsumed, refillIn and refillRate; the costs this
// extension can incur are /token (free) and /product (1 token per ASIN).
// Running out is an ordinary state, not an error, and gets its own message
// with the refill time -- a blank tile would read as "no data for this
// product", which is a different and wrong statement.
//
// ── THE 200-WITH-AN-ERROR TRAP ───────────────────────────────────────────
//
// Keepa signals failure in the BODY of a 200 response. Code that only checks
// res.ok reads a failure as an empty result. Every call here checks
// json.error before anything else. The same trap, with /product&offers, has
// already cost this project a debugging cycle.

(function (root) {
  'use strict';

  const KEY_STORE = 'isua_keepa_key';
  const BASE = 'https://api.keepa.com';

  // Keepa's own domain ids. Only the ones this extension can reach.
  const DOMAIN = { US: 1, UK: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, MX: 11, BR: 12 };

  async function getKey() {
    try {
      const got = await chrome.storage.local.get(KEY_STORE);
      const k = got?.[KEY_STORE];
      return typeof k === 'string' && k.trim() ? k.trim() : null;
    } catch (_) { return null; }
  }

  async function setKey(key) {
    const k = String(key || '').trim();
    if (!k) throw new Error('empty key');
    await chrome.storage.local.set({ [KEY_STORE]: k });
  }

  async function clearKey() {
    try { await chrome.storage.local.remove(KEY_STORE); } catch (_) { /* ignore */ }
  }

  /**
   * Last 4 characters only, for showing the user which key is saved without
   * showing the key. Never log or display anything else derived from it.
   */
  function maskKey(key) {
    if (!key) return null;
    const s = String(key);
    return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }

  /**
   * Shape every reply the same way so the panel has one thing to read, and so
   * a failure can never be mistaken for a zero.
   */
  function fail(code, message, extra) {
    return { ok: false, code, message, ...extra };
  }

  async function callKeepa(path, params) {
    const key = await getKey();
    if (!key) return fail('NO_KEY', 'No API key saved.', { status: null, tokensConsumed: 0 });

    const qs = new URLSearchParams({ key, ...params });
    let res;
    try {
      res = await fetch(`${BASE}${path}?${qs.toString()}`);
    } catch (e) {
      // Offline, DNS, blocked. Not an invalid key -- saying so would send the
      // user to re-enter a key that is fine.
      return fail('NETWORK', 'Could not reach the data provider. Check your connection.',
        // No status and no cost: the request never left the browser.
        { status: null, tokensConsumed: 0 });
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

    // A rejected or throttled call is REPORTED WITH ITS COST, which Keepa
    // states in the body even when it refuses. Assuming a failure was free
    // is how a budget drifts from the provider’s own accounting.
    const spent = Number.isFinite(json?.tokensConsumed) ? json.tokensConsumed : 0;
    const meta = { status: res.status, tokensConsumed: spent,
      tokensLeft: Number.isFinite(json?.tokensLeft) ? json.tokensLeft : null };

    if (res.status === 401 || res.status === 403) {
      return fail('BAD_KEY', 'That API key was rejected.', meta);
    }
    if (res.status === 429) {
      return fail('EXHAUSTED', 'Out of tokens.', { ...meta, refillIn: json?.refillIn ?? null });
    }
    if (!res.ok) {
      return fail('HTTP', `Request failed (${res.status}).`, meta);
    }
    if (!json) {
      return fail('HTTP', 'Unreadable response.', { status: res.status, tokensConsumed: 0 });
    }
    // THE TRAP: a 200 whose body carries an error. Checked before anything
    // reads a field off this object.
    if (json.error) {
      const msg = json.error.message || json.error.type || 'Request rejected.';
      const isKey = /token|key|subscription/i.test(String(msg));
      return fail(isKey ? 'BAD_KEY' : 'API', String(msg), meta);
    }

    return {
      ok: true,
      status: res.status,
      data: json,
      tokensLeft: Number.isFinite(json.tokensLeft) ? json.tokensLeft : null,
      tokensConsumed: Number.isFinite(json.tokensConsumed) ? json.tokensConsumed : null,
      refillIn: Number.isFinite(json.refillIn) ? json.refillIn : null,
      refillRate: Number.isFinite(json.refillRate) ? json.refillRate : null,
    };
  }

  /**
   * Validate a key WITHOUT saving it, by asking for token status. Costs
   * nothing, so it can be run on every gate open.
   *
   * Takes the candidate key explicitly rather than reading storage: the point
   * is to check before committing, so an invalid key never gets saved and the
   * user is never left with a stored key that does not work.
   */
  async function validate(candidate) {
    const k = String(candidate || '').trim();
    if (!k) return fail('NO_KEY', 'Enter your API key.');

    let res;
    try {
      res = await fetch(`${BASE}/token?key=${encodeURIComponent(k)}`);
    } catch (_) {
      return fail('NETWORK', 'Could not reach the data provider. Check your connection.');
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

    if (res.status === 401 || res.status === 403) return fail('BAD_KEY', 'That API key was rejected.');
    if (!res.ok || !json) return fail('HTTP', `Could not check the key (${res.status}).`);
    if (json.error) return fail('BAD_KEY', String(json.error.message || json.error.type || 'Key rejected.'));

    // A valid key that happens to be at zero is still a VALID key. Saving it
    // and reporting the empty balance is right; refusing it would be wrong
    // and would read as "your key is broken".
    return {
      ok: true,
      tokensLeft: Number.isFinite(json.tokensLeft) ? json.tokensLeft : 0,
      refillIn: Number.isFinite(json.refillIn) ? json.refillIn : null,
      refillRate: Number.isFinite(json.refillRate) ? json.refillRate : null,
    };
  }

  /** One ASIN. 1 token. */
  async function product(asin, marketplace) {
    const a = String(asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(a)) return fail('BAD_ASIN', 'Not a valid ASIN.');
    const domain = DOMAIN[String(marketplace || 'US').toUpperCase()] || DOMAIN.US;
    // stats gives the rank and price summaries without asking for offers.
    // offers is deliberately NOT requested: Keepa requires it to be 0 or >= 20,
    // and anything between returns a 200 carrying an error that naive code
    // reads as "no offers".
    return callKeepa('/product', { asin: a, domain: String(domain), stats: '180' });
  }

  // ── Reading a product answer ─────────────────────────────────────────────
  //
  // Kept as a PURE function, separate from the call, so the tests can hand it
  // a recorded body. Everything here obeys readPage.js's rule 1: a field that
  // cannot be read reports { found: false }, never a zero and never a guess.
  //
  // Index 3 of the stats/csv arrays is the sales rank. The other indices are
  // prices and are deliberately not touched here: this build shows rank and
  // units, and a price read from rank data would contradict the page.
  const SALES_RANK_INDEX = 3;

  const NOT_FOUND = Object.freeze({ found: false, value: null, text: 'not found' });
  const NOT_AVAILABLE = Object.freeze({ found: false, value: null, text: 'not available' });

  function summariseProduct(data) {
    const p = data && Array.isArray(data.products) ? data.products[0] : null;
    if (!p) return { ok: false, code: 'NO_PRODUCT', message: 'The provider returned no product for that ASIN.' };

    // ── rank ──
    // -1 is the provider's "no data", and it is also a perfectly valid-looking
    // number. Anything not a positive integer is not a rank.
    let rank = NOT_FOUND;
    const raw = p.stats && Array.isArray(p.stats.current) ? p.stats.current[SALES_RANK_INDEX] : null;
    if (Number.isFinite(raw) && raw > 0) {
      const cat = Array.isArray(p.categoryTree) && p.categoryTree.length
        ? String(p.categoryTree[0].name || '').trim()
        : '';
      rank = {
        found: true,
        value: raw,
        category: cat || null,
        text: '#' + raw.toLocaleString() + (cat ? ' in ' + cat : ''),
      };
    }

    // ── units a month ──
    // This is Amazon's OWN "bought in past month" figure, passed through.
    // It is NOT a rank-to-sales estimate: this file does not own a model for
    // that, and inventing one would put a number on screen that no source
    // stands behind. When Amazon does not publish it, say so.
    let monthlySold = NOT_AVAILABLE;
    if (Number.isFinite(p.monthlySold) && p.monthlySold > 0) {
      monthlySold = {
        found: true,
        value: p.monthlySold,
        text: p.monthlySold.toLocaleString() + '+',
      };
    }

    // ── fees ──
    // Read ONLY if the provider actually sent them. There is no default and
    // no assumed referral rate: this repo has already been burned by a fee
    // figure that was too low (a referral quoted against the wrong price hid
    // $4.35 a unit and turned a 49% ROI into a reported 66%). A fee tile that
    // says "not found" costs the user a lookup; one that is too low costs
    // them the purchase.
    //
    // Both halves are required. A pick-and-pack with no referral percentage
    // cannot produce a fee total, and filling the gap with a nominal 15%
    // would be exactly the understatement described above.
    const packFee = p.fbaFees && Number.isFinite(p.fbaFees.pickAndPackFee)
      ? p.fbaFees.pickAndPackFee
      : null;
    const refPct = Number.isFinite(p.referralFeePercent) ? p.referralFeePercent : null;
    const fees = (packFee != null && packFee >= 0 && refPct != null && refPct > 0)
      ? { found: true, fbaFee: packFee / 100, referralPct: refPct }
      : { found: false, fbaFee: null, referralPct: null,
          missing: [packFee == null ? 'fulfilment fee' : null, refPct == null ? 'referral rate' : null].filter(Boolean) };

    return {
      ok: true,
      asin: p.asin || null,
      fees,
      title: p.title || null,
      rank,
      monthlySold,
    };
  }

  /** One ASIN, already reduced to the fields the panel shows. 1 token. */
  async function productSummary(asin, marketplace) {
    const r = await product(asin, marketplace);
    if (!r.ok) return r;
    const out = summariseProduct(r.data);
    // A 200 that carried no product STILL COST A TOKEN. Dropping the
    // transport fields here reported it as free, so the footer and the
    // diagnostic both understated what the call had spent.
    if (!out.ok) {
      return { ok: false, code: out.code, message: out.message,
        status: r.status, tokensLeft: r.tokensLeft, tokensConsumed: r.tokensConsumed };
    }
    return {
      ...out,
      status: r.status,
      tokensLeft: r.tokensLeft,
      tokensConsumed: r.tokensConsumed,
      refillIn: r.refillIn,
    };
  }

  root.KEEPA = {
    getKey, setKey, clearKey, maskKey, validate, product, productSummary, summariseProduct,
    KEY_STORE, DOMAIN, BASE,
  };
})(typeof self !== 'undefined' ? self : globalThis);
