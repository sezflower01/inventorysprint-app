// The guards that stand between a bug and the user's Keepa balance.
//
// WHY THIS FILE EXISTS. On 2026-11-14 the panel was reported as looping and
// burning 46 tokens on one ASIN. It was not: the provider call never fired at
// all, because `hasKey` is set by a sendMessage round trip to the worker while
// the page reading arrives over a same-document postMessage, so the reading
// always won the race and `requestRank` returned early every time. Zero tokens
// were spent by the extension.
//
// Two things made a non-event look like an emergency:
//
//   1. a tile that reads "Not read yet" after a call that never happened is
//      indistinguishable from one after a call that was refused, so there was
//      nothing to diagnose from;
//   2. the key is the user's OWN, and it is the same Keepa account the
//      server-side repricer draws on -- so "is this spending my tokens?" is a
//      question with real stakes, and it deserved an answer in the panel.
//
// So these tests pin the guards AND the diagnostic. The guards are cheap
// insurance; the diagnostic is what makes the next report start from facts.
//
// These are source-shape tests. The worker is a service worker that cannot be
// instantiated here, so each one reads background.js and asserts the ORDER and
// PRESENCE of its guards. That is weaker than executing them, and it is chosen
// deliberately over mocking chrome.* well enough to run the handler: a mock
// that drifts from the real storage semantics would pass while the guard broke.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8');

/** The product handler, which is the only message in the worker that spends. */
function productHandler() {
  const from = bg.indexOf("case 'ISUA_PROVIDER_PRODUCT'");
  const to = bg.indexOf("case 'ISUA_SIGN_IN_PASSWORD'");
  assert.ok(from > -1 && to > from, 'the product handler has gone');
  return bg.slice(from, to);
}

test('nothing in the extension can fire a lookup unattended', () => {
  // THE LOAD-BEARING TEST. Every Keepa call must be downstream of a page load
  // or a click, because that is what bounds the worst case: a human reading
  // product pages cannot outrun the cap, and an unattended timer could spend
  // all night. The extension asks for no alarms permission either.
  for (const f of ['background.js', 'panel.js', 'content.js', 'keepa.js', 'readPage.js', 'handoff.js', 'popup.js']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // Comments may discuss these; code may not use them.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bsetInterval\s*\(/.test(code), `${f} polls on a timer`);
    assert.ok(!/chrome\.alarms/.test(code), `${f} schedules a chrome alarm`);
    assert.ok(!/new\s+MutationObserver/.test(code), `${f} re-reads on DOM mutation`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(!(manifest.permissions || []).includes('alarms'),
    'the alarms permission is back, which would allow unattended spending');
});

test('the per-minute cap exists, is claimed before the call, and refuses', () => {
  assert.ok(/const KEEPA_CALL_CAP = \d+;/.test(bg), 'the per-minute cap has gone');
  assert.ok(/const KEEPA_CALL_WINDOW_MS = /.test(bg), 'the cap window has gone');

  const cap = Number(bg.match(/const KEEPA_CALL_CAP = (\d+);/)[1]);
  assert.ok(cap > 0 && cap <= 5, `the cap is ${cap}, which is not a human reading rate`);

  // The ledger must survive a worker restart. Chrome stops an idle service
  // worker and starts it again on the next message, so a module-level counter
  // is a cap that a restart lifts.
  const claim = bg.slice(bg.indexOf('async function claimKeepaSlot'), bg.indexOf("case 'ISUA_PROVIDER_STATE'"));
  assert.ok(/storage\.local\.get/.test(claim) && /storage\.local\.set/.test(claim),
    'the call ledger is not persisted, so a worker restart resets the cap');

  const h = productHandler();
  const claimAt = h.indexOf('claimKeepaSlot');
  const callAt = h.indexOf('KEEPA.productSummary');
  assert.ok(claimAt > -1, 'the handler no longer claims a slot');
  assert.ok(claimAt < callAt, 'the slot is claimed after the token is spent, which defeats the cap');
  assert.ok(/PAUSED/.test(bg), 'a refused call no longer reports a distinct paused state');
});

test('the cache is consulted before the cap, so a free answer is never refused', () => {
  const h = productHandler();
  const readAt = h.indexOf('storage.local.get');
  const claimAt = h.indexOf('claimKeepaSlot');
  const callAt = h.indexOf('KEEPA.productSummary');
  assert.ok(readAt > -1, 'the handler no longer reads the cache');
  assert.ok(readAt < claimAt, 'the cap is checked before the cache, so cached answers burn cap slots');
  assert.ok(readAt < callAt, 'the cache is read after the token is spent, which defeats it');
});

test('a FAILED answer is cached too, briefly, and never auto-retried', () => {
  // This reverses an earlier rule in this suite, which asserted that a failure
  // must never be cached -- on the reasoning that caching one would hide a
  // refilled bucket or a repaired key for the whole six-hour TTL.
  //
  // That reasoning was right about six hours and wrong about the conclusion.
  // Keepa charges for a call it refuses, so an uncached failure means every
  // retry pays again. A short TTL answers both: five minutes cannot hide a
  // repaired key for long, and it collapses a run of retries into one call.
  assert.ok(/const PRODUCT_FAIL_TTL_MS = /.test(bg), 'failures are no longer cached at all');
  const failTtl = eval(bg.match(/const PRODUCT_FAIL_TTL_MS = ([^;]+);/)[1]);
  const okTtl = eval(bg.match(/const PRODUCT_TTL_MS = ([^;]+);/)[1]);
  assert.ok(failTtl > 0, 'the failure TTL is zero, so failures are effectively uncached');
  assert.ok(failTtl <= 10 * 60 * 1000,
    'the failure TTL is over ten minutes, which hides a repaired key');
  assert.ok(failTtl < okTtl, 'a failure is held as long as a good answer');

  const h = productHandler();
  const setAt = h.indexOf('storage.local.set');
  const okCheckAt = h.indexOf('if (!r.ok)');
  assert.ok(setAt > -1, 'the handler no longer writes the cache');
  assert.ok(okCheckAt > -1, 'the handler no longer distinguishes a failed answer');
  assert.ok(setAt < okCheckAt,
    'the cache write is behind the ok check again, so failures are not cached and every retry pays');

  // No retry inside the worker. A retry is indistinguishable from a loop from
  // the outside, and it is what makes a transient provider fault expensive.
  assert.ok(!/setTimeout[\s\S]{0,200}productSummary/.test(h), 'the handler schedules a retry');
});

test('there is no force parameter to skip the per-ASIN cache', () => {
  // A parameter that skips the only per-ASIN guard makes the guard optional,
  // and this repo has already been burned by a force mode used by habit.
  const h = productHandler();
  assert.ok(!/msg\.force/.test(h), 'the product handler accepts msg.force again');
  assert.ok(!/force:\s*true/.test(panel), 'the panel sends force');
});

test('the panel replays the reading once the key state is known', () => {
  // THE ACTUAL BUG. hasKey arrives from the worker; the page reading arrives
  // from the host over postMessage and always wins. Without the replay,
  // requestRank returns at the !hasKey guard on every page load and nothing
  // ever calls it again -- no timer, no observer, nothing.
  assert.ok(/let lastReading = null;/.test(panel), 'the panel no longer holds the reading');

  const boot = panel.slice(panel.lastIndexOf('refreshKeepa(('));
  assert.ok(/requestRank\(lastReading\)/.test(boot),
    'the startup gate callback no longer replays the reading, so the first load asks for nothing');

  // And the guard it works around must stay: a keyless panel must not call.
  assert.ok(/if \(!hasKey\) return;/.test(panel), 'a panel with no key would now call the provider');
});

test('a re-read re-applies the paid-for answer instead of discarding it', () => {
  // renderNeedsAmazon blanks every provider-fed tile. On a REREAD that ran
  // before this, the answer was wiped AND not re-requested, because rankFor
  // still matched -- so a re-read silently downgraded a working panel.
  const handler = panel.slice(panel.indexOf("if (d.type === 'PAGE_READING')"));
  const blankAt = handler.indexOf('renderNeedsAmazon()');
  const replayAt = handler.indexOf('if (lastRank) renderRank(lastRank)');
  assert.ok(replayAt > -1, 'the panel no longer re-applies the held provider answer');
  assert.ok(blankAt < replayAt, 'the answer is re-applied before the tiles are blanked, so it is lost');
});

test('a failed lookup names a reason on the tiles, not the not-read label', () => {
  // "Not read yet" after a call that failed is the thing that made a provider
  // error look like a loop: it rendered identically to never having asked.
  const fn = panel.slice(panel.indexOf('function renderRank'), panel.indexOf('function requestRank'));
  const bad = fn.slice(0, fn.indexOf('// Rank: the page is preferred'));
  assert.ok(/NEEDS_AMAZON/.test(bad),
    'the failure path no longer touches the dependent tiles, so they keep saying "not read yet"');
  // This used to test for NOT_READ, a constant that no longer exists -- which
  // made the assertion pass for the wrong reason. The panel now has TWO
  // empty-state labels and the failure path must write NEITHER: both of them
  // describe a tile nobody has asked about yet, and this tile was asked about
  // and refused.
  assert.ok(!/\b(LOADING|NOT_IN_VERSION)\b/.test(bad),
    'the failure path writes one of the two empty-state labels, so a refused lookup cannot be told from one that never happened');
});

test('every lookup reports what it cost, including a failed one', () => {
  // Reporting only successes is how the shared budget drifts from Keepa's own
  // accounting -- and a refused call still costs.
  assert.ok(/tokensConsumed/.test(bg), 'the worker no longer reports a call cost');

  const keepa = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  const summary = keepa.slice(keepa.indexOf('async function productSummary'));
  const failBranch = summary.slice(summary.indexOf('if (!out.ok)'), summary.indexOf('return {\r\n      ...out'));
  assert.ok(/tokensConsumed/.test(failBranch),
    'a 200 that carried no product is reported as free, though it cost a token');

  // The diagnostic must never carry the key.
  const diag = panel.slice(panel.indexOf('function renderDiag'), panel.indexOf('function renderRank'));
  assert.ok(!/getKey|\bkey\b\s*[:,)]/.test(diag), 'the diagnostic may be logging the key');
});

test('the series we already pay for are reported, not silently dropped', () => {
  // Keepa's /product defaults to history=1 and keepa.js never sends
  // history=0, so every lookup has been buying the price and rank series.
  // summariseProduct kept six fields and binned the rest, and panel.html has
  // carried an #apx-history-chart canvas the whole time with nothing drawing
  // to it. That is a paid-for input thrown away on every call.
  //
  // This does NOT assert a chart exists. It asserts the panel can TELL you
  // whether the data arrived, so the decision to build one rests on a
  // measurement instead of on the provider's documentation.
  const keepa = fs.readFileSync(path.join(ROOT, 'keepa.js'), 'utf8');
  // Comments DISCUSS history=0; code must not SEND it. Strip them first --
  // the comment explaining this very rule was what tripped this assertion.
  const keepaCode = keepa.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/history=0/.test(keepaCode) === false,
    'keepa.js now opts out of history, so the series stop arriving');

  const summary = keepa.slice(keepa.indexOf('function summariseProduct'),
    keepa.indexOf('async function productSummary'));
  assert.ok(/p\.csv/.test(summary), 'summariseProduct no longer looks at the series at all');
  assert.ok(/present:/.test(summary) && /bytes:/.test(summary),
    'the history report no longer carries a size, so the caching decision has nothing to stand on');

  // Shape only. Keeping the arrays in the answer is a separate decision that
  // depends on the measured size -- a 5-year csv per ASIN in
  // chrome.storage.local could blow the quota, which would be a worse bug
  // than the missing chart.
  assert.ok(!/csv,$/m.test(summary),
    'the raw series are returned now; if that is deliberate, cap or downsample them first');

  // And the worker must pass the report through on BOTH paths, or a cached
  // answer would look like one that carried nothing.
  const h = productHandler();
  assert.equal((h.match(/history:/g) || []).length, 2,
    'the history report is not carried on both the cached and the called path');
});
