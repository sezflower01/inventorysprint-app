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
    '07-sparse.html',
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
