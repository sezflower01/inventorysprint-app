// THE LINT. This is the test that keeps the extension honest.
//
// Three rules, enforced over every shipped file in this folder:
//
//   1. No call, mention or string reference to fetch-listing-snapshot,
//      asin-dimensions or check-fba-listing-eligibility. Those three resolve
//      their Amazon token as
//        userAuth?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN')
//      so a user with NO SP-API connection does not get an error -- they get
//      answers computed against the account owner's Amazon account: the
//      owner's gating, the owner's fee schedule. Measured 2026-11-12: of three
//      accounts only the owner holds SP-API, and one other account already has
//      personalhour:view, so it could reach that path today. This extension
//      must never be a second door to it.
//
//   2. No fetch to a host outside ALLOWED_HOSTS. 0.1.0 talks to Supabase and
//      nothing else -- in particular NOT api.keepa.com, which stays out until
//      0.2.0 so the first store submission asks for the smallest possible
//      permission set.
//
//   3. No Keepa anywhere, and no Amazon credential handling. Rule 3 exists so
//      that the 0.2.0 decision has to be taken deliberately, by deleting a
//      line of this test, rather than arrived at by a stray import.
//
// A grep-based lint is crude, and crude is the point: it cannot be satisfied
// by renaming a variable, and it fails on a string in a comment just as
// readily as on a live call. False positives get an explicit allowance here,
// in the open, where the next reader can see what was permitted and why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The shipped-file list comes from build.js, the thing that actually makes the
// zip, so the lint and the packager cannot disagree about what ships. They did
// disagree on the first run -- the lint kept its own copy of the rules, read
// package-lock.json, and failed on 50 npmjs.org URLs that never leave this
// folder. Importing it means a file added to the zip is linted automatically,
// which is the direction that matters.
const { collect, ROOT } = require('../build.js');

const FILES = collect().map((rel) => path.join(ROOT, rel)).filter((f) => /\.(js|html|json|css)$/.test(f));
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

// ── The allowance ─────────────────────────────────────────────────────────
//
// A grep this crude flags the comments that explain WHY the forbidden thing is
// forbidden, and those comments are the most valuable lines in the file -- the
// repo's house style is to record the reasoning next to the fix. Softening the
// lint to ignore comments would be fragile (a live call can be made to look
// like one) so instead a line may opt out by name, in the open:
//
//     // ...Deno.env.get('SPAPI_REFRESH_TOKEN')...  // lint-allow:owner-fallback-mention
//
// Two constraints keep the hatch from becoming the bug:
//   * an allowance only ever exempts a NAME-MENTION rule. The structural rules
//     below -- which hosts may be fetched, what the manifest may ask for --
//     cannot be exempted at all, because those are what actually bite.
//   * a test asserts every allowance sits on a comment line.
const ALLOW = {
  keepa: 'lint-allow:keepa-mention',
  ownerFallback: 'lint-allow:owner-fallback-mention',
};
const ALL_MARKERS = Object.values(ALLOW);

/** Lines matching `re` that have not opted out with `marker`. */
function mentions(file, re, marker) {
  const out = [];
  read(file).split(/\r?\n/).forEach((line, i) => {
    if (!re.test(line)) return;
    if (marker && line.includes(marker)) return;
    out.push(`${rel(file)}:${i + 1}`);
  });
  return out;
}

// ── Rule 1 ────────────────────────────────────────────────────────────────
const OWNER_FALLBACK_FUNCTIONS = [
  'fetch-listing-snapshot',
  'asin-dimensions',
  'check-fba-listing-eligibility',
];

test('no file references an edge function that falls back to the owner Amazon account', () => {
  const re = new RegExp(OWNER_FALLBACK_FUNCTIONS.map((s) => s.replace(/[-]/g, '\\-')).join('|'));
  const hits = FILES.flatMap((f) => mentions(f, re, ALLOW.ownerFallback));
  assert.deepEqual(hits, [],
    'this extension must never reach the owner-credential path:\n' + hits.join('\n'));
});

test('no file references any SP-API credential name', () => {
  const re = /SPAPI_REFRESH_TOKEN|SPAPI_SELLER_ID|LWA_CLIENT_SECRET|seller_authorizations/;
  const hits = FILES.flatMap((f) => mentions(f, re, ALLOW.ownerFallback));
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('every lint allowance sits on a comment line', () => {
  // The hatch must not become a way to ship a live call.
  const bad = [];
  for (const f of FILES) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (!ALL_MARKERS.some((m) => line.includes(m))) return;
      if (!/^\s*(\/\/|\*|\/\*|<!--|#)/.test(line)) {
        bad.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bad, [], 'allowance used on a non-comment line:\n' + bad.join('\n'));
});

test('allowances are rare enough to still be read', () => {
  // A ceiling, so the hatch cannot quietly become the norm. If a change needs
  // more than this, the rule or the design is wrong, not the limit.
  const count = FILES.reduce(
    (n, f) => n + read(f).split(/\r?\n/).filter((l) => ALL_MARKERS.some((m) => l.includes(m))).length, 0);
  assert.ok(count <= 8, `${count} lint allowances -- too many to audit by eye`);
});

// ── Rule 2 ────────────────────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set([
  'mstibdszibcheodvnprm.supabase.co',
  // Not fetched -- it is only ever a link target the user clicks, and a
  // content-script match. Allowed so the Seller Central link and the sign-in
  // host do not trip the lint.
  'inventorysprint.com',
  'www.inventorysprint.com',
  'sellercentral.amazon.com',
]);

/** Every absolute http(s) URL that appears in a string literal or href. */
function urlsIn(src) {
  return (src.match(/https?:\/\/[^\s'"`)\\]+/g) || []);
}

test('every absolute URL in shipped code points at an allowed host', () => {
  const bad = [];
  for (const f of FILES) {
    for (const u of urlsIn(read(f))) {
      let host;
      try { host = new URL(u).host; } catch (_) { continue; }
      // Wildcards in manifest match patterns normalise to a *. host.
      const normalised = host.replace(/^\*\./, '');
      if (ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(normalised)) continue;
      if (/(^|\.)amazon\.com$/.test(normalised)) continue; // page we read, never fetched
      bad.push(`${rel(f)}: ${u}`);
    }
  }
  assert.deepEqual(bad, [], 'URL outside the allowed hosts:\n' + bad.join('\n'));
});

test('fetch() is only ever called against the Supabase host', () => {
  const bad = [];
  for (const f of FILES) {
    const src = read(f);
    // Each fetch( and the ~200 chars that follow, which is where the URL is.
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      const window_ = src.slice(m.index, m.index + 200);
      const urls = urlsIn(window_);
      const viaCfg = /CFG\.SUPABASE_URL/.test(window_);
      if (viaCfg) continue;
      if (urls.length === 0) {
        bad.push(`${rel(f)}: fetch() with no literal URL and no CFG.SUPABASE_URL nearby`);
        continue;
      }
      for (const u of urls) {
        let host;
        try { host = new URL(u).host; } catch (_) { continue; }
        if (host !== 'mstibdszibcheodvnprm.supabase.co') bad.push(`${rel(f)}: fetch -> ${host}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// ── Rule 3 ────────────────────────────────────────────────────────────────
// The crude grep caught its own author on the first run: background.js and
// readPage.js each name Keepa in a COMMENT -- one saying never to put a Keepa
// key in the config, the other explaining why every field carries a source
// label. Both comments are worth keeping, so rather than soften the lint into
// something that tries to strip comments (fragile, and a real call can always
// be dressed up to look like one), a line may opt out explicitly with the
// marker below. Every exemption is then visible in the source, greppable, and
// has to be typed on purpose.

test('Keepa is absent from 0.1.0 (delete this test deliberately for 0.2.0)', () => {
  const hits = [];
  for (const f of FILES) {
    const lines = read(f).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/keepa/i.test(line)) return;
      if (line.includes(ALLOW.keepa)) return;
      hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'Keepa appears without an explicit allowance at:\n' + hits.join('\n'));
});


test('no Amazon cookie, session or auth header is read anywhere', () => {
  const FORBIDDEN = ['chrome.cookies', 'document.cookie', 'x-amz-access-token', 'set-cookie'];
  const hits = [];
  for (const f of FILES) {
    const src = read(f).toLowerCase();
    for (const name of FORBIDDEN) {
      if (src.includes(name.toLowerCase())) hits.push(`${rel(f)} -> ${name}`);
    }
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

// ── The manifest itself ───────────────────────────────────────────────────
test('manifest permissions stay minimal and match the stated allowlist', () => {
  const m = JSON.parse(read(path.join(ROOT, 'manifest.json')));
  assert.deepEqual(m.permissions.sort(), ['activeTab', 'storage'],
    'a new permission appeared -- justify it to store review before adding it');
  assert.deepEqual(m.host_permissions.sort(), [
    'https://*.amazon.com/*',
    'https://mstibdszibcheodvnprm.supabase.co/*',
  ], 'host_permissions changed');
  // No <all_urls>, no http://*/*, no broad wildcard.
  for (const h of m.host_permissions) {
    assert.ok(!/^<all_urls>$/.test(h) && !/^https?:\/\/\*\/\*$/.test(h), `broad host permission: ${h}`);
  }
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, '0.1.0');
  // A closed shadow root means nothing needs exposing to the page.
  assert.ok(!('web_accessible_resources' in m), 'nothing should be web-accessible in this build');
});

test('cosmetic: there is something to lint', () => {
  assert.ok(FILES.length >= 6, `expected the shipped file set, found ${FILES.length}`);
});
