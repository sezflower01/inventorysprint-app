// Parser tests against the saved fixtures.
//
// Run with: npm test   (inside extension-user-analyser/)
//
// ⚠️ The fixtures are SYNTHETIC -- see fixtures/README.md. They prove the
// parser's logic, not that it survives Amazon's real markup. A green run here
// is not evidence the panel works in the wild.
//
// jsdom is a devDependency of THIS folder only; the root package.json is
// untouched. If it is not installed the whole suite SKIPS WITH A REASON rather
// than passing quietly -- a parser suite that silently reports success while
// testing nothing is worse than a red one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readPage = require('../readPage.js');

let JSDOM = null;
let skip = false;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  skip = 'jsdom not installed -- run `npm install` inside extension-user-analyser/';
}

const FIX = path.join(__dirname, 'fixtures');
const load = (name) => {
  const html = fs.readFileSync(path.join(FIX, name), 'utf8');
  return new JSDOM(html).window.document;
};

// A URL per fixture, because readAsin() reads the URL FIRST (the address bar is
// what the user is looking at, and on a variation parent the page's own ASIN
// input can hold a different, child ASIN).
const URL_FOR = (asin) => `https://www.amazon.com/dp/${asin}?th=1`;

test('every fixture file is covered by a case here', { skip }, () => {
  const onDisk = fs.readdirSync(FIX).filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(onDisk, [
    '01-normal.html', '02-no-buybox.html', '03-many-sellers.html',
    '04-out-of-stock.html', '05-book.html', '06-variation-parent.html',
    '07-sparse.html', '08-proddetails-bsr.html', '09-offers-panel.html',
  ], 'a fixture was added or renamed without a test');
});

test('01 normal: every field reads', { skip }, () => {
  const r = readPage.extract(load('01-normal.html'), URL_FOR('B07XYZ1234'));
  assert.equal(r.asin.value, 'B07XYZ1234');
  assert.equal(r.title.value, 'Acme Stainless Steel Water Bottle, 32 oz'); // whitespace collapsed
  assert.equal(r.price.value, 24.99);
  assert.equal(r.price.text, '$24.99');
  assert.equal(r.buyBoxSeller.value, 'Acme Direct');
  assert.equal(r.sellerCount.value, 7);
  assert.equal(r.bsr.value, 1432);
  assert.match(r.bsr.category, /^Kitchen & Dining/);
  assert.equal(r.availability.value, true);
  assert.equal(r.variationParent.value, false);
  // Every field names its source, and in this build they all name the page.
  for (const k of ['asin', 'title', 'price', 'buyBoxSeller', 'sellerCount', 'bsr']) {
    assert.equal(r[k].source, 'read from this page', `${k} lost its source label`);
  }
});

test('02 no Buy Box: seller and price are "not found", never guessed', { skip }, () => {
  const r = readPage.extract(load('02-no-buybox.html'), URL_FOR('B01NOBOX99'));
  assert.equal(r.buyBoxSeller.found, false);
  assert.equal(r.buyBoxSeller.text, 'not found');
  assert.equal(r.price.found, false);
  // "Other sellers on Amazon" with no integer must NOT become 1. Inventing the
  // seller count is the single most dangerous guess on a sourcing panel.
  assert.equal(r.sellerCount.found, false, 'seller count was invented from a countless label');
  assert.equal(r.bsr.value, 884201);
});

test('03 many sellers: a 3-digit count parses', { skip }, () => {
  const r = readPage.extract(load('03-many-sellers.html'), URL_FOR('B0MANY00SL'));
  assert.equal(r.sellerCount.value, 142);
  assert.equal(r.buyBoxSeller.value, 'CablesPlus');
  assert.equal(r.price.value, 9.49);
  assert.equal(r.bsr.found, false, 'no BSR section in this fixture');
});

test('04 out of stock: reported as a real state, not a parse failure', { skip }, () => {
  const r = readPage.extract(load('04-out-of-stock.html'), URL_FOR('B0OOS12345'));
  assert.equal(r.availability.found, true);
  assert.equal(r.availability.value, false);
  assert.equal(r.price.found, false);
  assert.equal(r.sellerCount.found, false);
});

test('05 book: ISBN-10 ASIN, "Ships from and sold by" stripped, BSR in a bullet list', { skip }, () => {
  const r = readPage.extract(load('05-book.html'), URL_FOR('0306406152'));
  assert.equal(r.asin.value, '0306406152', 'ISBN-10 is a valid 10-char ASIN');
  assert.equal(r.buyBoxSeller.value, 'Bookmonger Co', 'prefix and trailing period removed');
  assert.equal(r.sellerCount.value, 23, 'matched the "23 new from" wording');
  assert.equal(r.bsr.value, 12004);
  assert.equal(r.isBook.value, true);
});

test('06 variation parent: a price RANGE must not collapse to one number', { skip }, () => {
  const r = readPage.extract(load('06-variation-parent.html'), URL_FOR('B0PARENT01'));
  // The URL wins over the page's child ASIN input.
  assert.equal(r.asin.value, 'B0PARENT01');
  // Shows what the page says, but refuses to pick a number out of a range.
  assert.equal(r.price.found, true);
  assert.equal(r.price.text, '$14.99 - $27.50');
  assert.equal(r.price.value, null, 'a range was collapsed into a single price');
  assert.equal(r.variationParent.value, true);
});

test('07 sparse: an unknown layout yields "not found" everywhere, and no crash', { skip }, () => {
  const r = readPage.extract(load('07-sparse.html'), 'https://www.amazon.com/some/other/path');
  for (const k of ['asin', 'title', 'price', 'buyBoxSeller', 'sellerCount', 'bsr', 'availability']) {
    assert.equal(r[k].found, false, `${k} produced a value from a page that has none`);
    assert.equal(r[k].text, 'not found', `${k} did not say "not found"`);
  }
  // The BSR row EXISTS but is unparseable -- still not found, not a 0.
  assert.equal(r.bsr.value, null);
});

test('gating is never a verdict, on any fixture', { skip }, () => {
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.html'))) {
    const r = readPage.extract(load(f), URL_FOR('B000000000'));
    assert.equal(r.gating.checked, false, `${f}: gating claimed to be checked`);
    assert.equal(r.gating.text, 'Not checked in this version');
    assert.equal(r.gating.source, 'not checked');
    assert.ok(!('verdict' in r.gating), `${f}: a gating verdict appeared`);
    assert.ok(!('eligible' in r.gating), `${f}: an eligibility flag appeared`);
  }
});

test('parseMoney: the cases that decide whether a number is a guess', () => {
  assert.equal(readPage.parseMoney('$24.99'), 24.99);
  assert.equal(readPage.parseMoney('$1,299.00'), 1299);
  assert.equal(readPage.parseMoney('24.99'), 24.99);
  assert.equal(readPage.parseMoney('$14.99 - $27.50'), null, 'a range must not resolve');
  assert.equal(readPage.parseMoney('$12.00 to $15.00'), null);
  assert.equal(readPage.parseMoney(''), null);
  assert.equal(readPage.parseMoney(null), null);
  assert.equal(readPage.parseMoney('Currently unavailable'), null);
});

test('extract() rejects a non-document rather than returning empty fields', () => {
  assert.throws(() => readPage.extract(null, 'x'), TypeError);
  assert.throws(() => readPage.extract({}, 'x'), TypeError);
});

test('08 prodDetails: a rank in the older two-table layout is read', { skip }, () => {
  // THE REGRESSION. The selector list covered four layouts and not this one,
  // so a live page with "#53,343 in Sports & Outdoors" visible on it reported
  // "not found". Nothing was wrong with the parsing -- the row was never
  // looked at.
  const r = readPage.extract(load('08-proddetails-bsr.html'), URL_FOR('B0H8QLSNPP'));

  assert.equal(r.bsr.found, true, 'the #prodDetails rank is still invisible to the reader');
  assert.equal(r.bsr.value, 53343);

  // The ROOT category, not the specific one. The row carries "#412 in Yoga
  // Mats" as well, and Amazon prints the root rank as the headline -- as does
  // the provider summary, so taking the specific one would put two different
  // numbers in two tiles on the same screen.
  assert.equal(r.bsr.category, 'Sports & Outdoors');
  assert.equal(r.bsr.text, '#53,343 in Sports & Outdoors');

  // The "(See Top 100 ...)" link sits between the two ranks. If the category
  // capture ever swallows it, this is what fails first.
  assert.ok(!/top 100/i.test(r.bsr.category), 'the parenthetical leaked into the category');
});

test('09 offers panel: the real capture, and the four things it settled', { skip }, () => {
  // THE FIRST NON-SYNTHETIC FIXTURE. Trimmed and scrubbed from a real
  // B0H8QLSNPP capture, so unlike the others a green run here IS evidence the
  // parser survives Amazon's markup -- for this one layout, on this one day.
  const r = readPage.extract(load('09-offers-panel.html'), URL_FOR('B0H8QLSNPP'));
  const o = r.offers;

  assert.equal(o.found, true, 'the offers panel is invisible to the reader');

  // SEVEN offers: the pinned Buy Box plus six. Amazon's own hidden counter
  // says 6, counting only the others, so reporting that figure as the number
  // of sellers is off by one on every ASIN.
  assert.equal(o.count, 7);
  assert.equal(o.totalOthers, 6);
  assert.equal(o.count, o.totalOthers + 1, 'the pinned offer stopped being counted');

  // 1. The Buy Box is the pinned offer, and it is NOT simply the cheapest --
  //    three offers tie at 64.97 and Amazon picked one of them.
  assert.equal(o.buyBox.sellerName, 'J & M COLLECTIBLES');
  assert.equal(o.buyBox.isBuyBox, true);
  assert.equal(o.offers.filter((x) => x.landed === 64.97).length, 3, 'the three-way price tie stopped parsing');

  // 2. LANDED COST, and this is the one that would have cost money. The page
  //    shows the FBM offer as $68.95 and charges $8.33 to deliver it. Ranked
  //    on the displayed price it looks like the fourth-cheapest offer; ranked
  //    on what it costs to receive, it is the second DEAREST.
  const fbm = o.fbmLow;
  assert.equal(fbm.sellerName, 'Treasureton');
  assert.equal(fbm.price, 68.95);
  assert.equal(fbm.shipping, 8.33);
  assert.equal(fbm.landed, 77.28, 'shipping is no longer added, so FBM reads cheaper than it is');
  assert.ok(fbm.landed > o.offers.filter((x) => x.fba).map((x) => x.landed).sort((a, b) => a - b)[4],
    'the FBM offer now ranks below FBA offers it is dearer than');

  // 3. FBA vs FBM comes from isAmazonFulfilled in the sold-by href, never from
  //    the words "Ships from Amazon.com" -- which are localised prose, and
  //    this extension already supports ten marketplaces.
  assert.equal(fbm.fba, false);
  assert.equal(o.offers.filter((x) => x.fba === true).length, 6);
  assert.equal(o.offers.filter((x) => x.fba === false).length, 1);
  const src = fs.readFileSync(path.join(__dirname, '..', 'readPage.js'), 'utf8');
  const slice = src.slice(src.indexOf('function readOneOffer'), src.indexOf('function readOffers'));
  assert.ok(/isAmazonFulfilled/.test(slice), 'the fulfilment discriminator has gone');
  assert.ok(!/Ships from Amazon/i.test(slice.replace(/\/\/[^\n]*/g, '')),
    'fulfilment is being decided from localised prose');

  // 4. Every offer block carries id="aod-offer". Seven elements, one id.
  assert.equal(load('09-offers-panel.html').querySelectorAll('#aod-offer').length, 6,
    'the fixture no longer reproduces the duplicate-id layout');

  // The cheapest FBA offer, which is what a seller actually competes with.
  assert.equal(o.fbaLow.sellerName, 'J & M COLLECTIBLES');
  assert.equal(o.fbaLow.landed, 64.97);

  // Amazon is not an offer here, and that is an ANSWER about the competition.
  assert.equal(o.amazon, null);

  // Seller quality, with the WINDOW kept: 97% over a lifetime and 97% over
  // twelve months are different claims about a seller.
  assert.equal(fbm.positivePct, 97);
  assert.equal(fbm.positiveWindow, 'lifetime');
  const buckeye = o.offers.find((x) => /Buckeye/.test(x.sellerName));
  assert.equal(buckeye.stars, 4);
  assert.equal(buckeye.positivePct, 77);
  assert.equal(buckeye.positiveWindow, '12m');
});

test('09: stock comes from Amazon, never from another extension', { skip }, () => {
  // The capture arrived with a THIRD-PARTY EXTENSION'S nodes injected into it
  // (.keepaStock divs carrying a per-offer stock figure). Reading those would
  // make this panel silently depend on the user having that extension
  // installed -- it would work on the developer's machine and show nothing for
  // everyone else. The fixture keeps two of them so this stays provable.
  const doc = load('09-offers-panel.html');
  assert.ok(doc.querySelectorAll('.keepaStock').length >= 2,
    'the fixture no longer contains the foreign nodes this test is about');

  const src = fs.readFileSync(path.join(__dirname, '..', 'readPage.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/keepa/i.test(code), 'readPage.js now reads another extension\u2019s injected DOM');

  // maxQty from Amazon's own add-to-cart payload instead. It matched the
  // foreign readout on six of seven offers; the seventh was maxQty 30 against
  // "30+", so 30 is a CAP and is reported as a ceiling, not a count.
  const o = readPage.readOffers(doc);
  assert.deepEqual(o.offers.map((x) => x.maxQty), [18, 8, 2, 30, 20, 1, 3]);
  const capped = o.offers.filter((x) => x.maxQtyIsCap);
  assert.equal(capped.length, 1, 'the 30-item cap is no longer flagged as a ceiling');
  assert.equal(capped[0].maxQty, 30);
});

test('09: no session token survived into the fixture', { skip }, () => {
  // The capture carried seven anti-csrftoken-a2z values and an
  // aod-atc-csrf-token. They are session-scoped and useless without the
  // cookie, and the rule is that no token reaches a public repo regardless.
  const raw = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8');
  for (const [name, rx] of [
    ['a CSRF token', /name="anti-csrftoken-a2z" value="(?!REDACTED")/],
    ['the cart CSRF token', /id="aod-atc-csrf-token"[^>]*value="(?!REDACTED")/],
    ['a long offerListingId', /offerListingId" value="[^"]{40,}/],
    ['a cookie header', /cookie/i],
  ]) {
    assert.ok(!rx.test(raw), 'the scrubbed fixture contains ' + name);
  }
  // Seller ids ARE public on the page and are kept on purpose.
  assert.ok(/seller=A1GD4LR25P9QFR/.test(raw), 'the public seller ids were stripped too');
});

test('a closed offers panel is not-found, not a crash', { skip }, () => {
  // The panel does not exist until the shopper opens it, which is the normal
  // state on every page load. Every other fixture is a page with no panel.
  for (const f of ['01-normal.html', '07-sparse.html']) {
    const o = readPage.extract(load(f), URL_FOR('B07XYZ1234')).offers;
    assert.equal(o.found, false, f + ': invented an offers panel');
    assert.equal(o.count, 0);
    assert.deepEqual(o.offers, []);
    assert.equal(o.buyBox, null);
    assert.equal(o.fbaLow, null);
    assert.equal(o.fbmLow, null);
  }
});
