// Reading the one-ASIN sales-window envelope.
//
// ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
//
// The thing it replaces was a row scan over a request that could not return
// what it asked for:
//
//     sales_orders?...&select=quantity,order_date&order=order_date.asc&limit=5000
//
// PostgREST caps at 1000 (db-max-rows) and `limit` only lowers that, so 1,000
// rows came back; ASCENDING meant they were the OLDEST orders, and every
// recent sale was truncated off the end. On a listing whose lifetime orders
// exceed the cap that produced 7d and 30d of ZERO with a small non-zero 90d,
// while the listing was in fact selling normally all week. The numbers were
// wrong in a direction that looks like "this product stopped selling" -- the
// worst possible reading for a reorder screen.
//
// The replacement is a server-side aggregate, so the failure mode moves: there
// are no rows to miscount, but the envelope can be absent, stale or malformed.
// A reader that turns any of those into zeros would reproduce the original bug
// with a different cause, so this one distinguishes "no sales" from "no
// answer" and is tested for it.
//
// Separate file so it can be tested: the old version was inline in a 1,200-line
// message handler, which is how it stayed wrong unnoticed.

/** What a caller gets back. `ok: false` means DO NOT show these as sales. */
function readSalesWindows(envelope) {
  const empty = {
    ok: false,
    reason: null,
    units7d: 0,
    units30d: 0,
    units90d: 0,
    unitsLifetime: 0,
    ordersLifetime: 0,
    firstOrderDate: null,
    firstOrderDate30d: null,
    lastOrderDate: null,
  };

  if (envelope === null || envelope === undefined) {
    return { ...empty, reason: "no envelope (request failed or returned null)" };
  }
  // PostgREST returns a bare value for a scalar RPC over GET, but a
  // single-element array through some clients. Accept either; refuse anything
  // that looks like a ROW SET, because that would mean the function changed
  // shape and a row cap is back in play.
  let e = envelope;
  if (Array.isArray(e)) {
    if (e.length !== 1) {
      return { ...empty, reason: `expected one envelope, got an array of ${e.length}` };
    }
    e = e[0];
  }
  if (typeof e !== "object" || e === null) {
    return { ...empty, reason: `envelope is ${typeof e}, not an object` };
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const u7 = num(e.units_7d);
  const u30 = num(e.units_30d);
  const u90 = num(e.units_90d);
  const life = num(e.units_lifetime);

  if (u7 === null || u30 === null || u90 === null || life === null) {
    return { ...empty, reason: "envelope is missing one or more unit counts" };
  }

  // The windows nest: anything inside 7 days is inside 30 and 90, and all are
  // inside lifetime. A violation means the windows were computed against
  // different data -- the shape of every truncation bug in this project -- so
  // it is refused rather than displayed.
  if (!(u7 <= u30 && u30 <= u90 && u90 <= life)) {
    return {
      ...empty,
      reason: `windows do not nest (7d=${u7}, 30d=${u30}, 90d=${u90}, life=${life})`,
    };
  }

  return {
    ok: true,
    reason: null,
    units7d: u7,
    units30d: u30,
    units90d: u90,
    unitsLifetime: life,
    ordersLifetime: num(e.orders_lifetime) ?? 0,
    firstOrderDate: e.first_order_date ?? null,
    firstOrderDate30d: e.first_order_date_30d ?? null,
    lastOrderDate: e.last_order_date ?? null,
  };
}

// Usable from the service worker (importScripts/ESM) and from node for tests.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { readSalesWindows };
}
if (typeof self !== "undefined") {
  self.readSalesWindows = readSalesWindows;
}
