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
    assert.equal(chip.textContent.trim(), 'Not checked yet', `${f}: eligibility chip showed something else`);
    assert.ok(chip.classList.contains('apx-sa-unknown'), `${f}: eligibility chip is not in the unknown state`);
  }
});

test('no money field ever shows a number we could not compute', { skip }, () => {
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading));

  for (const id of ['apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost', 'apx-sa-margin', 'apx-sa-sales']) {
    const el = $(id);
    assert.ok(el, `${id} is missing from the markup`);
    assert.equal(el.textContent.trim(), 'Not checked yet', `${id} showed something other than the not-read state`);
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

  // Now that sign-in happens in the panel, nothing from the original is
  // missing at all.
  const missing = oldIds.filter((i) => !newSet.has(i));
  assert.deepEqual(missing, [], 'the port lost ids the original has');

  // Order of the shared ids must match, or sections have moved.
  const sharedOld = oldIds.filter((i) => newSet.has(i));
  const sharedNew = newIds.filter((i) => oldSet.has(i));
  assert.deepEqual(sharedNew, sharedOld, 'shared element ids are in a different order than the original');
});

// ── the password rules ───────────────────────────────────────────────────
//
// REPLACES "THE RULE: the panel has no password or email input". The panel
// now signs in and creates accounts in place, because sending someone to a
// website to come back is not a sign-in flow, it is an interruption.
//
// What made the old rule worth having was never "no password field" as such
// -- it was "Amazon's page cannot read what the user types". The iframe on
// the chrome-extension:// origin gives that outright: same-origin policy, not
// politeness. So the blanket ban is replaced by the four narrower promises
// that actually carry the weight, each of which can fail silently and so each
// of which gets a test.

test('the only password field is the sign-in one, and it is in the sign-in form', { skip }, () => {
  const html = fs.readFileSync(path.join(ROOT, 'panel.html'), 'utf8');
  const pw = html.match(/<input[^>]*type="password"[^>]*>/g) || [];
  assert.equal(pw.length, 1, `expected exactly one password input, found ${pw.length}`);
  assert.ok(/apx-signin-password/.test(pw[0]), `the password input is not the sign-in one: ${pw[0]}`);

  const form = html.slice(html.indexOf('id="apx-signin-form"'), html.indexOf('</form>'));
  assert.ok(form.includes('apx-signin-password'), 'the password field is outside the sign-in form');

  // Autocomplete matters: without it a manager will not offer to save, and
  // people reuse a password they cannot store.
  assert.ok(/autocomplete="current-password"/.test(pw[0]), 'the password field has no autocomplete hint');
  const em = html.match(/<input[^>]*id="apx-signin-email"[^>]*>/g) || [];
  assert.equal(em.length, 1, 'the sign-in email field is missing');
  assert.ok(/autocomplete="username"/.test(em[0]), 'the email field has no autocomplete hint');
});

test('the password is never written to storage', { skip }, () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  for (const m of bg.matchAll(/storage\.local\.set\(([^;]{0,200})/g)) {
    assert.ok(!/password/i.test(m[1]), `a storage write mentions password: ${m[1].slice(0, 80)}`);
  }
  // setSession is the only thing that persists auth, and it must persist
  // tokens only.
  const setSession = bg.slice(bg.indexOf('async function setSession'), bg.indexOf('async function clearSession'));
  assert.ok(!/password/i.test(setSession), 'setSession touches a password');
});

test('the password is never logged', { skip }, () => {
  for (const f of ['background.js', 'panel.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/console\.\w+\(([^;]{0,200})/g)) {
      assert.ok(!/password/i.test(m[1]), `${f}: a console call mentions password: ${m[1].slice(0, 80)}`);
    }
  }
});

test('the password is sent to exactly one place: the Supabase auth endpoint', { skip }, () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

  // Every fetch whose body carries the password must target /auth/v1/ on the
  // configured Supabase host, and nothing else may carry it at all.
  const carriers = [...bg.matchAll(/fetch\(([\s\S]{0,420}?)\)\s*;/g)]
    .filter((m) => /JSON\.stringify\(\{\s*email,\s*password\s*\}\)/.test(m[1]));

  assert.ok(carriers.length >= 2, `expected sign-in and sign-up to send credentials, found ${carriers.length}`);
  for (const c of carriers) {
    assert.ok(/CFG\.SUPABASE_URL/.test(c[1]), 'credentials are sent to a host other than SUPABASE_URL');
    assert.ok(/\/auth\/v1\//.test(c[1]), 'credentials are sent to something other than the auth endpoint');
  }

  // And the panel itself must never make the call -- it hands them to the
  // worker and nothing else.
  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  assert.ok(!/fetch\s*\(/.test(panel), 'panel.js makes a fetch of its own; auth belongs in the worker');
});

test('sign-up distinguishes "confirm your email" from "you are in"', { skip }, () => {
  // Conflating these is the classic bug: the panel says signed in, the
  // account is dormant until the link is clicked, and nothing works.
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const fn = bg.slice(bg.indexOf('async function signUpWithPassword'), bg.indexOf('/**\n * Refresh when'));
  assert.ok(/confirmationRequired/.test(fn), 'sign-up does not report the confirmation case');
  assert.ok(/access_token\s*&&\s*data\?\.refresh_token/.test(fn), 'sign-up does not check for a real session before claiming one');

  const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
  assert.ok(/confirmationRequired/.test(panel), 'the panel ignores the confirmation case');
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
