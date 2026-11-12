// Popup: sign-in state, the account it belongs to, and a way to get one.
//
// It deliberately has NO email or password field. Signing in happens on the
// website; the buttons here only open a tab. The session then arrives from
// the web app via handoff.js, so this extension never handles a credential.
// The shipped extension/popup.js does collect a password and posts it to
// /auth/v1/token?grant_type=password; that path is not reproduced here.
//
// Everything is built with createElement and textContent rather than
// innerHTML. The address comes from a token, which is not attacker-controlled
// here -- but a popup that assembles HTML from account data is one refactor
// away from being injectable, and there is nothing to gain by starting.
(function () {
  'use strict';

  const el = document.getElementById('state');

  const APP = 'https://inventorysprint.com';

  function openTab(url) {
    // chrome.tabs.create does NOT require the "tabs" permission -- that one
    // gates READING a tab's url and title, which this extension has no reason
    // to do. Opening a tab stays permission-free, so the manifest is unchanged.
    try { chrome.tabs.create({ url }); } catch (_) { /* popup is closing */ }
  }

  function el_(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick) {
    const b = el_('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function render(res) {
    el.textContent = '';

    if (!res?.ok) {
      el.appendChild(el_('span', 'muted',
        'Could not reach the extension worker. Try reloading the extension.'));
      return;
    }

    if (res.signedIn) {
      el.appendChild(el_('b', null, 'Signed in'));

      // The address, so "which account is this saving into?" is answerable
      // without leaving the popup. Falls back to a truncated id when the
      // token carries no email claim.
      const who = res.email
        ? el_('div', 'addr', res.email)
        : el_('div', 'addr muted', res.userId ? `Account ${String(res.userId).slice(0, 8)}…` : '');
      el.appendChild(who);

      el.appendChild(button('Sign out of this extension', 'link', () => {
        chrome.runtime.sendMessage({ type: 'ISUA_SIGN_OUT' }, () => refresh());
      }));
      return;
    }

    el.appendChild(el_('b', null, 'Not signed in'));
    el.appendChild(el_('div', 'muted', 'Readings are saved to your own account, so the panel needs one.'));

    const row = el_('div', 'row');
    row.appendChild(button('Create account', 'primary',
      () => openTab(res.signUpUrl || `${APP}/signup`)));
    row.appendChild(button('Sign in', null,
      () => openTab(res.signInUrl || `${APP}/login`)));
    el.appendChild(row);

    el.appendChild(el_('div', 'muted', 'Sign in on the website; this panel picks it up automatically.'));
  }

  function refresh() {
    try {
      chrome.runtime.sendMessage({ type: 'ISUA_AUTH_STATE' }, render);
    } catch (_) {
      render(null);
    }
  }

  refresh();
})();
