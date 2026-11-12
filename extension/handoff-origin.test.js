// The origin guard in handoff.js, exercised through the real message listener.
// Run with: node --test extension/handoff-origin.test.js
//
// handoff.js is a content script, so it is loaded the way Chrome loads it --
// evaluated against a stubbed window -- rather than refactored into something
// importable. That keeps the thing under test the file that actually ships.
// No jsdom needed: the guard only reads event.origin and event.source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'handoff.js'), 'utf8');

/** Load handoff.js and return a harness that can fire postMessage events. */
function load() {
  let handler = null;
  const posted = [];
  const sent = [];

  const windowStub = {
    addEventListener: (type, fn) => { if (type === 'message') handler = fn; },
    postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }),
  };

  const ctx = vm.createContext({
    window: windowStub,
    URL,
    console: { log() {}, debug() {}, warn() {} },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        lastError: null,
        sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb(); },
      },
    },
  });
  vm.runInContext(SRC, ctx, { filename: 'handoff.js' });
  assert.ok(handler, 'handoff.js did not register a message listener');

  return {
    sent,
    posted,
    /** Fire a message as if the page had posted it. */
    fire(origin, data, source) {
      handler({ origin, data, source: source === undefined ? windowStub : source });
    },
    isAllowed: ctx.isAllowedAppOrigin,
  };
}

const GOOD_SESSION = {
  type: 'ARBIPRO_EXT_SESSION',
  session: { access_token: 'a.b.c', refresh_token: 'r', expires_at: 1 },
};

test('the real app origin is accepted', () => {
  const h = load();
  h.fire('https://inventorysprint.com', GOOD_SESSION);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'INVSPRNT_SET_SESSION');
});

test('subdomains are accepted, because the manifest already runs there', () => {
  // manifest.json matches "https://*.inventorysprint.com/*", so rejecting
  // subdomains would mean the script runs and then silently refuses to work.
  for (const o of ['https://www.inventorysprint.com', 'https://app.inventorysprint.com']) {
    const h = load();
    h.fire(o, GOOD_SESSION);
    assert.equal(h.sent.length, 1, `${o} was rejected`);
  }
});

test('the look-alike domain is rejected -- the leading dot is the whole point', () => {
  // `hostname.endsWith('inventorysprint.com')` without the dot, and the
  // regex /inventorysprint\.com$/, both ACCEPT this. That is the bug this
  // test exists to pin.
  for (const o of [
    'https://evil-inventorysprint.com',
    'https://notinventorysprint.com',
    'https://inventorysprint.com.attacker.net',
  ]) {
    const h = load();
    h.fire(o, GOOD_SESSION);
    assert.equal(h.sent.length, 0, `${o} was accepted`);
  }
});

test('http, file, data and null origins are rejected', () => {
  for (const o of ['http://inventorysprint.com', 'file://', 'data:', 'null', '', undefined]) {
    const h = load();
    h.fire(o, GOOD_SESSION);
    assert.equal(h.sent.length, 0, `origin ${JSON.stringify(o)} was accepted`);
  }
});

test('a message from another frame is rejected even on a good origin', () => {
  const h = load();
  h.fire('https://inventorysprint.com', GOOD_SESSION, { notTheWindow: true });
  assert.equal(h.sent.length, 0);
});

test('logout is guarded by the same check', () => {
  const bad = load();
  bad.fire('https://evil-inventorysprint.com', { type: 'ARBIPRO_EXT_LOGOUT' });
  assert.equal(bad.sent.length, 0, 'a forged logout got through');

  const good = load();
  good.fire('https://inventorysprint.com', { type: 'ARBIPRO_EXT_LOGOUT' });
  assert.equal(good.sent.length, 1);
  assert.equal(good.sent[0].type, 'INVSPRNT_EXPLICIT_SIGN_OUT');
});

test('a half-session is rejected, so the worker cannot look signed in', () => {
  for (const session of [
    { access_token: 'a' },              // no refresh token
    { refresh_token: 'r' },             // no access token
    { access_token: '', refresh_token: 'r' },
    null,
  ]) {
    const h = load();
    h.fire('https://inventorysprint.com', { type: 'ARBIPRO_EXT_SESSION', session });
    assert.equal(h.sent.length, 0, `accepted session ${JSON.stringify(session)}`);
  }
});

test('the ack goes back to the sending origin, not "*"', () => {
  const h = load();
  h.fire('https://inventorysprint.com', GOOD_SESSION);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].msg.type, 'ARBIPRO_EXT_SESSION_ACK');
  assert.equal(h.posted[0].targetOrigin, 'https://inventorysprint.com',
    'the ack was broadcast with a wildcard target origin');
});

test('the guard is a hostname comparison, not a string match on the origin', () => {
  // Credentials and ports in the URL must not change the verdict.
  assert.equal(h0('https://inventorysprint.com'), true);
  assert.equal(h0('https://user:pass@evil.com/?x=inventorysprint.com'), false);
  assert.equal(h0('https://inventorysprint.com:8443'), true);
  assert.equal(h0('not a url'), false);
  function h0(o) { return load().isAllowed(o); }
});
