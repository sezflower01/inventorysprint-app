// Renders the real panel from content.js against the fixtures and inspects the
// DOM it produces.
//
// The parser tests prove `extract()` returns "not found". They do NOT prove the
// panel PRINTS it -- a field could read correctly and still render as an empty
// cell, which on screen is indistinguishable from a value of nothing and is
// exactly the ambiguity this build exists to remove. So this asserts on the
// rendered output.
//
// content.js is a content script, not a module: it runs an IIFE against the
// globals a browser gives it. It is loaded here the way Chrome loads it --
// evaluated against a jsdom window with a `chrome` stub -- rather than being
// refactored into something importable, so the thing under test is the file
// that actually ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let JSDOM = null;
let skip = false;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  skip = 'jsdom not installed -- run `npm install` inside extension-user-analyser/';
}

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const srcOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * Load a fixture as the page, run the three content scripts in order, and
 * return the panel element from inside the shadow root.
 *
 * The root is closed, so `host.shadowRoot` is null by design -- that is the
 * point of it. The test grabs the root from attachShadow's return value by
 * wrapping it, which is the only way in and proves no page script could do the
 * same.
 */
function renderPanel(fixture, url) {
  const dom = new JSDOM(fs.readFileSync(path.join(FIX, fixture), 'utf8'), { url });
  const { window } = dom;

  let captured = null;
  const realAttach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    const root = realAttach.call(this, { ...init, mode: 'open' });
    captured = root;
    return root;
  };

  const sent = [];
  window.chrome = {
    runtime: {
      id: 'test',
      sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb({ ok: true }); },
      lastError: null,
    },
  };

  const ctx = vm.createContext(window);
  for (const f of ['readPage.js', 'panelCss.js', 'content.js']) {
    vm.runInContext(srcOf(f), ctx, { filename: f });
  }
  return { window, root: captured, sent, dom };
}

const URL_FOR = (asin) => `https://www.amazon.com/dp/${asin}`;

test('a normal page renders every value, each with its source label', { skip }, () => {
  const { root } = renderPanel('01-normal.html', URL_FOR('B07XYZ1234'));
  assert.ok(root, 'no shadow root was created');
  const text = root.textContent;
  assert.match(text, /B07XYZ1234/);
  assert.match(text, /Acme Stainless Steel Water Bottle/);
  assert.match(text, /\$24\.99/);
  assert.match(text, /Acme Direct/);
  assert.match(text, /#1,432 in Kitchen/);

  // One source label per field row, and in this build all say the same thing.
  const srcs = [...root.querySelectorAll('.isua-src')].map((n) => n.textContent);
  assert.equal(srcs.length, 9, 'expected one source label per field');
  assert.ok(srcs.every((s) => s === 'read from this page'),
    'a field carried a source other than the page: ' + [...new Set(srcs)].join(', '));
});

test('a missing field PRINTS "not found" rather than rendering blank', { skip }, () => {
  const { root } = renderPanel('02-no-buybox.html', URL_FOR('B01NOBOX99'));
  const missing = [...root.querySelectorAll('.isua-missing')];
  assert.ok(missing.length >= 3, `expected several missing fields, found ${missing.length}`);
  for (const n of missing) {
    assert.equal(n.textContent, 'not found', 'a missing field rendered as something else');
  }
  // No field is ever empty on screen.
  for (const n of root.querySelectorAll('.isua-val')) {
    assert.notEqual(n.textContent.trim(), '', 'a field rendered as an empty string');
  }
});

test('the gating block carries no verdict, no number and no colour class', { skip }, () => {
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.html'))) {
    const { root } = renderPanel(f, URL_FOR('B07XYZ1234'));
    if (!root) continue; // 07-sparse has no ASIN, so no panel -- asserted below
    const gate = root.querySelector('.isua-gate');
    assert.ok(gate, `${f}: gating block missing`);
    assert.match(gate.textContent, /Not checked in this version/);
    // The words that would turn a non-answer into an answer.
    assert.doesNotMatch(gate.textContent, /\b(eligible|not eligible|gated|ungated|approved|restricted|allowed)\b/i,
      `${f}: the gating block used verdict language`);
    const link = gate.querySelector('a');
    assert.ok(link, `${f}: no Seller Central link`);
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('href'), /^https:\/\/sellercentral\.amazon\.com\//);
    // No success/warning/danger styling anywhere in the panel.
    assert.equal(root.querySelectorAll('[class*="success"],[class*="danger"],[class*="warn"],[class*="green"],[class*="red"]').length, 0,
      `${f}: a verdict-coloured class appeared`);
  }
});

test('no panel is injected when the page has no ASIN', { skip }, () => {
  const { root, window } = renderPanel('07-sparse.html', 'https://www.amazon.com/some/other/path');
  assert.equal(root, null, 'a panel was built for a page with no ASIN');
  assert.equal(window.document.getElementById('isua-panel-host'), null);
});

test('Save sends only page-read fields, and never a derived or owner value', { skip }, () => {
  const { root, sent, window } = renderPanel('01-normal.html', URL_FOR('B07XYZ1234'));
  // The event has to be constructed by the SAME window the node belongs to --
  // a jsdom node will not accept an Event from another realm.
  root.querySelector('.isua-btn').dispatchEvent(new window.Event('click', { bubbles: true }));

  const save = sent.find((m) => m.type === 'ISUA_SAVE_READING');
  assert.ok(save, 'Save did not send a message');
  assert.deepEqual(Object.keys(save.reading).sort(), [
    'asin', 'bsr', 'buy_box_seller', 'page_url', 'price_text', 'seller_count', 'title',
  ], 'the saved field set changed -- update PRIVACY.md in the same commit');
  // The query string is stripped before the URL is sent.
  assert.equal(save.reading.page_url, 'https://www.amazon.com/dp/B07XYZ1234');
  assert.ok(!('roi' in save.reading) && !('fees' in save.reading) && !('eligible' in save.reading),
    'a derived or gating field reached the save payload');
});
