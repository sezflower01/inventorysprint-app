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

test('dimensions: -1 is absent, not a small box', () => {
  // The provider uses -1 for "no data" on these exactly as it does for the
  // rank, and it is the same trap: -1 is a valid-looking number, so anything
  // not strictly positive is absent rather than tiny.
  const full = KEEPA.summariseProduct(body({
    packageHeight: 80, packageLength: 320, packageWidth: 230, packageWeight: 1180,
    itemHeight: 70, itemLength: 310, itemWidth: 220, itemWeight: 1100,
  }));
  assert.deepEqual(full.dims.pkg.mm, [80, 320, 230]);
  assert.equal(full.dims.pkg.grams, 1180);
  assert.deepEqual(full.dims.item.mm, [70, 310, 220]);
  assert.equal(full.dims.keysSeen.length, 8);

  for (const bad of [-1, 0, null, undefined, 'x']) {
    const r = KEEPA.summariseProduct(body({
      packageHeight: bad, packageLength: 320, packageWidth: 230, packageWeight: bad,
    }));
    assert.equal(r.dims.pkg.mm, null, 'a ' + bad + ' dimension produced a box');
    assert.equal(r.dims.pkg.grams, null, 'a ' + bad + ' weight produced a weight');
    assert.ok(r.dims.pkg.missing.includes('dimensions'), 'the missing half is not named');
    assert.ok(r.dims.pkg.missing.includes('weight'));
  }

  // A PARTIAL box is no box. Two of three sides cannot be shown as
  // dimensions, and filling the third from somewhere would be a guess.
  const partial = KEEPA.summariseProduct(body({
    packageHeight: 80, packageLength: 320, packageWeight: 1180,
  }));
  assert.equal(partial.dims.pkg.mm, null, 'two sides out of three rendered as a box');
  assert.equal(partial.dims.pkg.grams, 1180, 'the weight was dropped with the dimensions');
});

test('dimensions: the field names are unverified, so the shape is reported', () => {
  // ⚠️ The eight field names come from the provider's DOCS. No response in
  // this repo has carried them, so keysSeen exists to settle it on the first
  // real lookup: 8/8 means the names are right, 0/8 means they are not, and
  // a trading-card box reading 320 is millimetres while one reading 32 is
  // centimetres. Until then the tiles stay empty with a reason, and that is
  // why this test checks the REPORTING rather than the values.
  const none = KEEPA.summariseProduct(body());
  assert.deepEqual(none.dims.keysSeen, [], 'keys were reported that did not arrive');
  assert.equal(none.dims.pkg.mm, null);

  const some = KEEPA.summariseProduct(body({ packageWeight: 1180, itemWeight: 1100 }));
  assert.deepEqual(some.dims.keysSeen, ['packageWeight', 'itemWeight'],
    'keysSeen no longer names exactly which fields arrived');

  // And the worker must pass it to the diagnostic on both paths.
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.equal((bg.match(/dimKeys:/g) || []).length, 2,
    'the dimension-key report is not carried on both the cached and called path');
});

test('no dimensional weight is ever computed here', () => {
  // Amazon bills bulky items on DIMENSIONAL weight, not actual, and this repo
  // has already shipped a fee quote that used the wrong one. The authority is
  // get_asin_fba_fee_basis, server-side. A girth or volume calculation
  // appearing in this file is that bug coming back.
  const src = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/139|166|dimWeight|dimensionalWeight|girth/i.test(code),
    'keepa.js is computing a dimensional weight or a divisor');

  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  const slice = panel.slice(panel.indexOf('function renderDims'), panel.indexOf('function renderOffers(o)'));
  assert.ok(!/dimWeight|dimensionalWeight|girth/i.test(slice.replace(/\/\/[^\n]*/g, '')),
    'the panel is computing a dimensional weight');
  // The weight tooltip must say which weight it is, or it reads as a fee input.
  assert.match(slice, /ACTUAL weight/, 'the weight no longer states that it is the actual weight');
});

test('dimensions are shown in the unit the marketplace sells in', () => {
  // A bare "12.6 x 9.1 x 3.1" beside a US fee calculation reads as inches to
  // a US seller and centimetres to a European one, and those differ by 2.5x.
  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  const slice = panel.slice(panel.indexOf('function renderDims'), panel.indexOf('function renderOffers(o)'));
  assert.match(slice, /25\.4/, 'the millimetre-to-inch conversion has gone');
  assert.match(slice, /453\.59/, 'the gram-to-pound conversion has gone');
  assert.match(slice, /' in'|" in"/, 'the inch unit is no longer printed');
  assert.match(slice, /' cm'|" cm"/, 'the centimetre unit is no longer printed');
  // The provider's own figures stay available, so the conversion is checkable.
  assert.match(slice, /mm\./, 'the raw provider figures are no longer in the tooltip');
});

test('the fee tooltip can be checked against Seller Central line by line', () => {
  // A fee total you cannot decompose is a number you have to trust. This repo
  // has shipped a referral fee that was a percentage of the MARKET price
  // rather than the seller's own -- it hid $4.35 a unit and turned 49% ROI
  // into a reported 66%. Arithmetically the total looked fine. Naming the
  // base is what makes that class of error visible.
  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  const slice = panel.slice(panel.indexOf('const feesEl'), panel.indexOf('// Max Cost authorises'));
  assert.ok(slice.length > 0, 'the fee tooltip block has moved');

  assert.match(slice, /Referral/, 'the referral line has gone');
  assert.match(slice, /referralPct/, 'the referral RATE is no longer shown beside the amount');
  assert.match(slice, /of your.*sale price/, 'the tooltip no longer names the base the rate was applied to');
  assert.match(slice, /Fulfilment/, 'the fulfilment amount has gone');
  assert.match(slice, /Total/, 'the total has gone, so the tile cannot be reconciled with its parts');

  // Every exclusion makes the real cost HIGHER. Dropping one makes the ASIN
  // look better than it is, which is the direction that loses money.
  for (const ex of ['storage', 'long-term', 'returns']) {
    assert.ok(new RegExp(ex, 'i').test(slice), 'the tooltip stopped excluding ' + ex);
  }
  assert.match(slice, /this or higher, never lower/,
    'the tooltip no longer states which direction the exclusions push the figure');

  // FBM has no fulfilment fee, and the seller's own postage is not in here.
  assert.match(slice, /No fulfilment fee on FBM/);
  assert.match(slice, /delivery YOU pay/, 'FBM no longer warns that your own postage is excluded');
});

test('the series stride is 2, and it was measured rather than assumed', () => {
  // A chart drawn on the wrong stride looks entirely plausible and is wrong,
  // which is the failure this repo keeps meeting. The live response had
  // lengths 100 and 434 -- both divisible by 2 and NEITHER by 3 -- which
  // proves [time, value] pairs for the series that carry real data. The
  // triple-stride series (the *_SHIPPING ones, Buy Box among them) never
  // appeared at all, which is why no triple was there to find.
  const csv = {};
  csv[1] = [];
  for (let i = 0; i < 50; i++) csv[1].push(1000 + i, 6497 + i);
  const r = KEEPA.summariseProduct(body({ csv }));
  assert.equal(r.history.stride, 2, 'the measured stride is no longer recorded');

  const s1 = r.history.series_data.find((x) => x.index === 1);
  assert.equal(s1.points.length, 50, 'the pair stride is not being used to decode');
  assert.deepEqual(s1.points[0], [1000, 6497]);
  assert.deepEqual(s1.points[49], [1049, 6546]);
});

test('-1 in a price series is no data, not minus one cent', () => {
  // The same marker the rank uses, and the same trap: plotting it draws the
  // line down off the bottom of the chart.
  const csv = { 1: [100, 6497, 101, -1, 102, 6597] };
  const r = KEEPA.summariseProduct(body({ csv }));
  const s1 = r.history.series_data.find((x) => x.index === 1);
  assert.equal(s1.points.length, 2, 'a no-data marker was plotted as a price');
  assert.deepEqual(s1.points.map((p) => p[1]), [6497, 6597]);
});

test('absent legend series are reported absent, never substituted', () => {
  // THE FINDING THAT CHANGED THE DELIVERABLE. Three of the four series the
  // legend names -- Buy Box (18), FBA (10), FBM (7) -- were absent from the
  // live response, because all three are offer-derived and this build does
  // not request offers. Relabelling index 1 as "Buy Box" would have produced
  // a chart that looked right and lied, so each is carried as an empty series
  // and the legend greys it with the reason.
  const csv = { 1: [100, 6497, 101, 6597] };
  const r = KEEPA.summariseProduct(body({ csv }));
  const byIndex = Object.fromEntries(r.history.series_data.map((x) => [x.index, x]));

  for (const idx of [18, 10, 7, 0]) {
    assert.ok(byIndex[idx], 'series ' + idx + ' is no longer reported at all');
    assert.equal(byIndex[idx].points.length, 0, 'series ' + idx + ' acquired data from somewhere');
  }
  assert.equal(byIndex[1].points.length, 2);
  assert.equal(r.history.charted, 1, 'the count of drawable series is wrong');

  // The labels must stay attached to their own index.
  assert.equal(byIndex[18].label, 'Buy Box');
  assert.equal(byIndex[1].label, 'New');
});

test('history is downsampled to the canvas, keeping both ends', () => {
  // The chart is 320 pixels wide, so more than 320 points cannot be seen --
  // and the cache is chrome.storage.local, a few megabytes for everything.
  // Keeping a ten-year history to draw 320 columns spends the quota on pixels
  // nobody can look at.
  const csv = { 1: [] };
  for (let i = 0; i < 5000; i++) csv[1].push(1000 + i, 5000 + i);
  const r = KEEPA.summariseProduct(body({ csv }));
  const s1 = r.history.series_data.find((x) => x.index === 1);

  assert.equal(s1.points.length, 320, 'the series is no longer capped to the canvas width');
  // Both ends survive, or the thinning would silently shorten the span.
  assert.deepEqual(s1.points[0], [1000, 5000], 'the first point was thinned away');
  assert.deepEqual(s1.points[319], [5999, 9999], 'the last point was thinned away');

  // And the stored form stays small enough to cache per ASIN.
  const bytes = JSON.stringify(r.history.series_data).length;
  assert.ok(bytes < 24000, 'the cached series grew to ' + bytes + ' bytes per ASIN');
});

test('the marketplace maps cover this account and no more', () => {
  // They listed ten, six of them countries this account does not sell in. All
  // nine non-US entries were unreachable anyway: content_scripts matches
  // amazon.com only, and the marketplace is never derived from the hostname --
  // it is the literal 'US' through a fallback. So the extra entries advertised
  // support that did not exist in two independent ways.
  const WANT = ['BR', 'CA', 'MX', 'US'];

  const keepa = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  const dom = keepa.match(/const DOMAIN = \{([^}]+)\}/)[1];
  assert.deepEqual(dom.match(/\b[A-Z]{2}\b/g).sort(), WANT, 'the provider domain map changed');
  // Only US is honoured, whatever the map lists.
  assert.match(keepa, /const ENABLED_MARKETS = \['US'\]/,
    'a marketplace was enabled without the fee, currency and gating work');

  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  for (const [name, rx] of [
    ['AMZ_HOST', /const AMZ_HOST = \{([\s\S]*?)\};/],
    ['IMPERIAL', /const IMPERIAL = \{([^}]+)\}/],
    ['MARKET_NAME', /const MARKET_NAME = \{([^}]+)\}/],
  ]) {
    const body = panel.match(rx)[1];
    const keys = [...new Set((body.match(/\b([A-Z]{2}):/g) || []).map((k) => k.slice(0, 2)))].sort();
    assert.deepEqual(keys, WANT, name + ' lists marketplaces this account does not sell in');
  }

  // THE UNVERIFIED FIGURES MUST STAY FLAGGED. Sending the wrong provider
  // domain id returns a real answer about the WRONG COUNTRY, and asserting
  // Canada is imperial on no evidence is the same plausible-looking kind of
  // wrong. Both warnings are load-bearing until someone checks them.
  const domComment = keepa.slice(Math.max(0, keepa.indexOf('const DOMAIN') - 900), keepa.indexOf('const DOMAIN'));
  // The ids were CHECKED against the provider’s own published table, so what
  // must survive is the citation rather than a warning. A map with no source
  // is a map someone will “correct” from memory.
  assert.match(domComment, /VERIFIED AGAINST THE PROVIDER/,
    'the domain ids lost the record of where they were checked');
  assert.match(domComment, /com.mx/, 'the published table has gone from the comment');
  assert.match(domComment, /api-docs/, 'the citation has gone');
  const impComment = panel.slice(Math.max(0, panel.indexOf('const IMPERIAL') - 900), panel.indexOf('const IMPERIAL'));
  assert.match(impComment, /ONLY THE US ONE IS VERIFIED/,
    'the unverified imperial-units assumption lost its warning');
});

test('the readPage comment no longer claims marketplaces that do not exist', () => {
  // It said the fulfilment attribute mattered because reading localised prose
  // "would break on every non-English marketplace this extension already
  // supports". The extension supports one.
  const src = fs.readFileSync(path.join(ROOT, 'readPage.js'), 'utf8');
  assert.ok(!/already supports/.test(src),
    'the claim about supported marketplaces is back');
  assert.match(src, /The extension supports\s*\n?\s*\/\/\s*one marketplace|supports\s+one marketplace/,
    'the correction naming one marketplace has gone');
});

test('the media closing fee is read, and is its own number', () => {
  // AMAZON CHARGES A FLAT PER-ITEM CLOSING FEE ON MEDIA -- books, DVDs, music,
  // games -- and the panel was omitting it entirely. The provider documents
  // fbaFees as "the FBA pick & pack fee" and nothing else, and exposes the
  // closing fee as its own top-level variableClosingFee. So every media ASIN
  // was understated by the whole closing fee, which inflates Profit, ROI,
  // Margin and the Max Cost the panel AUTHORISES: the direction that costs
  // money.
  const withClosing = KEEPA.summariseProduct(body({
    fbaFees: { pickAndPackFee: 437 }, referralFeePercentage: 15, variableClosingFee: 181,
  }));
  assert.equal(withClosing.fees.found, true);
  assert.equal(withClosing.fees.closingFee, 1.81, 'the closing fee is not read, or not in cents');
  assert.equal(withClosing.fees.closingFeeStated, true);
  // Kept SEPARATE from the fulfilment fee so the tooltip can be checked
  // against Seller Central line by line.
  assert.equal(withClosing.fees.fbaFee, 4.37, 'the closing fee was folded into fulfilment');

  // "undefined if not applicable" per the documentation, so absent is the
  // normal answer for a non-media product -- NOT a missing half that should
  // make the whole fee answer unreadable.
  for (const absent of [undefined, null, 0, -1]) {
    const r = KEEPA.summariseProduct(body({
      fbaFees: { pickAndPackFee: 437 }, referralFeePercentage: 15, variableClosingFee: absent,
    }));
    assert.equal(r.fees.found, true, JSON.stringify(absent) + ' broke the whole fee answer');
    assert.equal(r.fees.closingFee, 0, JSON.stringify(absent) + ' produced a closing fee');
    assert.equal(r.fees.closingFeeStated, false,
      JSON.stringify(absent) + ' is reported as a stated zero rather than absent');
  }
});

test('the referral rate prefers the documented field name', () => {
  // The provider DOCUMENTS referralFeePercentage. This code only ever read
  // referralFeePercent, which appears nowhere in that documentation -- and it
  // worked, because the live response carries it as an undocumented alias.
  // Fees resolved on two real ASINs, so the alias is certainly there; relying
  // on it alone is the problem, because an undocumented field is the one that
  // disappears without a changelog.
  const documented = KEEPA.summariseProduct(body({
    fbaFees: { pickAndPackFee: 437 }, referralFeePercentage: 12,
  }));
  assert.equal(documented.fees.referralPct, 12, 'the documented field name is not read');

  const alias = KEEPA.summariseProduct(body({
    fbaFees: { pickAndPackFee: 437 }, referralFeePercent: 15,
  }));
  assert.equal(alias.fees.referralPct, 15, 'the live alias stopped being read');

  // Documented wins, so a response carrying both cannot be read two ways.
  const bothOf = KEEPA.summariseProduct(body({
    fbaFees: { pickAndPackFee: 437 }, referralFeePercentage: 12, referralFeePercent: 15,
  }));
  assert.equal(bothOf.fees.referralPct, 12, 'the undocumented alias outranks the documented field');
});

test('a deep-tail rank estimate is labelled rough, not printed as a figure', () => {
  // A book at rank 868,711 produced "~28 a month". That is the shape of the
  // curve, not a measurement, and a precise-looking 28 on a sourcing panel
  // invites being multiplied by a margin.
  const src = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  // A FORWARD WINDOW, not a slice between two names. Slicing to
  // 'function renderDims' gave an empty string, because renderDims is defined
  // EARLIER in the file than this is -- the fourth time a between-two-names
  // slice in these tests has silently matched nothing and passed.
  const at = src.indexOf('const ROUGH_ABOVE_RANK');
  assert.ok(at > -1, 'the deep-tail threshold has gone');
  const fn = src.slice(at, at + 1400);
  assert.match(fn, /ROUGH_ABOVE_RANK = 200000/, 'the deep-tail threshold changed');
  assert.match(fn, /\(rough\)/, 'the tile no longer marks a deep-tail estimate');
  assert.match(fn, /order of\s*'?\s*\+?\s*'?\s*magnitude/,
    'the explanation no longer says what the number is worth');

  // The threshold is a comparison on the rank, not on the estimate -- a low
  // estimate from a GOOD rank is a real answer and must not be marked rough.
  assert.match(fn, /rank\.value > ROUGH_ABOVE_RANK/,
    'roughness is being decided from something other than the rank');
});
