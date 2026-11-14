// Reading a provider product answer.
//
// summariseProduct is deliberately pure, so these tests hand it bodies of the
// shape the provider really returns instead of mocking a network call. Every
// case here is one that has a wrong-but-plausible handling:
//
//   -1          a real "no data" marker that is also a valid-looking number
//   0 units     absent and zero are different claims
//   no stats    a product the provider knows but has no rank for
//   no products a 200 that carried nothing
//
// The rule under test is readPage.js's rule 1: never guess. A rank or a units
// figure that cannot be read must say so, because the user sources against it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// keepa.js is a classic worker script, not a module: it assigns to `self`,
// falling back to globalThis. Running it in a context makes that context the
// root, so KEEPA lands on the sandbox.
function loadKeepa() {
  const sandbox = { console, URLSearchParams, fetch: () => { throw new Error('no network in this test'); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8'), sandbox);
  assert.ok(sandbox.KEEPA, 'keepa.js did not expose KEEPA');
  return sandbox.KEEPA;
}

const KEEPA = loadKeepa();

const body = (over = {}) => ({
  products: [Object.assign({
    asin: 'B0H8QLSNPP',
    title: 'A product',
    categoryTree: [{ catId: 1, name: 'Home & Kitchen' }, { catId: 2, name: 'Storage' }],
    stats: { current: [1999, 2099, -1, 4321] },
  }, over)],
});

test('a rank is read, and labelled with the ROOT category', () => {
  const r = KEEPA.summariseProduct(body());
  assert.equal(r.ok, true);
  assert.equal(r.rank.found, true);
  assert.equal(r.rank.value, 4321);
  // Amazon prints the headline BSR against the top-level category, so taking
  // the most specific one would disagree with the page next to it.
  assert.equal(r.rank.category, 'Home & Kitchen');
  assert.equal(r.rank.text, '#4,321 in Home & Kitchen');
});

test('-1 is not a rank', () => {
  const r = KEEPA.summariseProduct(body({ stats: { current: [1999, 2099, -1, -1] } }));
  assert.equal(r.rank.found, false);
  assert.equal(r.rank.value, null);
  assert.equal(r.rank.text, 'not found');
});

test('a missing stats block is not a rank of zero', () => {
  for (const over of [{ stats: undefined }, { stats: {} }, { stats: { current: [] } }]) {
    const r = KEEPA.summariseProduct(body(over));
    assert.equal(r.rank.found, false, JSON.stringify(over));
    assert.notEqual(r.rank.value, 0, 'a missing rank must never read as 0');
  }
});

test('a rank with no category still reads as a rank', () => {
  const r = KEEPA.summariseProduct(body({ categoryTree: [] }));
  assert.equal(r.rank.found, true);
  assert.equal(r.rank.category, null);
  assert.equal(r.rank.text, '#4,321');
});

test('monthly units are passed through, not estimated', () => {
  const r = KEEPA.summariseProduct(body({ monthlySold: 500 }));
  assert.equal(r.monthlySold.found, true);
  assert.equal(r.monthlySold.value, 500);
  // "+" because this is Amazon's own banded figure ("500+ bought in past
  // month"), not a precise count. Printing a bare 500 would overstate it.
  assert.equal(r.monthlySold.text, '500+');
});

test('absent units say "not available", never 0 and never an estimate', () => {
  for (const over of [{}, { monthlySold: 0 }, { monthlySold: -1 }, { monthlySold: null }]) {
    const r = KEEPA.summariseProduct(body(over));
    assert.equal(r.monthlySold.found, false, JSON.stringify(over));
    assert.equal(r.monthlySold.text, 'not available');
  }
});

test('units are never derived from the rank', () => {
  // The guard that matters most: a rank is present and units are not, which
  // is exactly the moment a rank-to-sales model would get reached for.
  const r = KEEPA.summariseProduct(body());
  assert.equal(r.rank.found, true);
  assert.equal(r.monthlySold.found, false);
  const src = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  const slice = src.slice(src.indexOf('function summariseProduct'), src.indexOf('async function productSummary'));
  assert.ok(!/rank\s*[*/]|[*/]\s*rank/i.test(slice),
    'summariseProduct does arithmetic on the rank, which means it is estimating units');
});

test('a body with no product is a failure, not an empty answer', () => {
  for (const b of [{}, { products: [] }, { products: null }, null]) {
    const r = KEEPA.summariseProduct(b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(r.message, 'a failure must carry something the panel can show');
  }
});

test('one ASIN costs one token, so the worker caches per ASIN', () => {
  // Without the cache, tabbing back to a product page spends a token every
  // time for an answer that does not move within the hour.
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.ok(/PRODUCT_TTL_MS/.test(bg), 'the product TTL has gone');
  const slice = bg.slice(bg.indexOf("case 'ISUA_PROVIDER_PRODUCT'"), bg.indexOf("case 'ISUA_SIGN_IN_PASSWORD'"));
  assert.ok(slice.length > 0, 'the product handler has gone');
  const readAt = slice.indexOf('storage.local.get');
  const callAt = slice.indexOf('productSummary');
  assert.ok(readAt > -1, 'the handler no longer reads the cache');
  assert.ok(callAt > -1, 'the handler no longer calls the provider');
  assert.ok(readAt < callAt, 'the cache is read after the token is spent, which defeats it');

  // WHAT USED TO BE ASSERTED HERE, AND WHY IT WAS WRONG.
  //
  // This test also required that a FAILURE never reach the cache, so that a
  // refilled bucket or a repaired key could not be hidden for the whole TTL.
  // Sound-looking, and it was the expensive half of a 2026-11-14 scare: Keepa
  // charges for a call it refuses, so an uncached failure means every retry
  // pays again, and a panel with no visible diagnostic looked exactly like a
  // loop.
  //
  // Failures are now cached for five minutes, which cannot hide a repaired key
  // for long and collapses a run of retries into one call. The caching rules
  // and the per-minute cap are pinned in tests/keepaGuards.test.js; the
  // assertion is not duplicated here.
});

test('the offers parameter stays off the product call', () => {
  // Keepa requires offers to be 0 or >= 20; anything between returns a 200
  // carrying an error that naive code reads as "no offers". Not asking at all
  // is the only safe value here, and it is also the cheap one.
  const src = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  const slice = src.slice(src.indexOf('async function product('), src.indexOf('function summariseProduct'));
  assert.ok(!/offers\s*:/.test(slice), 'the product call now asks for offers');
});

test('fees are read only when BOTH halves arrived', () => {
  // A fulfilment fee with no referral rate cannot make a fee total, and
  // filling the gap with a nominal 15% is the exact understatement that once
  // turned a 49% ROI into a reported 66% in this repo.
  const withFees = (over) => body(over);

  let r = KEEPA.summariseProduct(withFees({ fbaFees: { pickAndPackFee: 437 }, referralFeePercent: 15 }));
  assert.equal(r.fees.found, true);
  // Provider amounts are integer cents. Reading 437 as dollars would quote a
  // $437 fulfilment fee; reading it as 4.37 is the only correct scale.
  assert.equal(r.fees.fbaFee, 4.37);
  assert.equal(r.fees.referralPct, 15);

  for (const over of [
    { fbaFees: { pickAndPackFee: 437 } },
    { referralFeePercent: 15 },
    { fbaFees: {}, referralFeePercent: 15 },
    { fbaFees: { pickAndPackFee: 437 }, referralFeePercent: 0 },
    {},
  ]) {
    r = KEEPA.summariseProduct(withFees(over));
    assert.equal(r.fees.found, false, JSON.stringify(over));
    assert.equal(r.fees.fbaFee, null, JSON.stringify(over));
    assert.ok(Array.isArray(r.fees.missing), 'a partial fee answer must say what was missing');
  }
});

test('a zero fulfilment fee is a real answer, not a missing one', () => {
  // Some products genuinely carry no pick-and-pack. Treating 0 as absent
  // would blank the whole fee tile for them.
  const r = KEEPA.summariseProduct(body({ fbaFees: { pickAndPackFee: 0 }, referralFeePercent: 8 }));
  assert.equal(r.fees.found, true);
  assert.equal(r.fees.fbaFee, 0);
});

test('the two panels agree on the units formula', () => {
  // Est/mo falls back to a power law when Amazon publishes no figure. The
  // Analyzer has its own copy of that formula. If the two drift, the same
  // ASIN shows two different numbers in two panels on the same screen, and
  // the seller has no way to tell which to believe -- so they stop believing
  // both. Nothing else pins these constants together.
  const RX = /Math\.round\(\s*(\d+)\s*\*\s*Math\.pow\([^,]+,\s*(-?[\d.]+)\s*\)\s*\)/;

  const mine = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8').match(RX);
  assert.ok(mine, 'this panel no longer carries the units formula');

  const theirsPath = path.join(ROOT, '..', 'extension', 'panel.js');
  if (!fs.existsSync(theirsPath)) return; // the sibling is not checked out
  const theirs = fs.readFileSync(theirsPath, 'utf8').match(RX);
  assert.ok(theirs, 'the Analyzer no longer carries the units formula -- check whether it changed source');

  assert.equal(mine[1], theirs[1], 'the coefficient drifted from the Analyzer');
  assert.equal(mine[2], theirs[2], 'the exponent drifted from the Analyzer');
});

test('Max Cost targets the same ROI as the Analyzer', () => {
  // Max Cost authorises what the user may pay. A divisor that drifts here
  // authorises overpaying, silently.
  const RX = /\(\s*sale\s*-\s*(?:unit)?[Ff]ees\s*\)\s*\/\s*([\d.]+)/;
  const mine = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8').match(RX);
  assert.ok(mine, 'the Max Cost formula has gone');
  assert.equal(mine[1], '1.30', 'the Max Cost ROI target changed');
});
