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
// __tests__/noOwnerFallback.test.js FAILS if any file in this extension so
// much as names one of those functions, or fetches a host outside
// ALLOWED_FETCH_HOSTS. That lint is the enforcement; this comment is only the
// reason.
//
// It also never touches an Amazon cookie, header or session token. Everything
// about the product comes from readPage.js reading the DOM the user is already
// looking at, inside their own tab.

const CFG = {
  SUPABASE_URL: 'https://mstibdszibcheodvnprm.supabase.co',
  // Publishable anon key. Safe to ship -- it grants nothing on its own, every
  // table is behind RLS and every row is scoped to auth.uid(). NEVER add a
  // service-role key, a Keepa key or an AWS credential to this file.  // lint-allow:keepa-mention
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
  APP_URL: 'https://inventorysprint.com',
};

/** The only hosts this extension may ever fetch. The lint enforces it. */
const ALLOWED_FETCH_HOSTS = ['mstibdszibcheodvnprm.supabase.co'];

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

/** The signed-in user's id, taken from the JWT. No network call. */
function userIdFromToken(accessToken) {
  try {
    const payload = JSON.parse(atob(String(accessToken).split('.')[1]));
    return payload?.sub || null;
  } catch (_) { return null; }
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
        case 'ISUA_AUTH_STATE': {
          const s = await ensureFreshSession();
          sendResponse({
            ok: true,
            signedIn: !!s,
            userId: s ? userIdFromToken(s.access_token) : null,
            appUrl: CFG.APP_URL,
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
  module.exports = { ALLOWED_FETCH_HOSTS, userIdFromToken };
}
