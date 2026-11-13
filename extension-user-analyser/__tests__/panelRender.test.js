// Render tests for the panel.
//
// ── WHY THIS FILE WAS REWRITTEN ──────────────────────────────────────────
//
// The previous version intercepted Element.prototype.attachShadow and read the
// panel out of a closed shadow root, because content.js built the panel in JS.
// The panel is now an iframe loading panel.html, whose markup and stylesheet
// are copies of extension/'s so the two look identical. There is no shadow
// root to intercept any more, so the harness loads panel.html into jsdom and
// runs panel.js against it.
//
// The assertions are the same four promises as before, kept deliberately:
//
//   1. a value that WAS read from the page is shown
//   2. a value that was NOT found prints "not found", never a blank
//   3. the gating row carries no verdict, no number and no colour
//   4. no panel is mounted on a page with no ASIN
//
// One assertion could not be carried over as written: "Save sends only
// page-read fields". The ported markup has no Save control, because the panel
// it copies has none -- see the note on that test below. The guarantee is
// re-pinned at the worker instead, so it is not simply dropped.
//
// Added here, because the port created two new ways to break silently:
//
//   5. panel.html keeps every element id of extension/panel.html, in order
//   6. no password or email input exists anywhere in the panel
//   7. content.js's inline frame geometry still matches panel.css

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let JSDOM, skip = false;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  skip = 'jsdom not installed -- run npm install in extension-user-analyser/';
}

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OLD = path.join(ROOT, '..', 'extension');
const srcOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const URL_FOR = (asin) => `https://www.amazon.com/dp/${asin}`;

/**
 * The shape content.js posts into the panel. Mirrored here rather than
 * imported, because content.js is an IIFE with nothing exported -- and a test
 * below asserts the two key sets still agree, so the mirror cannot drift
 * unnoticed.
 */
function wire(reading, marketplace = 'US') {
  const f = (x) => (x ? { found: !!x.found, text: x.text ?? null, value: x.value ?? null, source: x.source ?? null } : null);
  return {
    asin: f(reading.asin),
    title: f(reading.title),
    price: f(reading.price),
    buyBoxSeller: f(reading.buyBoxSeller),
    sellerCount: f(reading.sellerCount),
    bsr: f(reading.bsr),
    availability: f(reading.availability),
    variationParent: f(reading.variationParent),
    isBook: f(reading.isBook),
    gating: reading.gating ? { text: reading.gating.text, sellerCentralUrl: reading.gating.sellerCentralUrl } : null,
    marketplace,
    pageUrl: 'https://www.amazon.com/dp/TEST',
  };
}

/** Read a fixture with readPage.js, exactly as the content script does. */
function readFixture(fixture, url) {
  const dom = new JSDOM(fs.readFileSync(path.join(FIX, fixture), 'utf8'), { url });
  const ctx = vm.createContext(dom.window);
  vm.runInContext(srcOf('readPage.js'), ctx, { filename: 'readPage.js' });
  // readPage.js assigns to globalThis, which inside a vm context is the context
  // object -- NOT dom.window. So the extraction has to run in the context too;
  // reaching for dom.window.ISUA from out here finds undefined.
  return vm.runInContext('globalThis.ISUA.readPage.extract(document, location.href)', ctx);
}

/** Load panel.html, run panel.js, feed it a reading. */
function renderPanel(reading) {
  const dom = new JSDOM(srcOf('panel.html'), {
    url: 'chrome-extension://test/panel.html',
    resources: undefined, // do not fetch the font stylesheet
  });
  const { window } = dom;

  const sent = [];
  const posted = [];
  window.chrome = {
    runtime: {
      id: 'test',
      getManifest: () => JSON.parse(srcOf('manifest.json')),
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (cb) cb({ ok: true, signedIn: true, email: 'someone@example.invalid' });
      },
      lastError: null,
    },
    tabs: { create: (o) => posted.push(o) },
  };
  // panel.js posts to `parent`; in jsdom that is the window itself.
  const realPost = window.postMessage.bind(window);
  window.postMessage = (msg, origin) => { posted.push(msg); return realPost(msg, origin); };

  const ctx = vm.createContext(window);
  vm.runInContext(srcOf('panel.js'), ctx, { filename: 'panel.js' });

  if (reading) {
    const ev = new window.MessageEvent('message', {
      data: { source: 'isua-host', type: 'PAGE_READING', reading },
    });
    // Two jsdom/vm quirks, both harness-only:
    //
    //   1. MessageEvent's constructor drops `source` from the init dict, so it
    //      has to be forced on afterwards.
    //   2. Inside a contextified sandbox `globalThis !== window`, so the
    //      `parent` that panel.js compares against is NOT `window.parent`.
    //      It has to be read out of the context.
    //
    // panel.js refuses a message whose e.source is not its parent, because any
    // script on the Amazon page can postMessage into the frame and the reading
    // drives what is displayed. That check is the point of it: the harness
    // bends to satisfy the guard, never the other way round.
    Object.defineProperty(ev, 'source', { value: vm.runInContext('parent', ctx), configurable: true });
    window.dispatchEvent(ev);
  }

  const $ = (id) => window.document.getElementById(id);
  return { window, $, sent, posted, text: (id) => ($(id) ? $(id).textContent.trim() : null) };
}

// ── 1 ────────────────────────────────────────────────────────────────────

test('a value read from the page is shown in the field the old panel uses', { skip }, () => {
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { text, $ } = renderPanel(wire(reading));

  assert.equal(text('apx-asin'), 'B07XYZ1234');
  assert.equal(text('apx-mkt'), 'US');

  // Buy Box owner and seller count come off the page, so they must be real.
  assert.ok(text('apx-bb') && text('apx-bb') !== 'not found', 'Buy Box seller was read but not rendered');
  assert.ok(text('apx-sellers') && text('apx-sellers') !== 'not found', 'seller count was read but not rendered');

  // Price lands in the read-only Sale input, as in the original.
  assert.ok($('apx-sale').value.length > 0, 'price was read but the Sale input is empty');
});

// ── 2 ────────────────────────────────────────────────────────────────────

test('a missing field PRINTS "not found" rather than rendering blank', { skip }, () => {
  const reading = readFixture('02-no-buybox.html', URL_FOR('B01NOBOX99'));
  const { text } = renderPanel(wire(reading));

  assert.equal(text('apx-asin'), 'B01NOBOX99');
  // A blank here would read as "no competition", which is the opposite of
  // "we could not tell".
  assert.equal(text('apx-bb'), 'not found');
});

// ── 3 ────────────────────────────────────────────────────────────────────

test('the gating row carries no verdict, no number and no colour', { skip }, () => {
  for (const f of ['01-normal.html', '04-out-of-stock.html', '07-sparse.html']) {
    const reading = readFixture(f, URL_FOR('B07XYZ1234'));
    const { $, text } = renderPanel(wire(reading));

    const pill = $('apx-elig');
    assert.equal(text('apx-elig'), 'Not checked', `${f}: status pill should state it was not checked`);
    assert.ok(!/\d/.test(pill.textContent), `${f}: a number appeared in the gating pill`);
    for (const c of ['apx-good', 'apx-bad', 'apx-warn', 'apx-sa-good', 'apx-sa-bad']) {
      assert.ok(!pill.classList.contains(c), `${f}: gating pill carries the verdict class ${c}`);
    }

    // The eligibility chip in the decision table is backend-derived, so it
    // must say so and must not be coloured either.
    const chip = $('apx-sa-eligible');
    assert.equal(chip.textContent.trim(), 'Connect Amazon', `${f}: eligibility chip showed something else`);
    assert.ok(chip.classList.contains('apx-sa-unknown'), `${f}: eligibility chip is not in the unknown state`);
  }
});

test('no money field ever shows a number we could not compute', { skip }, () => {
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading));

  for (const id of ['apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost', 'apx-sa-margin', 'apx-sa-sales']) {
    const el = $(id);
    assert.ok(el, `${id} is missing from the markup`);
    assert.equal(el.textContent.trim(), 'Connect Amazon', `${id} showed something other than the connect state`);
    assert.ok(!/\d/.test(el.textContent), `${id} rendered a digit`);
    for (const c of ['apx-good', 'apx-bad', 'apx-warn']) {
      assert.ok(!el.classList.contains(c), `${id} carries the verdict class ${c}`);
    }
  }

  // And the decision strip must not imply a decision.
  assert.ok(!/BUY|SKIP|PASS|Cautious/i.test($('apx-dm-action').textContent),
    'the decision line reads like a verdict');
});

// ── 4 ────────────────────────────────────────────────────────────────────

test('no panel is mounted when the page has no ASIN', { skip }, () => {
  // 07-sparse has no ASIN in the fixture's URL-free markup; drive content.js
  // with a URL that carries none either.
  const dom = new JSDOM(fs.readFileSync(path.join(FIX, '07-sparse.html'), 'utf8'), {
    url: 'https://www.amazon.com/s?k=kettle',
  });
  const { window } = dom;
  window.chrome = {
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, sendMessage: () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const ctx = vm.createContext(window);
  for (const f of ['readPage.js', 'content.js']) {
    vm.runInContext(srcOf(f), ctx, { filename: f });
  }
  assert.equal(window.document.getElementById('isua-panel-frame'), null,
    'an iframe was mounted on a page with no ASIN');
});

// ── 5 ────────────────────────────────────────────────────────────────────
//
// REPLACES "Save sends only page-read fields, and never a derived or owner
// value". The ported markup has no Save control: extension/panel.html has
// none, and the point of the port is to match it. The worker still has the
// save path (ISUA_SAVE_READING), so the promise is pinned there instead of
// being dropped along with the button. If a Save control is added back to the
// panel, extend this to cover the caller too.

test('the worker save path still accepts page-read fields only', { skip }, () => {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const handler = src.slice(src.indexOf('ISUA_SAVE_READING'));
  assert.ok(handler.length > 0, 'the save handler has gone');

  for (const bad of ['fee', 'roi', 'profit', 'margin', 'maxcost', 'max_cost', 'eligib', 'verdict', 'refresh_token']) {
    assert.ok(!new RegExp(bad, 'i').test(handler.slice(0, 1200)),
      `the save handler mentions "${bad}" -- only page-read fields belong in it`);
  }
});

// ── 6: the port itself ───────────────────────────────────────────────────

test('panel.html keeps every element id of the original, in the same order', { skip }, () => {
  const ids = (p) => (fs.readFileSync(p, 'utf8').match(/id="[^"]+"/g) || []).map((s) => s.slice(4, -1));
  const oldIds = ids(path.join(OLD, 'panel.html'));
  const newIds = ids(path.join(ROOT, 'panel.html'));
  const newSet = new Set(newIds);
  const oldSet = new Set(oldIds);

  // The only ids allowed to be absent are the two sign-in inputs, which this
  // extension deliberately does not have.
  const missing = oldIds.filter((i) => !newSet.has(i));
  assert.deepEqual(missing.sort(), ['apx-signin-email', 'apx-signin-password'],
    'the port lost ids the original has (or gained one back)');

  // Order of the shared ids must match, or sections have moved.
  const sharedOld = oldIds.filter((i) => newSet.has(i));
  const sharedNew = newIds.filter((i) => oldSet.has(i));
  assert.deepEqual(sharedNew, sharedOld, 'shared element ids are in a different order than the original');
});

test('THE RULE: the panel has no password or email input', { skip }, () => {
  const html = fs.readFileSync(path.join(ROOT, 'panel.html'), 'utf8');
  assert.ok(!/type="password"/i.test(html), 'a password field appeared in the panel');
  // The simulator's notify-email field is a plain notification address, not a
  // credential, and is the only email input allowed. Match the WHOLE tag: the
  // id sits before type=, so a forward-only match misses it.
  const emails = (html.match(/<input[^>]*type="email"[^>]*>/g) || []);
  assert.equal(emails.length, 1, `expected exactly one email input (the alert address), found ${emails.length}`);
  assert.ok(/apx-sim-alert-email/.test(emails[0]), `the only email input should be the alert address, got: ${emails[0]}`);
});

// ── 7 ────────────────────────────────────────────────────────────────────

test('the frame geometry in content.js still matches panel.css', { skip }, () => {
  // content.js styles its iframe inline rather than relying on panel.css's
  // #invsprnt-panel-frame rule, because this extension uses a different frame
  // id -- both extensions get installed side by side and one id answering to
  // two elements is its own bug. That makes drift possible, so: compare them.
  const css = fs.readFileSync(path.join(ROOT, 'panel.css'), 'utf8');
  const block = css.slice(css.indexOf('#invsprnt-panel-frame'));
  const rule = block.slice(0, block.indexOf('}'));
  const js = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const frameStyle = js.slice(js.indexOf('const FRAME_STYLE'), js.indexOf('const SIZE'));

  const pairs = [
    ['top', '96px'],
    ['right', '16px'],
    ['width', '360px'],
    ['height', '640px'],
    ['border-radius', '14px'],
    ['z-index', '2147483647'],
  ];
  for (const [prop, value] of pairs) {
    assert.ok(rule.includes(`${prop}: ${value}`), `panel.css no longer sets ${prop}: ${value}`);
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(
      new RegExp(`${camel}:\\s*'${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(frameStyle),
      `content.js FRAME_STYLE no longer sets ${camel}: '${value}' -- it has drifted from panel.css`,
    );
  }
});

test('the reading posted into the panel carries no backend-derived field', { skip }, () => {
  // wire() above mirrors content.js. Assert the real one has the same keys, so
  // the mirror cannot go stale, and that nothing fee-like is being sent in.
  const js = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fn = js.slice(js.indexOf('function wireFormat'), js.indexOf('let reading = read()'));
  for (const key of Object.keys(wire({ asin: null, gating: null }))) {
    assert.ok(fn.includes(`${key}:`), `content.js wireFormat no longer sends "${key}" -- update wire() here too`);
  }
  for (const bad of ['fee', 'roi', 'profit', 'margin', 'refresh_token', 'access_token']) {
    assert.ok(!new RegExp(`\\b${bad}`, 'i').test(fn), `wireFormat passes "${bad}" into the panel`);
  }
});
