// Popup: shows sign-in state and nothing else.
//
// It deliberately has NO email or password field. The session arrives from the
// web app via handoff.js, so this extension never handles a credential. The
// shipped extension/popup.js does collect a password and posts it to
// /auth/v1/token?grant_type=password; that path is not reproduced here.
(function () {
  'use strict';

  const el = document.getElementById('state');

  function render(res) {
    el.textContent = '';
    if (!res?.ok) {
      el.innerHTML = '<span class="muted">Could not reach the extension worker. Try reloading the extension.</span>';
      return;
    }
    if (res.signedIn) {
      const b = document.createElement('b');
      b.textContent = 'Signed in';
      const d = document.createElement('div');
      d.className = 'muted';
      d.style.fontSize = '11px';
      // The user id, not the email -- the popup has no reason to display an
      // address, and the worker never sends one.
      d.textContent = res.userId ? `Account ${String(res.userId).slice(0, 8)}…` : '';
      el.appendChild(b);
      el.appendChild(d);
      return;
    }
    const b = document.createElement('b');
    b.textContent = 'Not signed in';
    const d = document.createElement('div');
    d.className = 'muted';
    d.style.fontSize = '11.5px';
    d.textContent = 'Open inventorysprint.com and sign in; this panel picks it up automatically.';
    el.appendChild(b);
    el.appendChild(d);
  }

  try {
    chrome.runtime.sendMessage({ type: 'ISUA_AUTH_STATE' }, render);
  } catch (e) {
    render(null);
  }
})();
