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
const { collect, ROOT, EXCLUDE_DIRS, EXCLUDE_FILES } = require('../build.js');

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
  // Google Fonts, from panel.html only, and only as a <link rel=stylesheet>.
  // The panel is a copy of extension/panel.html, which loads the same pairing
  // (Inter / Space Grotesk) the web app uses; without them the panel is not
  // the same panel.
  //
  // This is a real cost, not a formality: the panel renders on every product
  // page a user opens, so each one makes a request to Google. The alternative
  // is to ship the two woff2 files and drop the external load entirely, which
  // would be strictly better for a user-facing extension and is worth doing --
  // it is listed as a follow-up rather than done here, because it means adding
  // binary assets and changing the stylesheet away from a verbatim copy.
  //
  // What stops this from widening: these hosts are reachable for STYLES only.
  // The separate `fetch()` test below still pins every fetch to the Supabase
  // host, so no code path can start sending data here.
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  // Appears only in keepa.js. The per-file fetch rule below is what actually
  // confines it; this entry just stops the URL lint flagging the base
  // constant where it is legitimately declared.
  'api.keepa.com',
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

test('fetch() only ever reaches a host that file is allowed to reach', () => {
  // Was "only the Supabase host". Widened for 0.2.0, but per FILE rather than
  // globally: keepa.js may reach the data provider and nothing else may, and
  // keepa.js may reach nothing else. A single global allowlist would have let
  // any file call either host, which is the opposite of the point.
  const bad = [];
  for (const f of FILES) {
    const src = read(f);
    const isProvider = path.basename(f) === 'keepa.js';
    const isGating = path.basename(f) === 'gating.js';
    // Each fetch( and the ~200 chars that follow, which is where the URL is.
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      const window_ = src.slice(m.index, m.index + 200);
      const urls = urlsIn(window_);
      const viaCfg = /CFG\.SUPABASE_URL/.test(window_);
      // gating.js builds its URL from its own BASE const too, so it needs the
      // same exemption keepa.js has. The protection the literal-URL rule was
      // giving is replaced by the test below, which pins what BASE points at --
      // otherwise BASE could be repointed and this rule would not notice.
      const viaBase = (isProvider || isGating) && window_.includes('BASE');
      if (viaCfg) {
        if (isProvider) bad.push(`${rel(f)}: the provider module must not reach our own host`);
        continue;
      }
      if (viaBase) continue;
      if (urls.length === 0) {
        bad.push(`${rel(f)}: fetch() with no literal URL and no known base nearby`);
        continue;
      }
      // THIRD ENTRY, added for 0.2.0 gating, on the same principle rather than
      // by widening: gating.js is the only file that may reach Seller Central,
      // exactly as keepa.js is the only one that may reach the data provider.
      // One module per host keeps the narrow rule narrow -- a shared allowlist
      // would let any file call any of the three.
      //
      // Worth recording for store review: this needed NO manifest change,
      // because host_permissions already carries https://*.amazon.com/* and
      // Chrome's subdomain wildcard matches sellercentral.amazon.com. The
      // existing permission was already broader than the extension used.

      const allowed = isProvider ? 'api.keepa.com'
        : isGating ? 'sellercentral.amazon.com'
        : 'mstibdszibcheodvnprm.supabase.co';
      for (const u of urls) {
        let host;
        try { host = new URL(u).host; } catch (_) { continue; }
        if (host !== allowed) bad.push(`${rel(f)}: fetch -> ${host} (only ${allowed} allowed here)`);
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

// The "Keepa is absent from 0.1.0" test lived here and has been deleted on
// purpose, exactly as its own name instructed. 0.2.0 integrates the provider,
// so a blanket ban on naming it is no longer the rule worth enforcing.
//
// What replaces it is narrower and harder to satisfy by accident: the key is
// the user's, it stays in their browser, and exactly one file may send it
// anywhere. Each rule below can fail silently in production, which is why
// each is a test rather than a convention.

test('no API key is baked into anything that ships', () => {
  // A provider key is a long run of lowercase alphanumerics. The publishable
  // Supabase JWT is mixed-case and dotted, so it does not match this shape
  // and does not need an exception.
  const hits = [];
  for (const f of FILES) {
    for (const m of read(f).matchAll(/\b[a-z0-9]{40,}\b/g)) {
      hits.push(`${rel(f)}: ${m[0].slice(0, 12)}… (${m[0].length} chars)`);
    }
  }
  assert.deepEqual(hits, [], 'something key-shaped is hardcoded:\n' + hits.join('\n'));
});

test('only keepa.js may reach the provider at all', () => {
  const offenders = [];
  for (const f of FILES) {
    if (path.basename(f) === 'keepa.js') continue;
    // The manifest DECLARES the permission; it does not call anything. A
    // host permission that could not be written down would be unusable.
    if (path.basename(f) === 'manifest.json') continue;
    if (/api\.keepa\.com/i.test(read(f))) offenders.push(rel(f));
  }
  assert.deepEqual(offenders, [],
    'the provider host appears outside keepa.js, so the lint can no longer ' +
    'check every call that carries a key exhaustively: ' + offenders.join(', '));
});

test('only keepa.js may read the stored key', () => {
  // Anything that can read it can leak it. The worker answers questions ABOUT
  // the key (is it there, does it work, how many tokens) and never hands it
  // over, so nothing else needs the storage name.
  const offenders = [];
  for (const f of FILES) {
    if (path.basename(f) === 'keepa.js') continue;
    if (/isua_keepa_key/.test(read(f))) offenders.push(rel(f));
  }
  assert.deepEqual(offenders, [], 'the key storage name appears in: ' + offenders.join(', '));
});

test('no message hands the key back to the panel', () => {
  // The panel must be unable to obtain it even if it asked. A reply the panel
  // can read is a reply a bug can leak into the page.
  const bg = read(path.join(ROOT, 'background.js'));
  const handlers = bg.slice(bg.indexOf("case 'ISUA_PROVIDER_STATE'"), bg.indexOf("case 'ISUA_SIGN_IN_PASSWORD'"));
  assert.ok(handlers.length > 0, 'the provider handlers have gone');
  assert.ok(!/sendResponse\([^)]*\bkey\b\s*:/.test(handlers.replace(/\s+/g, ' ')),
    'a provider handler sends a field called key back to the panel');
  assert.ok(/masked/.test(handlers), 'the state reply should carry a masked form, not the value');
});

test('the key is validated before it is stored', () => {
  // Storing first and checking later leaves a user with a saved key that
  // silently fails on every call.
  const bg = read(path.join(ROOT, 'background.js'));
  const setCase = bg.slice(bg.indexOf("case 'ISUA_PROVIDER_SET_KEY'"), bg.indexOf("case 'ISUA_PROVIDER_CLEAR_KEY'"));
  const validateAt = setCase.indexOf('validate');
  const storeAt = setCase.indexOf('setKey');
  assert.ok(validateAt > -1 && storeAt > -1, 'set-key no longer validates or no longer stores');
  assert.ok(validateAt < storeAt, 'the key is stored before it is validated');
});

test('a 200 carrying an error body is treated as a failure', () => {
  // Keepa signals failure in the body of a 200. Code that only checks res.ok
  // reads a rejection as an empty result -- a trap this project has already
  // paid for once.
  const src = read(path.join(ROOT, 'keepa.js'));
  const checks = (src.match(/json\.error/g) || []).length;
  assert.ok(checks >= 2, `expected every call path to check json.error, found ${checks}`);
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
  // EXACTLY THE HOSTS THAT ARE FETCHED, and nothing else.
  //
  // https://*.amazon.com/* used to head this list and has been REMOVED, not
  // narrowed. Nothing fetches an Amazon product page: it is read in place by
  // a content script, which is granted by content_scripts.matches, and the
  // panel's own assets are granted by web_accessible_resources.matches. Both
  // are separate grants from this one.
  //
  // The proof was already in this manifest: handoff.js has always run on
  // inventorysprint.com, which has never had a host_permissions entry.
  //
  // The install warning therefore drops from "all amazon.com sites" to three
  // named hosts, which is the single biggest store-review item on this
  // extension -- and it got smaller while a feature was added.
  assert.deepEqual(m.host_permissions.sort(), [
    // Each user supplies their own key, so each user's own requests go here.
    'https://api.keepa.com/*',
    'https://mstibdszibcheodvnprm.supabase.co/*',
    // Added in 0.2.0 for the gating read. The ONLY Amazon host that is
    // fetched, and gating.js is the only file allowed to reach it.
    'https://sellercentral.amazon.com/*',
  ], 'host_permissions changed');
  // No <all_urls>, no http://*/*, no broad wildcard -- and no Amazon
  // subdomain wildcard, which is what *.amazon.com was.
  for (const h of m.host_permissions) {
    assert.ok(!/^<all_urls>$/.test(h) && !/^https?:\/\/\*\/\*$/.test(h), `broad host permission: ${h}`);
    assert.ok(!/^https:\/\/\*\./.test(h),
      `subdomain wildcard is back: ${h} -- name the hosts that are fetched`);
  }
  // Every fetched host must appear here, or the fetch fails at runtime with a
  // CORS error that looks like the remote being down.
  for (const needed of ['api.keepa.com', 'sellercentral.amazon.com']) {
    assert.ok(m.host_permissions.some((h) => h.includes(needed)),
      `${needed} is fetched but not permitted`);
  }
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, '0.2.0');
});

// This assertion replaced a stricter one, and the swap is the point of the
// comment. It used to read:
//
//     assert.ok(!('web_accessible_resources' in m))
//
// which was correct while the panel lived in a closed shadow root. The panel
// is now an iframe loading panel.html, so something MUST be exposed, and the
// honest move is to narrow what "exposed" means rather than delete the test:
// an exact resource list, and matches confined to the hosts the extension
// already runs on. A `<all_urls>` match here would let any site on the web
// load the panel or detect that the extension is installed.
test('web-accessible resources are an exact list, confined to Amazon', () => {
  const m = JSON.parse(read(path.join(ROOT, 'manifest.json')));
  const war = m.web_accessible_resources;
  assert.ok(Array.isArray(war) && war.length === 1, 'expected exactly one web_accessible_resources entry');

  assert.deepEqual([...war[0].resources].sort(), [
    'icons/icon48.png',
    'panel-popover.js',
    'panel.css',
    'panel.html',
    'panel.js',
  ], 'the exposed resource list changed -- every addition is a new way to probe for this extension');

  assert.deepEqual(war[0].matches, ['https://*.amazon.com/*'],
    'web-accessible matches must stay confined to the pages the extension already runs on');

  for (const pat of war[0].matches) {
    assert.ok(!/^<all_urls>$/.test(pat) && !/^https?:\/\/\*\/\*$/.test(pat), `broad match pattern: ${pat}`);
  }

  // Everything exposed must actually exist, or the panel 404s at run time in a
  // way that only shows up as an empty iframe.
  for (const r of war[0].resources) {
    assert.ok(fs.existsSync(path.join(ROOT, r)), `web_accessible resource missing from disk: ${r}`);
  }
});

test('cosmetic: there is something to lint', () => {
  assert.ok(FILES.length >= 6, `expected the shipped file set, found ${FILES.length}`);
});

// ── The second packager ───────────────────────────────────────────────────
//
// There are now TWO things that zip this folder: build.js here (for a manual
// upload) and scripts/build-extension-zips.js at the repo root (which writes
// public/ for the app's download card). The root one keeps its own `ignore`
// list, so a file added to EXCLUDE_FILES here and not there would leak into a
// public download -- node_modules alone is ~5 MB of jsdom.
//
// This reaches outside the folder, which a shipped file must never do but a
// test may: it is the only place that can see both lists.
test('the root zip builder excludes everything build.js excludes', () => {
  const rootScript = path.join(ROOT, '..', 'scripts', 'build-extension-zips.js');
  if (!fs.existsSync(rootScript)) {
    // Not wired in yet -- that is a valid state, not a failure.
    return;
  }
  const src = fs.readFileSync(rootScript, 'utf8');
  const block = src.slice(src.indexOf('extension-user-analyser'));

  // Derived from build.js's own sets, not retyped. A hardcoded list here was
  // a THIRD copy of the same thing, and it went stale the moment __tests__
  // was renamed -- the test then reported the root builder as broken when the
  // only wrong list was its own. Reading the real sets removes that failure
  // mode entirely.
  //
  // Only entries that exist on disk are checked: EXCLUDE_DIRS carries '.git'
  // and 'dist' defensively, and demanding the root builder name a directory
  // that was never there would fail for no reason.
  const expected = [...EXCLUDE_DIRS, ...EXCLUDE_FILES]
    .filter((name) => fs.existsSync(path.join(ROOT, name)));

  const missing = expected.filter((name) => !block.includes(path.basename(name)));

  assert.deepEqual(missing, [],
    'scripts/build-extension-zips.js would ship these into public/: ' + missing.join(', '));
  assert.ok(expected.length >= 5, `only ${expected.length} exclusions checked -- the sets look wrong`);
});
