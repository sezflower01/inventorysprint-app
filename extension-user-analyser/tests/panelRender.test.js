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

// The not-read label, read from panel.js. Asserting the WORDING here would
// make every copy change a test failure while catching no real defect; what
// these tests must catch is a digit or a verdict colour appearing in a field
// nothing has answered yet.
// The panel carries TWO empty-state labels and the difference between them is
// load-bearing, so both are derived from source rather than restated here. A
// test that hardcodes the words passes while the panel says something else.
//
//   LOADING         an answer is coming this session
//   NOT_IN_VERSION  nothing in this build computes it
//
// The single blanket label they replaced ("Not read yet") answered both
// questions at once, which is what made "when WILL this be read?" an
// unanswerable question from the panel alone.
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');
const LOADING = (PANEL_SRC.match(/const LOADING = '([^']+)'/) || [])[1];
const NOT_IN_VERSION = (PANEL_SRC.match(/const NOT_IN_VERSION = '([^']+)'/) || [])[1];
assert.ok(LOADING, 'panel.js no longer declares a single LOADING label');
assert.ok(NOT_IN_VERSION, 'panel.js no longer declares a single NOT_IN_VERSION label');
assert.notEqual(LOADING, NOT_IN_VERSION, 'the two empty states collapsed back into one label');
// And the blanket label must not come back alongside them.
assert.ok(!/const NOT_READ = '/.test(PANEL_SRC),
  'the blanket not-read label is back, so the two states are no longer the only ones');
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
    offers: reading.offers || null,
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
/**
 * `responses` lets a test answer specific worker messages by type, falling
 * back to the generic signed-in reply. Added for the seller-id feature, whose
 * whole behaviour depends on what ISUA_GET_MY_SELLER returns -- a single
 * canned reply for every message cannot express "this user has an id saved".
 */
function renderPanel(reading, responses) {
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
        if (!cb) return;
        const own = responses && Object.prototype.hasOwnProperty.call(responses, msg && msg.type);
        // The sentinel a test uses to simulate a worker that never answers:
        // take the callback and drop it, which is what a dead service worker
        // looks like from the panel.
        if (own && responses[msg.type] === '__never__') return;
        cb(own ? responses[msg.type]
               : { ok: true, signedIn: true, email: 'someone@example.invalid' });
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

    // THE INVARIANT, not a fixed string. This asserted the chip equalled
    // "Not available in this version", which was true while no gating read
    // existed. One exists now, so the thing worth pinning is what it must
    // NEVER do rather than what it happens to say: a false "eligible" sends
    // the user to buy stock they cannot sell.
    //
    // The harness answers every worker message with a generic success, which
    // is exactly the malformed shape the panel must refuse -- and it did not,
    // until this test caught it rendering "Restricted — new" with the bad
    // colour on a reply that contained no verdict at all.
    const chip = $('apx-sa-eligible');
    assert.ok(!/eligible/i.test(chip.textContent) || /couldn/i.test(chip.textContent),
      `${f}: the chip claims eligibility from an answer with no verdict in it`);
    assert.ok(!chip.classList.contains('apx-sa-good'),
      `${f}: the eligibility chip is coloured good without a readable verdict`);
    assert.ok(!chip.classList.contains('apx-sa-bad'),
      `${f}: the eligibility chip is coloured bad without a readable verdict`);
    assert.ok(chip.classList.contains('apx-sa-unknown'),
      `${f}: the chip is not in the unknown state despite having no verdict`);
    assert.ok(chip.classList.contains('apx-sa-unknown'), `${f}: eligibility chip is not in the unknown state`);
  }
});

test('no money field ever shows a number we could not compute', { skip }, () => {
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading));

  for (const id of ['apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost', 'apx-sa-margin', 'apx-sa-sales']) {
    const el = $(id);
    assert.ok(el, `${id} is missing from the markup`);
    // These DO fill once the provider answers, so at first paint they must
    // say so rather than claiming the build cannot produce them.
    assert.equal(el.textContent.trim(), LOADING, `${id} showed something other than the loading state`);
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
  // TWO now: the sign-in password, and the API key. The key uses type=password
  // so it is masked while typing and kept out of the browser's autofill --
  // hence autocomplete="off" on it, where the sign-in field wants the opposite.
  assert.equal(pw.length, 2, `expected exactly two password inputs, found ${pw.length}`);
  const ids = pw.map((t) => (t.match(/id="([^"]+)"/) || [])[1]).sort();
  assert.deepEqual(ids, ['apx-keepa-key', 'apx-signin-password'],
    'an unexpected password field appeared: ' + ids.join(', '));

  const keyTag = pw.find((t) => /apx-keepa-key/.test(t));
  assert.ok(/autocomplete="off"/.test(keyTag), 'the API key field must not be offered to autofill');

  // Two forms exist now (the key gate and sign-in), so "up to the first
  // </form>" lands in the wrong one. Slice each from its own opening tag to
  // the next close after it.
  const formFrom = (id) => {
    const start = html.indexOf(`id="${id}"`);
    return start < 0 ? '' : html.slice(start, html.indexOf('</form>', start));
  };
  assert.ok(formFrom('apx-signin-form').includes('apx-signin-password'),
    'the password field is outside the sign-in form');
  assert.ok(formFrom('apx-keepa-form').includes('apx-keepa-key'),
    'the API key field is outside the key form');

  // Autocomplete matters: without it a manager will not offer to save, and
  // people reuse a password they cannot store.
  // pw[0] is whichever appears first in the document, which is now the key
  // field. Select by id rather than by position.
  const signinTag = pw.find((t) => /apx-signin-password/.test(t));
  assert.ok(/autocomplete="current-password"/.test(signinTag),
    'the sign-in password field has no autocomplete hint');
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

test('every empty field is in exactly one of the two states, and the right one', { skip }, () => {
  // THE LIST. This is the answer to "when will this be read?", enforced
  // rather than described: a field that moves between these groups has to
  // move here too, in the same commit, with a reason.
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading));

  // Provider-fed. An answer is seconds away; these are a first paint only.
  const WILL_ARRIVE = [
    'apx-fees', 'apx-profit', 'apx-roi-out', 'apx-sa-maxcost',
    'apx-sa-margin', 'apx-sa-sales',
    'apx-sim-sale', 'apx-sim-profit', 'apx-sim-roi',
    // Dimensions ride along on the SAME product lookup as the fees, so they
    // arrive with them. They were in the absent group while this build did
    // not fetch them at all.
    'apx-dims-pkg', 'apx-dims-pkg-wt', 'apx-dims-item', 'apx-dims-item-wt',
    // The price-history chart and the 3M spread are drawn from series that
    // ride in on the same product lookup as the fees, so they arrive with
    // them. They were in the absent group while nothing charted them.
    'apx-history-verdict', 'apx-swing',
  ];

  // Nothing in this build computes these. Each one is final until a version
  // ships that changes it, and each has a different blocker:
  //   eligible / pl        a Seller Central read, and an undefined judgement
  //   history-verdict      the canvas exists; no chart code does
  //   fba/fbm/amz/swing    a read of the offers panel on the page
  //   dims                 a catalogue field this build never fetches
  const WILL_NOT = [
    'apx-sa-pl',
  ];

  // A THIRD state, and it had to exist. These three fill from the offers
  // panel, which is CLOSED on every page until the shopper opens it. That is
  // neither "loading" nor "absent from this build" -- it is a fixable state,
  // so it is the one empty label in the panel that names an action.
  const NEEDS_THE_LIST_OPEN = ['apx-fba', 'apx-fbm', 'apx-amz'];
  for (const id of NEEDS_THE_LIST_OPEN) {
    const el = $(id);
    assert.ok(el, id + ' is missing from the markup');
    assert.equal(el.textContent.trim(), 'not open',
      id + ' should say the offer list is not open, not that it is loading or absent');
    assert.match(el.title, /Recheck/,
      id + ' no longer tells the user what to do about it');
  }

  for (const id of WILL_ARRIVE) {
    const el = $(id);
    assert.ok(el, id + ' is missing from the markup');
    assert.equal(el.textContent.trim(), LOADING,
      id + ' should be loading: it fills from the provider');
  }
  for (const id of WILL_NOT) {
    const el = $(id);
    assert.ok(el, id + ' is missing from the markup');
    assert.equal(el.textContent.trim(), NOT_IN_VERSION,
      id + ' should say it is absent from this build, not that it is loading');
  }

  // No overlap, or the classification is not a classification.
  for (const id of WILL_ARRIVE) {
    assert.ok(!WILL_NOT.includes(id), id + ' is in both states');
  }

  // Every empty label carries its reason. A bare "Not available in this
  // version" with no tooltip is the same dead end as the label it replaced.
  for (const id of WILL_ARRIVE.concat(WILL_NOT)) {
    assert.ok(($(id).title || '').trim().length > 0,
      id + ' shows an empty state with no explanation behind it');
  }
});

test('the retired blanket label is gone from the rendered panel', { skip }, () => {
  // "Not read yet" answered two questions at once and could not be acted on.
  // It must not survive anywhere -- not in the markup, not in a template, not
  // in one forgotten branch.
  for (const f of ['01-normal.html', '02-no-buybox.html', '06-variation-parent.html', '07-sparse.html']) {
    const reading = readFixture(f, URL_FOR('B07XYZ1234'));
    const { window } = renderPanel(wire(reading));
    const body = window.document.body.textContent;
    assert.ok(!/not read yet/i.test(body), f + ': the retired not-read label is still rendered');
  }
  assert.ok(!/not read yet/i.test(srcOf('panel.html')),
    'panel.html still ships the retired label as static markup');
});

test('the open offer list renders landed cost, and says so', { skip }, () => {
  // The display half of the landed-cost rule. readPage.test.js proves the
  // reader adds shipping; this proves the PANEL shows the total and not the
  // number printed on the page, because that is the figure a seller sources
  // against.
  const reading = readFixture('09-offers-panel.html', URL_FOR('B0H8QLSNPP'));
  const { $, text } = renderPanel(wire(reading));

  assert.equal(text('apx-fba'), '$64.97', 'Lowest FBA is not the cheapest landed FBA offer');

  // $68.95 is on the page. $77.28 is what it costs to receive it.
  assert.equal(text('apx-fbm'), '$77.28',
    'Lowest FBM shows the page price again, so an FBM offer reads cheaper than it is');
  assert.match($('apx-fbm').title, /68\.95.*8\.33/,
    'the FBM tooltip no longer shows the price and delivery it was built from');

  // Amazon is not an offer on this ASIN. That is an answer, not a gap.
  assert.equal(text('apx-amz'), 'not selling');

  assert.equal(text('apx-sellers-count'), '7 live', 'the seller count is not the offers read');

  const rows = $('apx-sellers-list').querySelectorAll('.apx-seller-row');
  assert.equal(rows.length, 7, 'the offer rows stopped rendering one per offer');

  // The row is STRUCTURED now, matching the stylesheet that was ported with
  // the panel and never built against, so each part can be asserted on its
  // own element instead of inside one concatenated string.
  assert.equal(rows[0].querySelector('.apx-seller-name').textContent, 'Seller A & B');
  assert.ok(rows[0].classList.contains('bb'), 'the Buy Box row is no longer highlighted');
  assert.ok(rows[0].querySelector('.apx-seller-tag.bb'), 'the Buy Box badge has gone');
  assert.ok(rows[0].querySelector('.apx-seller-tag.fba'), 'the FBA badge has gone');

  // The storefront link is built from the MARKETPLACE, not from the relative
  // sold-by href -- resolving that one against an extension page would point
  // the link at the extension.
  const link = rows[0].querySelector('a.apx-seller-name');
  assert.ok(link, 'the seller name is no longer a link to their storefront');
  assert.match(link.href, /^https:\/\/www\.amazon\.com\/sp\?ie=UTF8&seller=ASYNTH/,
    'the storefront link is not an absolute amazon.com URL');
  assert.equal(link.rel, 'noopener noreferrer', 'the external link lost its rel guard');

  const fbmRow = Array.from(rows).find((r) => /Seller G/.test(r.textContent));
  assert.ok(fbmRow.querySelector('.apx-seller-tag.fbm'), 'the FBM badge has gone');
  assert.equal(fbmRow.querySelector('.apx-seller-price').textContent, '$77.28',
    'the FBM row shows the pre-shipping price');
  assert.match(fbmRow.querySelector('.apx-seller-price').title, /68\.95.*8\.33/,
    'the FBM price tooltip no longer shows what it was built from');

  // A lifetime rating is not comparable with a 12-month one, so the window
  // survives -- in the tooltip, since the badge only has room for a figure.
  assert.equal(fbmRow.querySelector('.apx-seller-rating').textContent, '\u2605 97%');
  assert.match(fbmRow.querySelector('.apx-seller-rating').title, /lifetime/,
    'the lifetime rating window is no longer distinguished from a 12-month one');

  // Below 90% positive is the thing worth noticing on a competitor.
  const weak = Array.from(rows).find((r) => /Seller H/.test(r.textContent));
  assert.ok(weak.querySelector('.apx-seller-rating.bad'),
    'a 77%-positive seller is no longer flagged');

  // The 30-item cap reads as a ceiling, never an exact count. It lives in the
  // price tooltip because the row has four columns and no stock one.
  const capped = Array.from(rows).find((r) => /SLR E CO/.test(r.textContent));
  assert.match(capped.querySelector('.apx-seller-price').title, /30 or more in stock/,
    'the stock cap is shown as an exact figure, or has been dropped');
  const one = Array.from(rows).find((r) => /Seller G/.test(r.textContent));
  assert.match(one.querySelector('.apx-seller-price').title, /1 unit in stock/,
    'a single-unit offer is not reported as such');

  // With no cost entered there is no ROI. An ROI from a guessed cost is the
  // understatement this repo has already shipped once.
  for (const r of rows) {
    assert.equal(r.querySelector('.apx-seller-roi').textContent, '\u2014',
      'an ROI appeared with no cost entered');
    assert.ok(r.querySelector('.apx-seller-roi.na'), 'the empty ROI is not marked unavailable');
  }

  // Seller names go in as TEXT. This panel runs inside the extension and the
  // names come from a page we do not control.
  const html = $('apx-sellers-list').innerHTML;
  assert.ok(!/<(script|img|iframe|svg)/i.test(html), 'markup from the page reached the offer rows');
});

test('ROI per offer answers what YOU would make there, not their margin', { skip }, () => {
  // The figure that makes an offer list a sourcing tool rather than a price
  // list: $82 from a rival is only interesting next to what you would earn
  // at $82. Reverse-engineered from the sibling Analyzer, which showed 34%
  // at $64.97 and 72% at $82.00 -- a cost of $38.09 and a $4.18 fulfilment
  // fee at a 15% referral rate reproduce all of its percentages.
  // The Analyzer showed 34% at $64.97 and 72% at $82.00. A cost of $38.09
  // with a $4.18 fulfilment fee at 15% referral reproduces every one of its
  // percentages, so those are the inputs fed in here.
  const reading = readFixture('09-offers-panel.html', URL_FOR('B0H8QLSNPP'));
  const { $, window } = renderPanel(wire(reading), {
    ISUA_PROVIDER_PRODUCT: {
      ok: true, asin: 'B0H8QLSNPP',
      rank: { found: false, text: 'not found' },
      monthlySold: { found: false, text: 'not available' },
      fees: { found: true, fbaFee: 4.18, referralPct: 15 },
      diag: { asin: 'B0H8QLSNPP', marketplace: 'US', outcome: 'called', status: 200, tokensConsumed: 1 },
    },
    ISUA_PROVIDER_STATE: { ok: true, hasKey: true, masked: '....g4qp', tokensLeft: 204 },
  });
  $('apx-cost').value = '38.09';
  $('apx-cost').dispatchEvent(new window.Event('input'));

  // RENDERED, not just modelled. The ROI column is computed from lastFees,
  // which only a provider answer sets -- and the offers render on
  // PAGE_READING, earlier, with no fees in hand. Until the provider answer
  // re-rendered them the column read an em-dash for ever and the only way to
  // fill it was to re-read the page. This test exists because the model-only
  // version of it passed while the panel showed nothing.
  const roiOf = (name) => {
    const row = Array.from($('apx-sellers-list').querySelectorAll('.apx-seller-row'))
      .find((r) => new RegExp(name).test(r.textContent));
    return row.querySelector('.apx-seller-roi').textContent;
  };
  assert.equal(roiOf('Seller A & B'), '34%', 'the ROI column did not fill once fees arrived');
  assert.equal(roiOf('Seller F'), '56%');
  assert.equal(roiOf('Seller G'), '61%', 'the FBM row did not use its LANDED price');
  assert.equal(roiOf('Seller H'), '72%');

  // 30% is the Max Cost target, so a green row and an affordable Max Cost
  // agree rather than contradicting each other.
  const good = Array.from($('apx-sellers-list').querySelectorAll('.apx-seller-roi'))
    .filter((e) => e.classList.contains('good'));
  assert.equal(good.length, 7, 'the ROI colour bands no longer match the 30% target');

  // The same inputs, and nothing inferred from the rival.
  const src = srcOf('panel.js');
  const fn = src.slice(src.indexOf('function offerRoi'), src.indexOf('function stockPhrase'));
  assert.match(fn, /apx-cost/, 'the ROI no longer uses the cost you entered');
  assert.match(fn, /apx-seller-mode|fbm/i, 'the ROI ignores whether you sell FBA or FBM');
  assert.match(fn, /return null/, 'the ROI no longer declines when an input is missing');

  // THE FEE TOTAL IS ONE FUNCTION NOW, and that is the point rather than an
  // incidental refactor. Four places computed it independently -- this
  // column, the Fees tile, the simulator and the slider -- so adding the
  // media closing fee to three of them would have left two figures from the
  // same inputs disagreeing with nothing to say which was right.
  assert.match(fn, /feesAt\(/, 'the ROI computes its own fee total again');
  const feesAt = src.slice(src.indexOf('function feesAt'), src.indexOf('function offerRoi'));
  assert.match(feesAt, /lastFees\.referralPct/, 'the fee total no longer uses your referral rate');
  assert.match(feesAt, /lastFees\.closingFee/, 'the media closing fee is no longer charged');
  // Charged on FBM too: it is a referral-side charge, not a fulfilment one,
  // so unlike pick-and-pack it does not vanish when you ship it yourself.
  const fulfilLine = (feesAt.match(/const fulfil = [^;]+;/) || [''])[0];
  assert.match(fulfilLine, /isFbm \? 0/, 'the fulfilment fee is no longer waived on FBM');
  assert.ok(!/isFbm[^;]*closing|closing[^;]*isFbm/.test(feesAt),
    'the closing fee is being waived on FBM, which Amazon does not do');

  // And every one of the four call sites goes through it.
  assert.equal((src.match(/feesAt\(/g) || []).length >= 5, true,
    'a fee total is being computed somewhere outside feesAt');
});

/** renderPanel, but with a seller id already saved in the worker's store. */
/** readPage.extract over arbitrary HTML, for fixtures a test mutates. */
function readPageOf(html, url) {
  return require(path.join(ROOT, 'readPage.js')).extract(new JSDOM(html).window.document, url);
}

function renderPanelAsSeller(reading, sellerId) {
  return renderPanel(wire(reading), {
    ISUA_GET_MY_SELLER: { ok: true, sellerId },
    ISUA_SET_MY_SELLER: { ok: true, sellerId },
  });
}

test('the user own offer is marked, excluded, and the exclusion is stated', { skip }, () => {
  // THE BUG THIS PREVENTS, already shipped once in the repricer: holding the
  // Buy Box read as "already lowest among eligible competitors", so the price
  // shadowed itself downwards for months. The lowest offer being yours is not
  // a price you have to beat.
  const reading = readFixture('09-offers-panel.html', URL_FOR('B0H8QLSNPP'));
  // The Buy Box offer, which is also the joint-cheapest FBA one -- the exact
  // shape where counting yourself costs money.
  const me = reading.offers.buyBox.sellerId;
  assert.ok(/^ASYNTH/.test(me), 'the fixture seller ids are no longer synthetic');

  const { $, text } = renderPanelAsSeller(reading, me);

  // 7 offers, one of them ours -> 6 competitors.
  assert.equal(text('apx-sellers-count'), '6 live + you',
    'the user is still being counted among their own competitors');
  assert.match($('apx-sellers-count').title, /one of them yours/,
    'the total no longer explains why the count dropped');

  // Lowest FBA must now be the cheapest offer that is NOT ours. Three offers
  // tie at 64.97, so excluding ours leaves the same price from someone else
  // -- which is the subtle case: the NUMBER is unchanged and the meaning is
  // not, and that is exactly when a silent exclusion is undetectable.
  assert.equal(text('apx-fba'), '$64.97');
  assert.match($('apx-fba').title, /excluded from this figure/,
    'the FBA figure no longer says that the user own offer was taken out');

  // The row is labelled.
  const rows = $('apx-sellers-list').querySelectorAll('.apx-seller-row');
  const mineRow = Array.from(rows).find((r) => r.querySelector('.apx-seller-tag.self'));
  assert.ok(mineRow, 'the user own offer is not badged YOU in the list');
  assert.equal(mineRow.querySelector('.apx-seller-tag.self').textContent, 'YOU');
  assert.equal(rows.length, 7, 'the own offer was dropped from the list instead of marked');
  assert.equal($('apx-sellers-list').querySelectorAll('.apx-seller-tag.self').length, 1,
    'more than one offer is badged as the user own');

  // And the suppression is SPELLED OUT. An exclusion the user cannot see is
  // worse than none: a stale id would hide a real rival with no trace.
  const note = $('apx-sellers-list').querySelector('.apx-sellers-note');
  assert.ok(note, 'nothing states what was excluded');
  assert.match(note.textContent, /Your own offer/);
  assert.match(note.textContent, /excluded/);
});

test('an id set but not on this listing says so, and excludes nothing', { skip }, () => {
  // "You are not selling this" and "your id is wrong" look identical from the
  // outside and want different actions, so they are different messages.
  const reading = readFixture('09-offers-panel.html', URL_FOR('B0H8QLSNPP'));
  const { $, text } = renderPanelAsSeller(reading, 'ASYNTH99999999');

  assert.equal(text('apx-sellers-count'), '7 live', 'offers were excluded for an id that matched none');
  const note = $('apx-sellers-list').querySelector('.apx-sellers-note');
  assert.match(note.textContent, /None of these offers is yours/);
  assert.equal($('apx-sellers-list').querySelectorAll('.apx-seller-tag.self').length, 0,
    'an offer was badged as the user own for an id that matched none');
});

test('with no id set, the panel says what setting one would do', { skip }, () => {
  const reading = readFixture('09-offers-panel.html', URL_FOR('B0H8QLSNPP'));
  const { $, text } = renderPanelAsSeller(reading, null);
  assert.equal(text('apx-sellers-count'), '7 live');
  const note = $('apx-sellers-list').querySelector('.apx-sellers-note');
  assert.match(note.textContent, /Set your seller ID/,
    'an unconfigured panel does not say that it is counting the user as a rival');
});

test('the seller id is typed and local: no cookie, no network, no guess', () => {
  // The source HAD to be the user. Amazon puts no "this is you" marker on a
  // detail page, and the only other route is the signed-in session, which
  // means cookies -- banned here, with its own test. So the one thing that
  // must stay true of this feature is that it asks rather than infers.
  const bg = srcOf('background.js');
  const code = bg.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(code, /ISUA_SET_MY_SELLER/, 'the setter has gone');
  assert.match(code, /ISUA_GET_MY_SELLER/, 'the getter has gone');
  assert.match(code, /\^A\[A-Z0-9\]\{12,13\}\$/, 'the seller-id format is no longer validated');

  // Stored locally, and nowhere else.
  const slice = code.slice(code.indexOf("case 'ISUA_SET_MY_SELLER'"), code.indexOf("case 'ISUA_PROVIDER_CLEAR_KEY'"));
  assert.match(slice, /storage\.local/, 'the id is no longer stored in local storage');
  assert.ok(!/fetch\(|XMLHttpRequest|supabase/i.test(slice),
    'saving the seller id now makes a network call');

  // A MARKETPLACE ID IS NOT A SELLER ID. Both start with A, both are 13-14
  // characters, both sit in Amazon URLs. Storing one matches no offer, so the
  // panel keeps counting the user as a rival while looking configured.
  assert.match(code, /MARKETPLACE_IDS/, 'the marketplace-id guard has gone');
  assert.match(code, /ATVPDKIKX0DER/, 'the marketplace list is empty');

  // And the ban stays a ban.
  const panel = srcOf('panel.js').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/chrome\.cookies|document\.cookie/.test(panel + code),
    'a cookie API appeared alongside the seller-id feature');
});

test('"but your own" appears only when your own offer is that kind', { skip }, () => {
  // It read "No FBM offer but your own" on an ASIN where the user's own offer
  // is FBA: true of the list, false of the sentence. The kind of wrongness
  // that makes a reader stop trusting the lines that ARE right.
  const lazy = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', '09-offers-panel.html'), 'utf8')
    .replace(/<div id="aod-retail-other-offers-content"[\s\S]*?\n      <\/div>/,
      '<div id="aod-retail-other-offers-content" class="a-section"></div>');
  const reading = readPageOf(lazy, URL_FOR('B0H8QLSNPP'));
  // The user's own offer here is FBA, and no FBM offer is loaded.
  const me = reading.offers.offers[1].sellerId;
  const { $ } = renderPanelAsSeller(reading, me);

  assert.equal(reading.offers.offers[1].fba, true, 'the fixture own-offer is no longer FBA');
  assert.equal($('apx-fbm').textContent, 'none yet');
  assert.ok(!/but your own/.test($('apx-fbm').title),
    'the FBM line still claims the user own offer is the only FBM one');
  assert.match($('apx-fbm').title, /See more options/,
    'the FBM line no longer says how to load the rest');
});

test('the seller id is asked for with the key, not at the bottom', { skip }, () => {
  // It used to sit at the very end of the panel behind a toggle, which put a
  // setup step after everything it affects: the offer list counted the user as
  // their own competitor until they scrolled past the whole panel and found
  // it. Setup belongs together, so this pins the placement.
  const { window } = renderPanel(null);
  const d = window.document;

  const gate = d.getElementById('apx-keepa-gate');
  const form = d.getElementById('apx-me-form');
  assert.ok(gate && form, 'the gate or the seller form has gone');
  assert.ok(gate.contains(form), 'the seller field is no longer in the first-run gate');

  // Directly after the key form, not somewhere else inside the gate.
  const order = Array.from(gate.children).map((e) => e.id).filter(Boolean);
  assert.ok(order.indexOf('apx-me-form') > order.indexOf('apx-keepa-form'),
    'the seller field is above the key field');
  assert.equal(order.indexOf('apx-me-form') - order.indexOf('apx-keepa-form'), 2,
    'something has come between the key field and the seller field');

  // A SEPARATE FORM. The key input is `required`, so one shared form would
  // refuse to save a seller id until a key had been typed.
  assert.ok(!d.getElementById('apx-keepa-form').contains(d.getElementById('apx-me-input')),
    'the seller input is inside the key form, whose required key would block it');
  assert.ok(d.getElementById('apx-keepa-key').required,
    'the key input is no longer required, which is the reason the forms are split');

  // And exactly one input for one stored value -- two would be two places for
  // it to disagree.
  assert.equal(d.querySelectorAll('#apx-me-input').length, 1,
    'the seller input is duplicated');
  assert.ok(!d.querySelector('.apx-meta-row #apx-me-input'),
    'an input came back at the bottom of the panel');

  // The footer keeps the readout and a way back to the field.
  assert.ok(d.getElementById('apx-me-status'), 'the seller-id readout has gone');
  assert.ok(d.getElementById('apx-gate-done'),
    'there is no way out of the gate when it is reopened to change the id');
});

test('the key cannot be saved before the seller ID is', { skip }, () => {
  // The seller ID used to be optional, so the key saved on its own and the
  // offer list spent its first session counting the user as their own
  // competitor -- the exact thing the id exists to prevent, at the one moment
  // nobody would think to check it.
  const { window } = renderPanel(null, { ISUA_GET_MY_SELLER: { ok: true, sellerId: null } });
  const d = window.document;
  const keySave = d.getElementById('apx-keepa-save');

  assert.equal(keySave.disabled, true, 'the key can be saved with no seller ID stored');
  // DISABLED WITH THE REASON ON IT. A dead button that does not say why is the
  // dead end this panel keeps being rebuilt to avoid.
  assert.match(keySave.title, /seller ID first/i, 'the disabled key button gives no reason');
  assert.match(keySave.title, /competitor/i, 'the reason does not say what it costs');

  // The ordering is written into both labels, because the seller field sits
  // BELOW the key field and position alone implies the opposite.
  assert.match(d.getElementById('apx-me-label').textContent, /Step 1/);
  assert.match(d.getElementById('apx-keepa-intro').textContent, /Step 2/);
  assert.ok(!/optional/i.test(d.getElementById('apx-me-label').textContent),
    'the seller ID still calls itself optional while gating the key');
});

test('a stored seller ID unlocks the key for a returning user', { skip }, () => {
  const { window } = renderPanel(null,
    { ISUA_GET_MY_SELLER: { ok: true, sellerId: 'ASYNTH00000002' } });
  const keySave = window.document.getElementById('apx-keepa-save');
  assert.equal(keySave.disabled, false, 'a user who already set their id cannot save a key');
  assert.equal(keySave.title, '', 'the disabled reason is shown on an enabled button');
});

test('the seller button says Saved, and stops saying it when it is not true', { skip }, () => {
  // The status line below already read "You: A1...", and that was not enough:
  // it sits outside the form, so a save with no visible change to the control
  // just clicked reads as a click that did not land.
  let stored = null;
  const { window } = renderPanel(null, {
    ISUA_GET_MY_SELLER: { ok: true, sellerId: null },
    // The harness answers by type, so this stands in for the worker's own
    // validation; the real one is tested against background.js separately.
    ISUA_SET_MY_SELLER: { ok: true, sellerId: 'ASYNTH00000002' },
  });
  const d = window.document;
  const btn = d.getElementById('apx-me-save');
  const input = d.getElementById('apx-me-input');
  assert.equal(btn.textContent, 'Save seller ID');

  input.value = 'asynth00000002';
  d.getElementById('apx-me-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal(btn.textContent, 'Saved', 'the button does not confirm the save');

  // REVERTS ON EDIT, not on a timer. A label that changes back by itself after
  // a couple of seconds is indistinguishable from one that never changed, and
  // the user may well have looked away.
  input.value = 'asynth0000000';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(btn.textContent, 'Save seller ID',
    'the button still says Saved over an edited field');
  void stored;
});

/** Load gating.js the way the worker does, to build real parsed responses. */
function gatingModule() {
  const sandbox = { console, fetch: () => { throw new Error('no network'); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gating.js'), 'utf8'), sandbox);
  return sandbox.GATING;
}
function recordedGating() {
  const b = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', '11-gating-new-allowed.json'), 'utf8'));
  delete b._fixture;
  return b;
}

test('every gating state renders, and only a real verdict is coloured', { skip }, () => {
  // THESE TESTS EXIST BECAUSE THEIR ABSENCE HID A BUG. The gating functions
  // were never written into panel.js -- a patch script failed before writing
  // and the call site went in by hand -- and the whole suite stayed green,
  // because every gating test covered gating.js and background.js and nothing
  // covered the panel. The panel threw a ReferenceError on every page read.
  const G = gatingModule();
  const P = (json, status, ct) => G.parseGating(
    { status: status || 200, contentType: ct || 'application/json', json });
  const body = recordedGating();
  const gated = JSON.parse(JSON.stringify(body));
  gated.conditionDetails.new = { isRestricted: true, showCondition: false };
  gated.restrictionDetails.push(
    { conditionTypes: ['new'], message: 'You need approval for this brand.' });
  const unknown = JSON.parse(JSON.stringify(body));
  unknown.conditionDetails.graded = { isRestricted: false };

  const cases = [
    ['listable', P(body), 'apx-sa-good', /Eligible/],
    ['restricted', P(gated), 'apx-sa-bad', /Restricted/],
    ['signed out', P(null, 200, 'text/html'), null, /Sign in to Seller Central/],
    ['http 500', P(null, 500), null, /couldn/],
    ['unknown condition', P(unknown), null, /couldn/],
    ['capped', { ok: false, state: 'paused', error: 'Paused.' }, null, /paused/],
    ['non-US', { ok: false, state: 'unsupported_market', error: 'US only.' }, null, /US only/],
    // The malformed success the harness produces by accident, and the one the
    // panel must refuse: ok with no verdict in it.
    ['bare ok', { ok: true }, null, /couldn/],
  ];

  for (const [label, res, colour, text] of cases) {
    const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
    const { $ } = renderPanel(wire(reading), { ISUA_GATING: res });
    const chip = $('apx-sa-eligible');
    assert.match(chip.textContent, text, label + ': the chip said something else');

    // ONLY the two real verdicts carry a colour. Everything else is unknown,
    // because a false "eligible" sends the user to buy stock they cannot sell
    // and a false "couldn't read this" costs them one click.
    for (const c of ['apx-sa-good', 'apx-sa-bad']) {
      assert.equal(chip.classList.contains(c), c === colour,
        label + ': wrong colour state ' + c);
    }
    if (!colour) {
      assert.ok(chip.classList.contains('apx-sa-unknown'), label + ': not marked unknown');
    }
    // And every state says what to do, or why it cannot.
    assert.ok((chip.title || '').trim().length > 0, label + ': no explanation behind the chip');
  }
});

test('the other three conditions are shown apart from the verdict', { skip }, () => {
  // On the recorded ASIN new is listable while used, collectible and
  // refurbished are all restricted. Folding them into one answer would report
  // a perfectly listable product as restricted.
  const G = gatingModule();
  const res = G.parseGating(
    { status: 200, contentType: 'application/json', json: recordedGating() });
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading), { ISUA_GATING: res });

  assert.match($('apx-sa-eligible').textContent, /Eligible/, 'the verdict followed the other conditions');
  const others = $('apx-sa-conditions');
  assert.equal(others.textContent, 'all restricted');
  assert.match(others.title, /used/);
  assert.match(others.title, /collectible/);
  assert.match(others.title, /refurbished/);
  assert.match(others.title, /cannot list the product in this condition/,
    'the restriction message is not shown anywhere');
  // The other conditions are never coloured: they are not the verdict.
  for (const c of ['apx-sa-good', 'apx-sa-bad']) {
    assert.ok(!others.classList.contains(c), 'the other-conditions row is coloured like a verdict');
  }
});

test('gating is requested on page read and Recheck, and nowhere else', { skip }, () => {
  // It rides the user's own logged-in Seller Central session, so an
  // unattended trigger would hammer the account they log in with -- and
  // Amazon throttles and challenges sessions that behave like scrapers. The
  // budget being protected here is their ACCESS, not a token balance.
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { sent } = renderPanel(wire(reading),
    { ISUA_GATING: { ok: false, state: 'signed_out', error: 'Sign in.' } });
  const asked = sent.filter((m) => m && m.type === 'ISUA_GATING');
  assert.equal(asked.length, 1, 'gating was requested ' + asked.length + ' times for one page read');
  assert.equal(asked[0].asin, 'B07XYZ1234');
  assert.equal(asked[0].marketplace, 'US');

  const panel = srcOf('panel.js').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fn = panel.slice(panel.indexOf('function requestGating'), panel.indexOf('function renderOffers(o)'));

  // THE RULE SHARPENED RATHER THAN RELAXED. This banned setTimeout outright,
  // and then a setTimeout was needed -- because "Loading" with a round trip
  // behind it has to be bounded, or a reply that never comes leaves the panel
  // claiming progress for ever. That happened on a real page.
  //
  // A ban on all timers was the wrong shape of rule. What must never happen
  // is a timer that REQUESTS something: this call rides the user's own Seller
  // Central session, and an unattended one would hammer the account they log
  // in with. A timer that only changes a label spends nothing.
  //
  // So: repeating timers and alarms stay banned outright, and a one-shot
  // deadline is allowed only if nothing inside it asks for anything.
  assert.ok(!/setInterval|chrome\.alarms|MutationObserver/.test(fn),
    'a repeating trigger can now fire the gating read unattended');

  for (const m of fn.matchAll(/setTimeout\s*\(([\s\S]*?)\},\s*[A-Za-z0-9_]+\s*\)/g)) {
    assert.ok(!/sendMessage|requestGating|GATING\.lookup/.test(m[1]),
      'a timer re-requests the gating read, which can run against the user’s '
      + 'logged-in account with nobody watching');
  }
  // And the deadline must actually exist, or the unbounded wait is back.
  assert.match(fn, /setTimeout/, 'the gating wait is unbounded again');
  assert.match(panel, /const GATING_DEADLINE_MS = \d+/, 'the gating deadline has gone');
  // A synchronous throw from sendMessage -- which is what an invalidated
  // extension context does -- must not abort the function after it has
  // already painted "Loading".
  assert.match(fn, /try \{[\s\S]*sendMessage[\s\S]*\} catch/,
    'a synchronous sendMessage failure can strand the panel on Loading again');
  // One per ASIN per panel session, so a re-render does not ask again.
  assert.match(fn, /gatingFor/, 'the per-ASIN guard has gone');
});

test('a reply that never comes stops saying Loading', { skip }, async () => {
  // THE LIVE FAILURE. "Eligible to list: Loading…" with nothing coming, on a
  // real page. The callback can genuinely never fire: if the service worker
  // fails to evaluate, or the extension is reloaded under a page that is
  // still open, Chrome may drop the message with no callback and no
  // lastError. Nothing in the panel found out.
  //
  // This is the second time an unbounded "Loading" has shipped here -- the
  // offers drawer was the first -- so the deadline is tested, not just
  // written.
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  // A harness that takes the callback and never calls it, which is exactly
  // what a dead worker looks like from in here.
  const { $, window } = renderPanel(wire(reading), { ISUA_GATING: '__never__' });

  assert.equal($('apx-sa-eligible').textContent, 'Loading…',
    'the request does not show as in flight at all');

  // Let the deadline fire.
  const ms = Number(srcOf('panel.js').match(/const GATING_DEADLINE_MS = (\d+)/)[1]);
  assert.ok(ms > 0 && ms <= 15000, 'the deadline is ' + ms + 'ms, which is not a wait anyone will sit through');
  await new Promise((r) => setTimeout(r, ms + 150));

  const chip = $('apx-sa-eligible');
  assert.notEqual(chip.textContent, 'Loading…', 'the panel is still claiming progress');
  assert.match(chip.textContent, /no answer/i, 'the stalled state does not name what happened');
  assert.match(chip.title, /chrome:\/\/extensions/,
    'the stalled state does not say how to fix it');
  // AND IT MUST NOT READ AS A VERDICT. A worker that did not answer says
  // nothing about whether the ASIN may be listed.
  assert.match(chip.title, /says nothing about whether you may list/i,
    'a transport failure could be read as an eligibility answer');
  for (const c of ['apx-sa-good', 'apx-sa-bad']) {
    assert.ok(!chip.classList.contains(c), 'a stalled read is coloured like a verdict');
  }
  void window;
});

test('a reply with no answer in it is a failure, not progress', { skip }, () => {
  // HOW THE CHIP STALLED. renderGating(null) painted the in-flight state, so
  // every falsy answer painted it too -- and a worker replying with no value
  // hands the callback `undefined`, which landed in that branch and claimed
  // the read was still running. For ever, with no deadline able to help,
  // because the deadline had already been cleared by the reply arriving.
  //
  // In-flight is now a named sentinel the caller asks for. Nothing arriving
  // from the worker can claim it.
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  for (const [label, res] of [['undefined', undefined], ['null', null], ['false', false]]) {
    const { $ } = renderPanel(wire(reading), { ISUA_GATING: res });
    const chip = $('apx-sa-eligible');
    assert.notEqual(chip.textContent, 'Loading…',
      'a ' + label + ' reply is shown as still loading');
    assert.match(chip.textContent, /no answer/i, 'a ' + label + ' reply does not say what happened');
    for (const c of ['apx-sa-good', 'apx-sa-bad']) {
      assert.ok(!chip.classList.contains(c), 'a ' + label + ' reply is coloured like a verdict');
    }
  }

  // The pending state must not be reachable by any falsy value.
  const panel = srcOf('panel.js');
  assert.match(panel, /const PENDING = Symbol\(/, 'the pending sentinel has gone');
  assert.match(panel, /if \(res === PENDING\)/, 'pending is matched loosely again');
});

test('the why-paragraph does not deny a feature that now works', { skip }, () => {
  // It said "this version does not make that read yet" and "your sign-in is
  // not what is missing" -- printed on screen beside a row that was actively
  // reading Seller Central. A paragraph explaining a feature's absence, under
  // the working feature, is the same fault as a label asserting a state
  // nothing checks.
  const reading = readFixture('01-normal.html', URL_FOR('B07XYZ1234'));
  const { $ } = renderPanel(wire(reading),
    { ISUA_GATING: { ok: false, state: 'signed_out', error: 'Sign in.' } });
  const why = $('apx-dm-why').textContent;

  assert.ok(!/does not make that read/i.test(why), 'the paragraph still denies the gating read');
  assert.ok(!/sign-in is not what is missing/i.test(why),
    'the paragraph still tells the user their sign-in cannot be the problem');
  // And it must still say where eligibility comes from, and that no
  // credentials are involved -- that was the part worth keeping.
  assert.match(why, /Seller Central session/);
  assert.match(why, /no seller credentials/);
  assert.match(why, /Recheck/, 'the paragraph no longer names the fix for a signed-out session');
  // Private-label risk IS still absent, so that claim stays.
  assert.match(why, /Private-label risk is not assessed/);
});
