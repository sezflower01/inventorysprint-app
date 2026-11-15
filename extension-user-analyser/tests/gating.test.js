// Reading "can I list this?" from the seller's own Seller Central session.
//
// THE RULE THESE TESTS EXIST TO ENFORCE, above every other consideration: a
// false "eligible" sends the user to buy stock they cannot sell. A false
// "could not read this" costs them one click. So every uncertainty must
// resolve to unreadable, and nothing but an explicit, well-formed boolean
// false on the condition asked about may ever return eligible.
//
// parseGating is pure, so these hand it the real recorded body rather than
// mocking a network call. The fixture is that body, scrubbed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

// gating.js is a classic worker script like keepa.js: it assigns to self,
// falling back to globalThis, so running it in a context puts GATING on the
// sandbox.
function loadGating() {
  const sandbox = { console, fetch: () => { throw new Error('no network in this test'); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gating.js'), 'utf8'), sandbox);
  assert.ok(sandbox.GATING, 'gating.js did not expose GATING');
  return sandbox.GATING;
}
const GATING = loadGating();

/** The recorded response, with the fixture's own notes stripped. */
function recorded() {
  const body = JSON.parse(fs.readFileSync(path.join(FIX, '11-gating-new-allowed.json'), 'utf8'));
  delete body._fixture;
  return body;
}
const ok = (json) => GATING.parseGating({ status: 200, contentType: 'application/json', json });

test('the recorded response: new is listable, the other three are not', () => {
  const r = ok(recorded());
  assert.equal(r.state, 'read');
  assert.equal(r.ok, true);
  assert.equal(r.eligibleNew, true);

  // NO MESSAGE IS THE NORMAL CASE for a listable product: restrictionDetails
  // carries no entry for "new" because new is not restricted. Code that
  // required one would call every listable ASIN unreadable.
  assert.equal(r.newMessage, null);

  // The other three are reported SEPARATELY, never folded into the verdict.
  // On this ASIN all three are restricted while new is open -- fold them in
  // and a perfectly listable product reads as restricted.
  const by = Object.fromEntries(r.conditions.map((c) => [c.key, c]));
  assert.equal(by.new.restricted, false);
  for (const k of ['used', 'collectible', 'refurbished']) {
    assert.equal(by[k].restricted, true, k + ' lost its restriction');
    assert.equal(by[k].message, 'You cannot list the product in this condition.');
  }
});

test('nothing but an explicit false is eligible', () => {
  // The values that are falsy, or look like false, or are nearly a boolean.
  // Every one of them must fail CLOSED.
  for (const bad of [undefined, null, 0, '', 'false', 'no', NaN, [], {}]) {
    const body = recorded();
    body.conditionDetails.new.isRestricted = bad;
    const r = ok(body);
    assert.equal(r.eligibleNew, undefined,
      JSON.stringify(bad) + ' produced an eligibility verdict');
    assert.equal(r.ok, false, JSON.stringify(bad) + ' was treated as a readable answer');
    assert.equal(r.state, 'unreadable');
    assert.equal(r.code, 'BAD_CONDITION');
  }

  // And true is restricted, not unreadable -- a real answer either way.
  const body = recorded();
  body.conditionDetails.new.isRestricted = true;
  const r = ok(body);
  assert.equal(r.ok, true);
  assert.equal(r.eligibleNew, false);
});

test('a gated-for-new ASIN carries its own message, not another condition s', () => {
  // The operator has not sent a gated-for-new example yet, so this builds one
  // from the recorded shape: the restriction entry gains "new" with its own
  // wording, and the verdict must pick THAT message rather than the
  // used/collectible one sitting beside it.
  const body = recorded();
  body.conditionDetails.new = { isRestricted: true, showCondition: false };
  body.restrictionDetails = [
    { conditionTypes: ['used', 'collectible', 'refurbished'],
      message: 'You cannot list the product in this condition.' },
    { conditionTypes: ['new'],
      message: 'You need approval to list this brand.' },
  ];
  const r = ok(body);
  assert.equal(r.eligibleNew, false);
  assert.equal(r.newMessage, 'You need approval to list this brand.',
    'the verdict quoted a message belonging to a different condition');
});

test('a missing key, an unknown key, or a moved shape is unreadable', () => {
  const cases = [
    ['conditionDetails removed', (b) => { delete b.conditionDetails; }, 'NO_CONDITIONS'],
    ['conditionDetails is a string', (b) => { b.conditionDetails = 'x'; }, 'NO_CONDITIONS'],
    ['new removed', (b) => { delete b.conditionDetails.new; }, 'BAD_CONDITION'],
    ['used removed', (b) => { delete b.conditionDetails.used; }, 'BAD_CONDITION'],
    // A FIFTH CONDITION TYPE IS FATAL, deliberately. It means the shape has
    // moved, and the safe answer to "I do not recognise this" is to decline
    // rather than report on the parts still recognised.
    ['an unknown condition', (b) => { b.conditionDetails.graded = { isRestricted: false }; },
      'UNKNOWN_CONDITION'],
    ['restrictionDetails is an object',
      (b) => { b.restrictionDetails = { message: 'x' }; }, 'BAD_RESTRICTIONS'],
  ];
  for (const [label, mutate, code] of cases) {
    const body = recorded();
    mutate(body);
    const r = ok(body);
    assert.equal(r.ok, false, label + ' was accepted');
    assert.equal(r.state, 'unreadable', label + ' did not report unreadable');
    assert.equal(r.code, code, label + ' reported ' + r.code);
    assert.ok(r.message, label + ' gave no message to show');
    assert.equal(r.eligibleNew, undefined, label + ' produced a verdict anyway');
  }
});

test('an unknown condition is NAMED, so the fix is obvious', () => {
  const body = recorded();
  body.conditionDetails.graded = { isRestricted: false };
  const r = ok(body);
  assert.match(r.message, /graded/, 'the unknown condition is not named in the message');
});

test('a login page is a sign-in prompt, not an error and never eligible', () => {
  // Seller Central answers an unauthenticated request by serving its sign-in
  // page, so the giveaway is HTML where JSON was asked for. 401 and 403 are
  // the same answer said plainly.
  const html = { status: 200, contentType: 'text/html; charset=UTF-8', json: null };
  const r = GATING.parseGating(html);
  assert.equal(r.state, 'signed_out', 'an HTML body on a 200 was not read as signed out');
  assert.equal(r.ok, false);
  assert.match(r.message, /Sign in/i);
  assert.match(r.message, /Recheck/, 'the sign-in prompt does not say what to do after');

  for (const status of [401, 403]) {
    const s = GATING.parseGating({ status, contentType: 'application/json', json: null });
    assert.equal(s.state, 'signed_out', 'HTTP ' + status + ' was not read as signed out');
  }

  // Everything else that is not a 200 is unreadable, NOT signed out: a 500 is
  // not a reason to send the user to log in again.
  for (const status of [301, 404, 429, 500, 503]) {
    const e = GATING.parseGating({ status, contentType: 'application/json', json: null });
    assert.equal(e.state, 'unreadable', 'HTTP ' + status + ' was read as a sign-in problem');
    assert.match(e.code, /^HTTP_/);
  }

  // None of the above may ever be eligible.
  for (const res of [html, { status: 401 }, { status: 500 }, {}, null]) {
    const x = GATING.parseGating(res);
    assert.notEqual(x.eligibleNew, true, 'a failure path returned eligible');
  }
});

test('the cross-check fields are carried but never substituted', () => {
  const r = ok(recorded());
  // These matched the offer-drawer reader exactly on the recorded ASIN, which
  // is a genuine independent confirmation of that reader.
  assert.equal(r.offerCount, 7);
  assert.equal(r.lowestPrice, '$64.97');

  // Seller Central said 52,494; the product page said 263,661. A different
  // ranking of a different category. It is carried under its own name so it
  // can never be mistaken for, or quietly reconciled with, the page's BSR.
  assert.equal(r.salesRankSellerCentral, 52494);
  assert.ok(!('salesRank' in r), 'the Seller Central rank is exposed as if it were the BSR');
  assert.ok(!('rank' in r), 'the Seller Central rank is exposed as the rank');
});

test('showCondition is carried but is not the verdict', () => {
  // It tracked isRestricted in the recorded response, so reading one as the
  // other would work until the day it does not.
  const body = recorded();
  body.conditionDetails.new = { isRestricted: true, showCondition: true };
  const r = ok(body);
  assert.equal(r.eligibleNew, false, 'showCondition overrode isRestricted');

  const src = fs.readFileSync(path.join(ROOT, 'gating.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/eligibleNew[^;]*showCondition/.test(code),
    'the verdict is being derived from showCondition');
});

test('gating.js may reach Seller Central and nothing else', () => {
  const src = fs.readFileSync(path.join(ROOT, 'gating.js'), 'utf8');

  // BASE is pinned here because the fetch lint exempts this file from needing
  // a literal URL beside its fetch() -- it builds the URL from BASE, exactly
  // as keepa.js does. Without this test BASE could be repointed at any host
  // and the lint would not notice.
  const base = (src.match(/const BASE = '([^']+)'/) || [])[1];
  assert.equal(base, 'https://sellercentral.amazon.com',
    'the Seller Central host moved, or BASE is no longer a single literal');

  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // One fetch, no retry. A retry is indistinguishable from a loop from the
  // outside, and this one carries the user's own session.
  assert.equal((code.match(/\bfetch\s*\(/g) || []).length, 1,
    'gating.js makes more than one fetch');
  assert.ok(!/setTimeout|setInterval|chrome\.alarms|MutationObserver/.test(code),
    'gating.js can now fire unattended against the user’s logged-in account');

  // THIS ASSERTED THE OPPOSITE, and both halves were right when written.
  //
  // Gating needed no permission change, because host_permissions carried
  // https://*.amazon.com/* and Chrome's subdomain wildcard matched Seller
  // Central -- so this test required that wildcard to be present and required
  // no sellercentral entry beside it.
  //
  // The wildcard has since been REMOVED, because nothing fetches an Amazon
  // product page: the page is read in place by a content script, granted by
  // content_scripts.matches. So Seller Central is now the only Amazon host in
  // the list, and it is named rather than matched by a wildcard. A narrower
  // permission for the same capability.
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(m.host_permissions.includes('https://sellercentral.amazon.com/*'),
    'the gating fetch has no permission, so it will fail as a CORS error');
  assert.ok(!m.host_permissions.includes('https://*.amazon.com/*'),
    'the Amazon subdomain wildcard is back');
});

test('the worker caches, caps and never auto-retries the gating call', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const from = bg.indexOf("case 'ISUA_GATING'");
  const to = bg.indexOf("case 'ISUA_GET_MY_SELLER'");
  assert.ok(from > -1 && to > from, 'the gating handler has gone');
  const h = bg.slice(from, to);

  // Cache BEFORE cap before call, so a free answer is never refused by the
  // cap -- the ordering the provider handler learned the hard way.
  const readAt = h.indexOf('storage.local.get');
  const claimAt = h.indexOf('claimGatingSlot');
  const callAt = h.indexOf('GATING.lookup');
  assert.ok(readAt > -1 && claimAt > -1 && callAt > -1, 'a step of the handler has gone');
  assert.ok(readAt < claimAt, 'the cap is checked before the cache');
  assert.ok(claimAt < callAt, 'the slot is claimed after the call, which defeats the cap');

  // A SHORTER TTL than the product cache: a gate can be lifted or applied
  // while the user works, and a six-hour-old "restricted" would stop them
  // buying stock they can now sell.
  const gate = eval(bg.match(/const GATING_TTL_MS = ([^;]+);/)[1]);
  const prod = eval(bg.match(/const PRODUCT_TTL_MS = ([^;]+);/)[1]);
  assert.ok(gate < prod, 'the gating answer is cached as long as a product answer');
  assert.ok(gate <= 60 * 60 * 1000, 'a gating answer is held for over an hour');

  // Failures cached briefly, and no retry anywhere.
  assert.match(bg, /const GATING_FAIL_TTL_MS = /, 'gating failures are no longer cached');
  assert.ok(!/setTimeout[\s\S]{0,200}GATING\.lookup/.test(h), 'the handler schedules a retry');

  // The ledger persists, because Chrome stops an idle worker and a
  // module-level counter is a cap a restart lifts.
  const claim = bg.slice(bg.indexOf('async function claimGatingSlot'), from);
  assert.match(claim, /storage\.local\.get/, 'the gating ledger is not persisted');
  assert.match(claim, /storage\.local\.set/, 'the gating ledger is never written');
});

test('the fixture carries no session material', () => {
  // THE PAYLOAD, not the commentary. The fixture's own _fixture note explains
  // that no cookie, token or session id was in the body -- and scanning the
  // whole file for those words therefore tripped on the sentence saying they
  // are absent. Third time a comment has set off the lint written about it,
  // so: the body is scanned for session material, and the note is scanned
  // separately for anything that looks like a secret rather than a word.
  const raw = JSON.stringify(recorded());
  for (const [name, rx] of [
    ['a SKU', /"sku"|sellerSku/i],
    ['a seller id', /\bA[A-Z0-9]{12,13}\b/],
    ['a cookie or token', /cookie|token|session|csrf/i],
    ['an email', /[\w.+-]+@[\w-]+\.[a-z]{2,}/],
  ]) {
    assert.ok(!rx.test(raw), 'the gating fixture contains ' + name);
  }
  // A synthetic ASIN, not the real one the capture was taken from.
  const body = recorded();
  assert.match(body.productDetails.asin, /^B0SYNTH/,
    'the real ASIN from the capture is still in the fixture');

  // And the note itself: words about secrets are fine, actual secrets are not.
  const note = JSON.parse(fs.readFileSync(path.join(FIX, '11-gating-new-allowed.json'), 'utf8'))._fixture.join(' ');
  assert.ok(!/\b[A-Za-z0-9+/]{24,}={0,2}\b/.test(note), 'the fixture note contains a blob');
  assert.ok(!/\bA[A-Z0-9]{12,13}\b/.test(note), 'the fixture note contains a seller id');
  assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/.test(note), 'the fixture note contains an email');
});
