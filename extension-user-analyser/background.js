// Service worker. Holds the session handed over by handoff.js, refreshes it,
// and saves a scan to the user's OWN InventorySprint account.
//
// ── WHAT THIS WORKER DELIBERATELY CANNOT DO ───────────────────────────────
//
// It never calls fetch-listing-snapshot, asin-dimensions or  // lint-allow:owner-fallback-mention
// check-fba-listing-eligibility. Those three resolve their Amazon token as  // lint-allow:owner-fallback-mention
// `userAuth?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN')`, so a user  // lint-allow:owner-fallback-mention
// with no SP-API connection silently receives answers computed against the
// ACCOUNT OWNER's Amazon account -- the owner's gating, the owner's fee
// schedule. Measured 2026-11-12: of three accounts only the owner has SP-API,
// and one other account already holds personalhour:view, so it could reach
// that path today.
//
// tests/noOwnerFallback.test.js FAILS if any file in this extension so
// much as names one of those functions, or fetches a host outside
// ALLOWED_FETCH_HOSTS. That lint is the enforcement; this comment is only the
// reason.
//
// It also never touches an Amazon cookie, header or session token. Everything
// about the product comes from readPage.js reading the DOM the user is already
// looking at, inside their own tab.

// The data-provider module is loaded here so that every call carrying a
// user's API key leaves from one file the lint can check exhaustively.
// importScripts, not an ESM import: this worker is a classic service worker
// and switching it to a module would change how every other file in it loads.
importScripts('keepa.js');

// How long one ASIN's rank/units answer is reused before spending another of
// the user's tokens. Six hours: rank moves slowly, and the figure on screen
// carries its own age, so a stale-but-labelled number beats a spent token.
const PRODUCT_TTL_MS = 6 * 60 * 60 * 1000;

// How long a FAILED answer is reused. Failures used not to be cached at
// all, on the reasoning that caching one would hide a refilled bucket or a
// repaired key for the whole six hours. That reasoning was right about the
// six hours and wrong about the conclusion: an uncached failure means every
// retry pays Keepa again, and Keepa charges for a call it refuses.
//
// Five minutes settles both. A repaired key is usable almost at once, and a
// run of retries costs one call instead of one each.
const PRODUCT_FAIL_TTL_MS = 5 * 60 * 1000;

// The outer stop. Even with the per-ASIN cache correct, a caller that walks
// ASINs can spend without limit, and this key is the USER’S OWN -- the same
// Keepa account the server-side repricer draws on, where starving the
// repricer is a worse outcome than a blank tile.
//
// Deliberately far below the account’s refill: a human reading product
// pages cannot outrun three lookups a minute, so this never binds in normal
// use and binds immediately on a bug.
//
// The ledger lives in storage.local, NOT in a module variable. This is a
// service worker: Chrome stops it when idle and starts it again on the next
// message, which resets anything held in memory -- so an in-memory counter
// would be a cap that a worker restart lifts.
const KEEPA_CALL_CAP = 3;
const KEEPA_CALL_WINDOW_MS = 60 * 1000;
const CALL_LEDGER_KEY = 'isua_keepa_calls';

/**
 * Claim one slot in the current minute, or refuse.
 *
 * Read-modify-write on storage.local is not atomic, and two messages can
 * interleave. That is tolerable here and a mutex is not: the window is a
 * minute, the cap is three, and the worst interleaving overshoots by one
 * call. A lock that could wedge the worker would cost more than it saves.
 */
async function claimKeepaSlot() {
  const now = Date.now();
  const led = (await chrome.storage.local.get(CALL_LEDGER_KEY))[CALL_LEDGER_KEY];
  const recent = (Array.isArray(led) ? led : []).filter((t) => Number.isFinite(t) && now - t < KEEPA_CALL_WINDOW_MS);

  if (recent.length >= KEEPA_CALL_CAP) {
    const waitMs = KEEPA_CALL_WINDOW_MS - (now - Math.min(...recent));
    return {
      ok: false,
      code: 'PAUSED',
      message: 'Paused to protect your tokens: ' + KEEPA_CALL_CAP + ' lookups a minute is the cap. '
        + 'Try again in ' + Math.max(1, Math.ceil(waitMs / 1000)) + 's.',
      retryInMs: Math.max(0, waitMs),
      used: recent.length,
    };
  }

  recent.push(now);
  await chrome.storage.local.set({ [CALL_LEDGER_KEY]: recent });
  return { ok: true, used: recent.length };
}

const CFG = {
  SUPABASE_URL: 'https://mstibdszibcheodvnprm.supabase.co',
  // Publishable anon key. Safe to ship -- it grants nothing on its own, every
  // table is behind RLS and every row is scoped to auth.uid(). NEVER add a
  // service-role key, a Keepa key or an AWS credential to this file.
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
  APP_URL: 'https://inventorysprint.com',
};

/** The only hosts this extension may ever fetch. The lint enforces it. */
// What THIS file may fetch. The data provider is deliberately absent: only
// keepa.js may reach it, and naming the host here would weaken the lint that
// enforces that, by making it look generally allowed.
const ALLOWED_FETCH_HOSTS = [
  'mstibdszibcheodvnprm.supabase.co',
];

const SESSION_KEY = 'isua_session';

async function getSession() {
  try {
    const got = await chrome.storage.local.get(SESSION_KEY);
    return got?.[SESSION_KEY] || null;
  } catch (_) { return null; }
}

async function setSession(s) {
  try { await chrome.storage.local.set({ [SESSION_KEY]: s }); } catch (_) { /* ignore */ }
}

async function clearSession() {
  try { await chrome.storage.local.remove(SESSION_KEY); } catch (_) { /* ignore */ }
}

// ── password auth, handled only here ─────────────────────────────────────
//
// The panel collects the email and password and hands them straight to this
// worker; the worker exchanges them for a session and the credentials end
// there. Rules that keep that true, each one testable:
//
//   - the password is never written to storage. Only access_token,
//     refresh_token and expires_at are persisted, by setSession().
//   - the password is never logged, not even its length, and never appears
//     in an error message returned to the panel.
//   - it is sent to exactly one place: this project's Supabase auth endpoint,
//     over https. ALLOWED_FETCH_HOSTS and the lint both pin that.
//   - it is not kept in a variable after the request. The parameter goes out
//     of scope when the function returns.
//
// Why this is reasonable at all, having first argued the opposite: the panel
// is an IFRAME on the chrome-extension:// origin. Amazon's page scripts
// cannot read across that boundary -- same-origin policy, not politeness. A
// field in a shadow root injected into the page would have been a different
// matter, and that is what the earlier objection was really about.

/** Shape every auth reply the same way so the panel has one thing to read. */
function authResult(ok, extra) {
  return { ok, ...extra };
}

/**
 * Supabase returns an error body with several possible field names depending
 * on which layer rejected it. Pick whichever is present, and fall back to
 * something a person can act on rather than a status code.
 */
function authErrorMessage(data, status, fallback) {
  const m = data?.error_description || data?.msg || data?.message || data?.error;
  if (typeof m === 'string' && m.trim()) return m;
  if (status === 400) return fallback;
  if (status === 429) return 'Too many attempts — wait a minute and try again.';
  return `Sign-in failed (${status}).`;
}

async function signInWithPassword(email, password) {
  if (!email || !password) return authResult(false, { error: 'Enter your email and password.' });

  const res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!res.ok) {
    // Deliberately not logging the status alongside the email: a failed-login
    // log that names the account is a list of valid addresses.
    return authResult(false, { error: authErrorMessage(data, res.status, 'Invalid email or password.') });
  }
  if (!data?.access_token || !data?.refresh_token) {
    return authResult(false, { error: 'Signed in, but no session came back. Try again.' });
  }

  await setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  });
  return authResult(true, { email: userEmailFromToken(data.access_token) });
}

/**
 * Sign-up is NOT in the original extension -- it is new here, because a user
 * analyser whose first instruction is "go and sign up somewhere else" is not
 * much of a user analyser.
 *
 * Two outcomes, and conflating them is the usual bug: with email confirmation
 * ON (which this project uses -- see [auth.hook.send_email] in config.toml)
 * the response carries a user but NO session, and the account does nothing
 * until the link is clicked. Only when confirmation is off does a session
 * come back immediately. The panel must say which happened.
 */
async function signUpWithPassword(email, password) {
  if (!email || !password) return authResult(false, { error: 'Enter an email and a password.' });
  if (String(password).length < 6) {
    return authResult(false, { error: 'Password must be at least 6 characters.' });
  }

  const res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!res.ok) {
    return authResult(false, { error: authErrorMessage(data, res.status, 'Could not create the account.') });
  }

  if (data?.access_token && data?.refresh_token) {
    await setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    });
    return authResult(true, { signedIn: true, email: userEmailFromToken(data.access_token) });
  }

  // Confirmation required. No session, and saying "signed in" here would send
  // the user back to a panel that still shows them signed out.
  return authResult(true, { signedIn: false, confirmationRequired: true });
}

/**
 * Refresh when the access token is within 5 minutes of expiry.
 *
 * Returns null rather than throwing when there is no session: "not signed in"
 * is an ordinary state for this extension, and the panel has a message for it.
 * A network failure here must NOT clear the session -- only an explicit
 * sign-out does that, same rule as handoff.js.
 */
async function ensureFreshSession() {
  const s = await getSession();
  if (!s?.refresh_token) return null;

  const expiresAt = Number(s.expires_at || 0) * 1000;
  if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) return s;

  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) return s; // keep what we have; the caller will see a 401
    const j = await res.json();
    if (!j?.access_token || !j?.refresh_token) return s;
    const next = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at };
    await setSession(next);
    return next;
  } catch (_) {
    return s;
  }
}

/** Insert into a user-scoped table. RLS does the rest. */
async function restInsert(table, row) {
  const s = await ensureFreshSession();
  if (!s) throw new Error('NOT_SIGNED_IN');
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${s.access_token}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** A claim from the access token. No network call, no verification. */
function claimFromToken(accessToken, claim) {
  try {
    const payload = JSON.parse(atob(String(accessToken).split('.')[1]));
    return payload?.[claim] || null;
  } catch (_) { return null; }
}

/** The signed-in user's id, taken from the JWT. */
function userIdFromToken(accessToken) {
  return claimFromToken(accessToken, 'sub');
}

/**
 * The signed-in address, taken from the JWT.
 *
 * Shown in the popup deliberately. An earlier version withheld it on the
 * grounds that a popup has no business displaying an address -- which sounds
 * careful and is, here, wrong. This project has already had data written into
 * the wrong account because somebody was signed in as one address while
 * believing they were another, and nothing on screen contradicted them. The
 * address is the one piece of information that makes "which account is this
 * saving into?" answerable at a glance.
 *
 * It is read from the token the extension already holds, not fetched, and it
 * never leaves the popup.
 */
function userEmailFromToken(accessToken) {
  return claimFromToken(accessToken, 'email');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'ISUA_SET_SESSION': {
          const s = msg.session;
          if (!s?.access_token || !s?.refresh_token) { sendResponse({ ok: false, error: 'bad session' }); break; }
          await setSession({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at });
          sendResponse({ ok: true });
          break;
        }
        case 'ISUA_SIGN_OUT':
          await clearSession();
          sendResponse({ ok: true });
          break;
        // ── data-provider key, held in this browser only ──────────────────
        //
        // The panel is told the STATE (is a key saved, does it work, how many
        // tokens are left) and never the key. There is deliberately no
        // message that returns it: a reply the panel can read is a reply a
        // bug can leak.
        case 'ISUA_PROVIDER_STATE': {
          const key = await KEEPA.getKey();
          if (!key) { sendResponse({ ok: true, hasKey: false }); break; }
          const v = await KEEPA.validate(key);
          sendResponse({
            ok: true,
            hasKey: true,
            masked: KEEPA.maskKey(key),
            valid: !!v.ok,
            code: v.ok ? null : v.code,
            message: v.ok ? null : v.message,
            tokensLeft: v.ok ? v.tokensLeft : null,
            refillIn: v.ok ? v.refillIn : null,
            refillRate: v.ok ? v.refillRate : null,
          });
          break;
        }
        // Validated BEFORE it is stored, so an unusable key is never saved
        // and the user is never left with a stored key that silently fails.
        case 'ISUA_PROVIDER_SET_KEY': {
          const v = await KEEPA.validate(msg.key);
          if (!v.ok) { sendResponse({ ok: false, code: v.code, error: v.message }); break; }
          await KEEPA.setKey(msg.key);
          sendResponse({
            ok: true,
            masked: KEEPA.maskKey(String(msg.key).trim()),
            tokensLeft: v.tokensLeft,
            refillIn: v.refillIn,
            refillRate: v.refillRate,
          });
          break;
        }
        case 'ISUA_PROVIDER_CLEAR_KEY': {
          await KEEPA.clearKey();
          sendResponse({ ok: true });
          break;
        }
        // One ASIN's rank and units, CACHED PER ASIN.
        //
        // Every call spends one of the user's own tokens, and a product page
        // gets revisited constantly -- tabbing back and forth would spend a
        // token each time for an answer that does not move hour to hour. The
        // cache makes a revisit free; PRODUCT_TTL_MS is the only knob.
        // One ASIN's rank, units and fees. ONE TOKEN, and the only message
        // in this worker that spends anything, so every guard lives here.
        //
        // THERE IS NO force. It used to accept msg.force to skip the cache,
        // and a parameter that skips the only per-ASIN guard is the whole
        // guard, optional. Nothing sent it; it is gone so nothing can.
        //
        // Order matters and is not arbitrary: cache FIRST, then the cap.
        // Checking the cap first would refuse answers that cost nothing.
        case 'ISUA_PROVIDER_PRODUCT': {
          const asin = String(msg.asin || '').trim().toUpperCase();
          const mkt = String(msg.marketplace || 'US').toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asin)) {
            sendResponse({ ok: false, error: 'Not a valid ASIN.',
              diag: { asin, marketplace: mkt, outcome: 'skipped', reason: 'bad ASIN', tokensConsumed: 0 } });
            break;
          }

          const cacheKey = `isua_prod_${mkt}_${asin}`;
          const hit = (await chrome.storage.local.get(cacheKey))[cacheKey];
          if (hit && Number.isFinite(hit.at) && hit.value) {
            // A failed answer is held briefly, a good one for the full TTL.
            const ttl = hit.value.ok ? PRODUCT_TTL_MS : PRODUCT_FAIL_TTL_MS;
            const age = Date.now() - hit.at;
            if (age < ttl) {
              sendResponse({
                ...hit.value,
                cached: true,
                diag: { asin, marketplace: mkt, outcome: 'cached', ageMs: age,
                  status: hit.value.status ?? null, tokensConsumed: 0,
                  history: hit.value.history || null,
                  dimKeys: (hit.value.dims && hit.value.dims.keysSeen) || null,
                  error: hit.value.ok ? null : (hit.value.message || hit.value.error || null) },
              });
              break;
            }
          }

          const slot = await claimKeepaSlot();
          if (!slot.ok) {
            sendResponse({ ok: false, code: slot.code, error: slot.message, retryInMs: slot.retryInMs,
              diag: { asin, marketplace: mkt, outcome: 'skipped', reason: 'per-minute cap',
                tokensConsumed: 0, error: slot.message } });
            break;
          }

          const r = await KEEPA.productSummary(asin, mkt);

          // Cached EITHER WAY, which is the fix for the retry storm: an
          // uncached failure made every repeat pay Keepa again.
          await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), value: r } });

          const diag = { asin, marketplace: mkt, outcome: 'called',
            status: r.status ?? null,
            tokensConsumed: Number.isFinite(r.tokensConsumed) ? r.tokensConsumed : null,
            tokensLeft: Number.isFinite(r.tokensLeft) ? r.tokensLeft : null,
            callsThisMinute: slot.used,
            history: r.history || null,
            dimKeys: (r.dims && r.dims.keysSeen) || null,
            error: r.ok ? null : (r.message || null) };

          if (!r.ok) { sendResponse({ ok: false, code: r.code, error: r.message, diag }); break; }
          sendResponse({ ...r, diag });
          break;
        }
        case 'ISUA_SIGN_IN_PASSWORD': {
          const r = await signInWithPassword(msg.email, msg.password);
          sendResponse(r);
          break;
        }
        case 'ISUA_SIGN_UP_PASSWORD': {
          const r = await signUpWithPassword(msg.email, msg.password);
          sendResponse(r);
          break;
        }
        case 'ISUA_AUTH_STATE': {
          const s = await ensureFreshSession();
          sendResponse({
            ok: true,
            signedIn: !!s,
            userId: s ? userIdFromToken(s.access_token) : null,
            email: s ? userEmailFromToken(s.access_token) : null,
            appUrl: CFG.APP_URL,
            signUpUrl: `${CFG.APP_URL}/signup`,
            signInUrl: `${CFG.APP_URL}/login`,
          });
          break;
        }
        case 'ISUA_SAVE_READING': {
          // Saves ONLY what the page said, plus the ASIN and marketplace.
          // Nothing derived, nothing from the owner's account.
          const s = await ensureFreshSession();
          if (!s) { sendResponse({ ok: false, error: 'NOT_SIGNED_IN' }); break; }
          const uid = userIdFromToken(s.access_token);
          if (!uid) { sendResponse({ ok: false, error: 'NO_USER_ID' }); break; }
          const r = msg.reading || {};
          const data = await restInsert('user_analyser_readings', {
            user_id: uid,
            asin: r.asin ?? null,
            marketplace: 'US',
            title: r.title ?? null,
            price_text: r.price_text ?? null,
            buy_box_seller: r.buy_box_seller ?? null,
            seller_count: r.seller_count ?? null,
            bsr: r.bsr ?? null,
            source: 'page_read',
            page_url: r.page_url ?? null,
          });
          sendResponse({ ok: true, data });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async sendResponse
});

// Exported for the lint test only; harmless in the worker.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ALLOWED_FETCH_HOSTS, userIdFromToken, userEmailFromToken, claimFromToken };
}
