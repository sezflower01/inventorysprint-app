// The popup's sign-in surface.
//
// Two properties are worth pinning here, and they pull in opposite directions:
//
//   1. The popup must offer a way to GET an account, because readings are
//      saved to the user's own account and without one the panel does nothing.
//   2. The popup must never be the thing that takes a password. Signing in
//      happens on the website; these buttons only open a tab.
//
// A third, added after data was once written into the wrong account on this
// project: when signed in, the popup must say WHICH account. "Signed in" on
// its own is what let that go unnoticed.
//
// popup.js is a plain script, not a module. It is loaded the way Chrome loads
// it -- evaluated against a jsdom window with a `chrome` stub -- so the thing
// under test is the file that actually ships.
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
const srcOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * Open popup.html, answer ISUA_AUTH_STATE with `state`, run popup.js, and
 * hand back the document plus whatever the buttons did.
 */
function openPopup(state) {
  const dom = new JSDOM(srcOf('popup.html'), { runScripts: 'outside-only' });
  const { window } = dom;

  const opened = [];
  const sent = [];
  window.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg?.type === 'ISUA_AUTH_STATE') cb(state);
        else cb({ ok: true });
      },
    },
    tabs: { create({ url }) { opened.push(url); } },
  };

  vm.runInContext(srcOf('popup.js'), dom.getInternalVMContext());
  return { window, doc: window.document, opened, sent };
}

const SIGNED_OUT = { ok: true, signedIn: false, signUpUrl: 'https://inventorysprint.com/signup', signInUrl: 'https://inventorysprint.com/login' };
const SIGNED_IN = { ok: true, signedIn: true, userId: '11111111-2222-3333-4444-555555555555', email: 'someone@example.com' };

test('THE RULE: the popup has no password or email field', { skip }, () => {
  const html = srcOf('popup.html');
  const dom = new JSDOM(html);
  const inputs = [...dom.window.document.querySelectorAll('input, textarea, form')];
  assert.deepEqual(
    inputs.map((n) => n.outerHTML),
    [],
    'the popup grew an input; credentials must stay on the website',
  );
  assert.ok(!/type\s*=\s*["']password/i.test(html), 'a password field appeared');
});

test('signed out: offers both Create account and Sign in', { skip }, () => {
  const { doc } = openPopup(SIGNED_OUT);
  const labels = [...doc.querySelectorAll('#state button')].map((b) => b.textContent);
  assert.ok(labels.includes('Create account'), `no create button; got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('Sign in'), `no sign-in button; got ${JSON.stringify(labels)}`);
});

test('the buttons open the web app, and nothing else', { skip }, () => {
  for (const [label, expected] of [
    ['Create account', 'https://inventorysprint.com/signup'],
    ['Sign in', 'https://inventorysprint.com/login'],
  ]) {
    const { doc, opened } = openPopup(SIGNED_OUT);
    const btn = [...doc.querySelectorAll('#state button')].find((b) => b.textContent === label);
    btn.dispatchEvent(new btn.ownerDocument.defaultView.Event('click', { bubbles: true }));
    assert.deepEqual(opened, [expected], `${label} opened ${JSON.stringify(opened)}`);
  }
});

test('a worker that sends no URLs still opens the right pages', { skip }, () => {
  // The popup must not depend on the worker for its own destinations: a
  // button that silently does nothing is worse than one that is absent.
  const { doc, opened } = openPopup({ ok: true, signedIn: false });
  const btn = [...doc.querySelectorAll('#state button')].find((b) => b.textContent === 'Create account');
  btn.dispatchEvent(new btn.ownerDocument.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(opened, ['https://inventorysprint.com/signup']);
});

test('signed in: the ADDRESS is shown, not just "Signed in"', { skip }, () => {
  const { doc } = openPopup(SIGNED_IN);
  const text = doc.getElementById('state').textContent;
  assert.ok(text.includes('someone@example.com'), `address missing from: ${JSON.stringify(text)}`);
  assert.ok(text.includes('Signed in'));
});

test('signed in without an email claim: falls back, never shows blank', { skip }, () => {
  const { doc } = openPopup({ ...SIGNED_IN, email: null });
  const text = doc.getElementById('state').textContent;
  assert.ok(/11111111/.test(text), `no identifier at all: ${JSON.stringify(text)}`);
});

test('signed in: sign-out asks the worker to clear the session', { skip }, () => {
  const { doc, sent } = openPopup(SIGNED_IN);
  const btn = [...doc.querySelectorAll('#state button')].find((b) => /sign out/i.test(b.textContent));
  assert.ok(btn, 'no sign-out control while signed in');
  btn.dispatchEvent(new btn.ownerDocument.defaultView.Event('click', { bubbles: true }));
  assert.ok(sent.some((m) => m?.type === 'ISUA_SIGN_OUT'), 'sign-out sent nothing to the worker');
});

test('a dead worker says so instead of rendering an empty box', { skip }, () => {
  const { doc } = openPopup(null);
  assert.match(doc.getElementById('state').textContent, /could not reach/i);
});

test('the address is inserted as text, never as markup', { skip }, () => {
  // Not attacker-controlled today -- it comes from a token the extension
  // already holds. The point is that it stays that way through a refactor.
  const { doc } = openPopup({ ...SIGNED_IN, email: '<img src=x onerror=alert(1)>@example.com' });
  const state = doc.getElementById('state');
  assert.equal(state.querySelectorAll('img').length, 0, 'the address was parsed as HTML');
  assert.ok(state.textContent.includes('<img src=x'), 'the address was not shown verbatim');
});

test('the worker exposes an email claim reader at all', { skip }, () => {
  // Guards the other half of the contract: the popup can only show an address
  // if background.js puts one in the auth-state reply.
  const bg = srcOf('background.js');
  assert.match(bg, /userEmailFromToken/, 'background.js stopped providing the address');
  assert.match(bg, /email:\s*s \? userEmailFromToken/, 'the auth-state reply no longer carries it');
});
