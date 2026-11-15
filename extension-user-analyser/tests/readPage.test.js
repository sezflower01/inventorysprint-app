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
    '10-offers-loading.html',
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
  assert.equal(o.buyBox.sellerName, 'Seller A & B');
  assert.equal(o.buyBox.isBuyBox, true);
  assert.equal(o.offers.filter((x) => x.landed === 64.97).length, 3, 'the three-way price tie stopped parsing');

  // 2. LANDED COST, and this is the one that would have cost money. The page
  //    shows the FBM offer as $68.95 and charges $8.33 to deliver it. Ranked
  //    on the displayed price it looks like the fourth-cheapest offer; ranked
  //    on what it costs to receive, it is the second DEAREST.
  const fbm = o.fbmLow;
  assert.equal(fbm.sellerName, 'Seller G');
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
  assert.equal(o.fbaLow.sellerName, 'Seller A & B');
  assert.equal(o.fbaLow.landed, 64.97);

  // Amazon is not an offer here, and that is an ANSWER about the competition.
  assert.equal(o.amazon, null);

  // Seller quality, with the WINDOW kept: 97% over a lifetime and 97% over
  // twelve months are different claims about a seller.
  assert.equal(fbm.positivePct, 97);
  assert.equal(fbm.positiveWindow, 'lifetime');
  const buckeye = o.offers.find((x) => /Seller H/.test(x.sellerName));
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
  assert.ok(/seller=ASYNTH00000001/.test(raw), 'the synthetic seller id was stripped too — the href structure is what the reader parses');
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

test('the pinned offer is in the DOM twice and must be counted once', { skip }, () => {
  // The live drawer carries a hidden #aod-sticky-pinned-offer (shown on
  // scroll) AND the real #aod-pinned-offer, same seller, same price. Taking
  // both reports eight offers for a seven-offer ASIN, lists the Buy Box seller
  // twice, and inflates the FBA count -- all while looking entirely plausible.
  const doc = load('09-offers-panel.html');
  assert.ok(doc.querySelector('#aod-sticky-pinned-offer'), 'the fixture lost the sticky duplicate');
  assert.ok(doc.querySelector('#aod-pinned-offer'), 'the fixture lost the real pinned offer');

  const o = readPage.readOffers(doc);
  assert.equal(o.count, 7, 'the sticky duplicate is being counted as an eighth offer');
  const jm = o.offers.filter((x) => /Seller A & B/.test(x.sellerName));
  assert.equal(jm.length, 1, 'the Buy Box seller appears twice');
  assert.equal(jm[0].isBuyBox, true);
  assert.equal(o.fbaCount + o.fbmCount, 7, 'the fulfilment counts no longer cover every offer');
  assert.equal(o.fbaCount, 6);
  assert.equal(o.fbmCount, 1);
  assert.equal(o.amazonSold, false);
});

test('10 partial: a drawer with offers is READ, however many are missing', { skip }, () => {
  // THIS TEST ASSERTED THE OPPOSITE AND THE OPPOSITE WAS WRONG.
  //
  // It required a drawer showing one of seven offers to report itself as
  // "loading", on the reasoning that the rest were on their way. They are
  // not. The counter says how many offers EXIST, not how many are in the
  // DOM: Amazon ships the first few and fetches the rest only when the
  // shopper clicks "See N more options". So a drawer that has finished
  // everything it will do unasked sits at three offers against a counter of
  // seven -- and waiting for the difference is waiting for a click.
  //
  // The panel sat on "Loading..." for ever, which is the same dead end the
  // old blanket "Not read yet" produced: a state the user cannot act on and
  // cannot distinguish from a hang.
  const o = readPage.readOffers(load('10-offers-loading.html'));
  assert.equal(o.state, 'read', 'a drawer with a parsed offer is reporting itself as loading');
  assert.equal(o.found, true);
  assert.equal(o.count, 1, 'the pinned offer did not parse from the sticky block');
  assert.equal(o.totalOthers, 6, 'the counter was not read');

  // READ but NOT COMPLETE, and the difference is reported rather than waited
  // on. Six offers exist that are not on the page.
  assert.equal(o.complete, false, 'a one-of-seven drawer claimed to be complete');
  assert.equal(o.missing, 6);

  // The figures ARE derived, because the drawer is sorted by price plus
  // delivery ascending -- so whatever is missing is dearer than everything
  // present, and the LOWEST figures cannot be wrong. It is a "none" that
  // becomes unsafe on a partial list, and the panel qualifies those.
  assert.ok(o.buyBox, 'the pinned offer is no longer recognised as the Buy Box');
  assert.equal(o.fbaLow.landed, 64.97);
  assert.equal(o.fbaCount, 1);
});

test('an unsuccessful read says WHICH of the three ways it failed', { skip }, () => {
  // THERE IS NO "LOADING" ANY MORE, and that was the second half of the
  // stuck-panel bug. This reads a DOM snapshot once, on open and on Recheck;
  // nothing observes the drawer afterwards, so no state can resolve itself. A
  // spinner was a promise the code could not keep, and it kept it for as long
  // as the user was willing to stare at it.
  //
  // The three failures want three different responses, so they are three
  // states and the block count is what separates them.

  // 1. closed: no container. The user opens the offer list.
  const closed = readPage.readOffers(load('01-normal.html'));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.blocks, 0);

  // 2. empty: container, no offer blocks. Read in the moment between opening
  //    and filling, or an ASIN with none. Recheck fixes it.
  const empty = new JSDOM('<div id="all-offers-display">'
    + '<div id="all-offers-display-spinner"></div></div>').window.document;
  const e = readPage.readOffers(empty);
  assert.equal(e.state, 'empty', 'an open-but-empty drawer is no longer distinguished');
  assert.equal(e.blocks, 0);
  assert.equal(e.count, 0);

  // 3. unreadable: blocks ARE there and none parsed. NOT a user problem --
  //    Amazon has moved the markup, Recheck will not help, and this is the
  //    only one of the three that needs a code change. The block count is
  //    reported so it can be acted on rather than guessed at.
  const broken = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8')
    .replace(/seller=ASYNTH\w+/g, 'x')
    .replace(/data-csa-c-price-to-pay="[\d.]+"/g, '');
  const u = readPage.readOffers(new JSDOM(broken).window.document);
  assert.equal(u.state, 'unreadable', 'markup that moved is reported as an empty drawer');
  assert.equal(u.blocks, 7, 'the blocks found are not counted, so the diagnosis is lost');
  assert.equal(u.count, 0);

  for (const o of [closed, e, u]) assert.equal(o.found, false);

  // And the word must not come back anywhere in the reader or the panel.
  for (const f of ['readPage.js', 'panel.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/'loading'|"loading"/.test(code),
      f + ' has a loading state again, which nothing can resolve');
  }
});

test('a single-offer product is a complete read, not a stuck spinner', { skip }, () => {
  // THE CASE THE COUNTER EXISTS FOR. One parsed offer looks identical to a
  // half-built drawer unless the counter is consulted: six others promised
  // means loading, zero others promised means done. Get this wrong and the
  // panel says "Loading" forever on every sole-seller ASIN -- which is the
  // population a sourcing panel cares most about.
  const html = fs.readFileSync(path.join(FIX, '10-offers-loading.html'), 'utf8')
    .replace('value="6" id="aod-total-offer-count"', 'value="0" id="aod-total-offer-count"')
    // aok-hidden is how the finished drawer hides its spinner -- the element
    // is always present, so the class is the signal.
    .replace('id="all-offers-display-spinner" class="aod-spinner-wrapper"',
      'id="all-offers-display-spinner" class="aod-spinner-wrapper aok-hidden"');
  const o = readPage.readOffers(new JSDOM(html).window.document);
  assert.equal(o.state, 'read', 'a sole-seller ASIN is stuck reporting itself as loading');
  assert.equal(o.count, 1);
  assert.equal(o.text, '1 offer', 'the singular is not used for one offer');
  assert.ok(o.buyBox, 'the only offer is not recognised as the Buy Box');
});

test('Prime is reported as unstated, never inferred from FBA', { skip }, () => {
  // Every FBA offer is in practice Prime-eligible, so reporting fba as prime
  // would usually be right -- and would be an inference dressed as a reading,
  // which is the one thing this file does not do. The capture carries
  // a-icon-prime only inside the FILTER control, never in an offer block.
  const o = readPage.readOffers(load('09-offers-panel.html'));
  assert.ok(o.offers.every((x) => x.primeStated === false),
    'Prime is being claimed from a page that never said it');
  assert.ok(o.offers.some((x) => x.fba === true), 'the fixture has no FBA offer to test against');

  const src = fs.readFileSync(path.join(__dirname, '..', 'readPage.js'), 'utf8');
  const slice = src.slice(src.indexOf('function readOneOffer'), src.indexOf('function offersState'));
  const code = slice.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/prime[A-Za-z]*\s*[:=]\s*[^;,]*\bfba\b/i.test(code),
    'Prime is being derived from the fulfilment flag');

  // Amazon's own delivery-programme enum IS read, because it is a reading.
  assert.equal(o.offers.find((x) => x.fba === false).deliveryProgram, 'paid_shipping');
  assert.equal(o.buyBox.deliveryProgram, 'cfs');
});

test('no real Amazon seller id or name can get back into a fixture', () => {
  // WHY THIS EXISTS. Fixture 09 was committed with seven real seller ids and
  // names on the reasoning that they are public on the product page. Six were
  // other people's; the seventh was the operator's own business. The argument
  // was sound and the conclusion was wrong, because "visible to any shopper"
  // and "safe for us to commit to a public repo" are different questions.
  //
  // So the rule is now mechanical rather than judged: inside this folder a
  // seller id must look synthetic. Marketplace ids are allowed because they
  // are global constants, not anybody's identity.
  const MARKETPLACES = [
    'ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC',
    'A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'APJ6JRA9NG5V4',
    'A1RKKUPIHCS9HS', 'A1VC38T7YXB528',
  ];
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.html')).map((f) => path.join(FIX, f))
    .concat(fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f)));

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // An Amazon seller id is A followed by 12 or 13 more of [A-Z0-9].
    for (const id of new Set(text.match(/\bA[A-Z0-9]{12,13}\b/g) || [])) {
      if (MARKETPLACES.includes(id)) continue;
      assert.ok(id.startsWith('ASYNTH'),
        path.basename(file) + ' carries a seller id that is not synthetic: ' + id);
    }
  }

  // And the specific names that were published, so a partial revert of the
  // substitution fails loudly instead of leaving one behind.
  //
  // ASSEMBLED FROM FRAGMENTS on purpose: this guard scans the test files too,
  // so spelling the forbidden names out here would make the guard trip on
  // itself -- which it did, and the first instinct was to exclude this file
  // from its own check. That would have left a real hole for the sake of a
  // green run.
  const FORBIDDEN = ['COLLECT' + 'IBLES', 'Maiden' + '3118', 'ACG' + ' ECOM',
    'Treasure' + 'ton', 'Buck' + 'eye'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of FORBIDDEN) {
      assert.ok(!text.includes(name),
        path.basename(file) + ' still carries the real seller name ' + name);
    }
    // Whole word: the operator's business name is short enough to appear
    // inside ordinary words, and a substring test would fail on innocent text.
    assert.ok(!new RegExp('\\bPe' + 'du\\b').test(text),
      path.basename(file) + ' still carries the operator’s own business name');
  }
});

test('the lazy-loaded drawer: what actually stranded the panel', { skip }, () => {
  // THE LIVE FAILURE, 2026-11-14. The panel read "Competitors — / Loading..."
  // and stayed there. Not a slow page: Amazon had finished.
  //
  // The drawer ships the pinned offer plus the first two, and leaves the rest
  // behind a "See 4 more options on Amazon" button that fetches them on
  // click. Fixture 09 was captured AFTER that button had been pressed, which
  // is exactly why the bug was invisible to it -- the fixture showed a state
  // the extension would rarely meet first.
  const lazy = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8')
    .replace(/<div id="aod-retail-other-offers-content"[\s\S]*?\n      <\/div>/,
      '<div id="aod-retail-other-offers-content" class="a-section"></div>');
  const o = readPage.readOffers(new JSDOM(lazy).window.document);

  assert.equal(o.state, 'read', 'the lazy-loaded drawer strands the panel again');
  assert.equal(o.count, 3, 'the pinned offer plus the two visible ones did not parse');
  assert.equal(o.complete, false);
  assert.equal(o.missing, 4, 'the four withheld offers are not counted as missing');

  // The cheap end is all present, because Amazon sorts the drawer by price
  // plus delivery ascending. That is what makes a partial read useful rather
  // than merely available.
  assert.equal(o.fbaLow.landed, 64.97, 'the lowest FBA offer is not in the loaded set');
  assert.equal(o.buyBox.isBuyBox, true);

  // And the FBM offer is among the withheld ones, which is the case where a
  // partial list could mislead: there IS an FBM competitor and none is
  // loaded. The reader reports null, and the panel must not render that as a
  // flat "none" -- it says "none yet" and tells the user to expand the list.
  assert.equal(o.fbmLow, null);
  assert.equal(o.fbmCount, 0);

  const panel = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
  const slice = panel.slice(panel.indexOf('const partly ='), panel.indexOf("putOffer('apx-amz'"));
  assert.match(slice, /none yet/, 'a partial list reports a flat "none" again');
  assert.match(slice, /See more options/, 'the panel no longer says how to load the rest');
});

test('an empty #all-offers-display ahead of the real one must not win', { skip }, () => {
  // THE LIVE FAILURE, 2026-11-14/15. The panel read "The offer list is open
  // but has no offers in it yet" with seven offers visible on screen, and
  // Recheck could not fix it because the scope was wrong on every read.
  //
  // readOffers took doc.querySelector('#all-offers-display') -- the FIRST
  // match -- and scoped every block search inside it. Amazon injects the
  // drawer through a portal (the markup is full of &&&Portal&Delimiter&&&
  // markers) and the page can hold an EMPTY container ahead of the populated
  // one. Searching the empty one finds nothing, for ever.
  //
  // Same wrong assumption as the duplicate pinned offer and the seven
  // elements sharing id="aod-offer": this markup does not honour one element
  // per id, and code here that assumes it will be wrong eventually.
  const populated = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8');
  const inner = populated.slice(populated.indexOf('<div id="all-offers-display"'));
  const decoyFirst = '<html><body><div id="all-offers-display">'
    + '<div id="all-offers-display-spinner" class="aok-hidden"></div></div>' + inner;

  const o = readPage.readOffers(new JSDOM(decoyFirst).window.document);
  assert.equal(o.panels, 2, 'the fixture no longer reproduces two containers');
  assert.equal(o.state, 'read', 'an empty container ahead of the real one strands the read again');
  assert.equal(o.count, 7, 'the offers were read out of the empty container');
  assert.equal(o.fbaLow.landed, 64.97);
  assert.equal(o.scopedTo, 'container', 'the populated container was not chosen');
});

test('offers rendered outside any container are still read', { skip }, () => {
  // The next shape this could take: the drawer injected somewhere that is not
  // an #all-offers-display at all. Falling back to the document costs nothing
  // when a container exists and is the difference between working and not
  // when one does not.
  const html = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8')
    .replace(/<div id="all-offers-display"[^>]*>/, '<div id="somewhere-else">');
  const o = readPage.readOffers(new JSDOM(html).window.document);
  assert.equal(o.panels, 0, 'the container is still present, so this tests nothing');
  assert.equal(o.state, 'read', 'a drawer outside the container is reported as closed');
  assert.equal(o.count, 7);
  assert.equal(o.scopedTo, 'document', 'the document fallback was not used');

  // Parsed offers are READ whatever they were found inside. Checking the
  // container first is what made this case report "closed".
  assert.equal(o.found, true);
});

test('the scope is reported on success, not only on failure', { skip }, () => {
  // "It worked" and "it worked by falling back to a document-wide search
  // because the page had two containers" are different facts. The second is
  // how the next layout change gets noticed before it breaks something.
  const o = readPage.readOffers(load('09-offers-panel.html'));
  assert.equal(o.state, 'read');
  assert.equal(o.panels, 1, 'the container count is missing from a successful read');
  assert.equal(o.scopedTo, 'container');

  const panel = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
  const slice = panel.slice(panel.indexOf("'[InventorySprint Analyser] offers'"),
    panel.indexOf("if (o.state === 'unreadable'"));
  assert.match(slice, /panels: o\.panels/, 'the console line no longer says how many containers there were');
  assert.match(slice, /scopedTo: o\.scopedTo/, 'the console line no longer says which root was read');
});

/** Fixture 09 with the Nth and Mth offer headings turned to a used grade. */
function withUsedOffers(positions) {
  let n = 0;
  return fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8')
    .replace(/(<span class="a-size-base a-text-bold">)New(<\/span>)/g,
      (m, a, b) => { n++; return positions.includes(n) ? a + 'Used - Very Good' + b : m; });
}

test('condition is read, and non-new offers leave the competitive figures', { skip }, () => {
  // THE BOOK ASIN. The drawer returned used copies alongside new ones, and the
  // panel showed a $19.00 row at 33% ROI next to a $36.55 row at 219% with
  // nothing to say they are different goods -- then computed "lowest FBM" from
  // the used one, a price no new-condition seller has to beat.
  const all = readPage.readOffers(load('09-offers-panel.html'));
  assert.equal(all.newCount, 7, 'the all-new capture no longer reads as all new');
  assert.equal(all.excludedByCondition, 0);
  assert.equal(all.conditionUnknown, 0, 'a condition heading stopped parsing');
  assert.equal(all.buyBox.condition, 'New');
  assert.equal(all.buyBox.isNew, true);

  const mixed = readPage.readOffers(new JSDOM(withUsedOffers([4, 5])).window.document);
  assert.equal(mixed.count, 7, 'the used offers were dropped from the list entirely');
  assert.equal(mixed.newCount, 5);
  assert.equal(mixed.excludedByCondition, 2);
  // The counts are over NEW offers only: 6 FBA became 4.
  assert.equal(mixed.fbaCount, 4, 'the FBA count still includes used offers');
  assert.equal(mixed.fbmCount, 1);

  // EVERY offer survives in the list, with its grade, because "why is it
  // cheaper elsewhere?" deserves an answer rather than silence.
  const used = mixed.offers.filter((o) => o.isNew === false);
  assert.equal(used.length, 2);
  for (const o of used) assert.equal(o.condition, 'Used - Very Good',
    'the literal heading text is not carried through');
});

test('the lowest-price figures skip used offers', { skip }, () => {
  // Make the CHEAPEST offer used, which is the shape that actually misleads:
  // the headline "lowest" becomes a price for a different good.
  const html = withUsedOffers([2]); // the first non-pinned offer, at 64.97
  const o = readPage.readOffers(new JSDOM(html).window.document);
  const usedOne = o.offers.find((x) => x.isNew === false);
  assert.ok(usedOne, 'no offer was turned used, so this tests nothing');

  // It is still in the list...
  assert.ok(o.offers.includes(usedOne));
  // ...and it is not what fbaLow points at, unless a NEW offer ties it.
  assert.notEqual(o.fbaLow, usedOne, 'the lowest FBA figure is a used offer');
  assert.equal(o.fbaLow.isNew, true, 'the lowest FBA offer is not new condition');
});

test('a condition that could not be read is kept, not assumed used', { skip }, () => {
  // An unparsed heading is not evidence of condition. Dropping an offer on a
  // failed read is how a real competitor disappears with no trace -- so it
  // counts, and is marked instead.
  const html = fs.readFileSync(path.join(FIX, '09-offers-panel.html'), 'utf8')
    .replace(/<div id="aod-offer-heading"[\s\S]*?<\/div>/, '');
  const o = readPage.readOffers(new JSDOM(html).window.document);

  assert.equal(o.conditionUnknown, 1, 'a missing heading is no longer reported');
  assert.equal(o.excludedByCondition, 0, 'an unreadable condition was treated as used');
  assert.equal(o.newCount, o.count, 'an offer was excluded for a condition nobody could read');
  const unknown = o.offers.find((x) => x.isNew === null);
  assert.equal(unknown.condition, null);

  // null and false are different answers and must stay so.
  const src = fs.readFileSync(path.join(__dirname, '..', 'readPage.js'), 'utf8');
  assert.match(src, /o\.isNew !== false/,
    'the filter uses a truthiness test, which would drop unreadable conditions too');
});
