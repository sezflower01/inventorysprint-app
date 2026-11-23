// Service worker — token storage, refresh, edge-function proxy, REST insert.
// Identical contract to the Analyzer extension so the same /tools/ext-handoff
// page works without changes.
importScripts("config.js", "salesWindows.js");

const CFG = self.INVSPRNT_CFG;

async function getSession() {
  const { arbipro_session } = await chrome.storage.local.get("arbipro_session");
  return arbipro_session || null;
}
async function setSession(s) {
  await chrome.storage.local.set({ arbipro_session: s });
  await chrome.storage.local.remove("arbipro_signed_out");
}

async function clearSessionExplicit(reason) {
  await chrome.storage.local.remove("arbipro_session");
  await chrome.storage.local.set({ arbipro_signed_out: true });
  logAuth("extension_session_cleared", { reason });
  logAuth("extension_login_required");
}

async function isSignedOutExplicit() {
  const { arbipro_signed_out } = await chrome.storage.local.get("arbipro_signed_out");
  return arbipro_signed_out === true;
}

// Auth-resilience constants. When Supabase /auth is slow we want extension
// panels to stay responsive instead of hanging on a 30-45s gotrue timeout.
const REFRESH_TIMEOUT_MS = 7000;
// A TOTAL budget for the whole refresh, not a budget per attempt.
//
// The retry added on 2026-10-02 used 7 s then 12 s, so a slow gotrue could keep
// the worker busy for 19.4 s. The panels give up on a worker message long
// before that, so the retry that was meant to fix "nothing retries" instead
// turned a fast, honest failure into a timeout -- and the panel's own retry
// then queued a second request behind the same in-flight refresh. A fix that
// outlives its caller's patience is not a fix.
//
// 7 s total: a first attempt of up to 4 s, then whatever is left. Still two
// real attempts, still inside what every caller will wait for.
const REFRESH_TOTAL_BUDGET_MS = 7000;
const REFRESH_FIRST_ATTEMPT_MS = 4000;
const REFRESH_RETRY_DELAY_MS = 250;
const REFRESH_ATTEMPTS = 2;
// How long a previously-valid access token is still considered usable as a
// "last-known-good" fallback after its nominal expiry, when the refresh
// endpoint is slow/unreachable. SP-API/edge calls will still get a 401 if the
// token is truly dead, but most of the time gotrue is just slow.
const STALE_TOKEN_GRACE_MS = 10 * 60 * 1000; // 10 min

function logAuth(event, extra) {
  try {
    const tag = "[InvSPRNT-auth]";
    if (extra !== undefined) console.log(tag, event, extra);
    else console.log(tag, event);
  } catch (_) { /* ignore */ }
}

let refreshPromise = null;
async function refreshToken({ allowStaleFallback = true } = {}) {
  // Single shared in-flight promise so multiple panels/tabs don't trigger
  // parallel refresh calls during a slowdown.
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const sess = await getSession();
    if (!sess?.refresh_token) throw new Error("Not signed in");
    logAuth("refresh_started");
    // ACTUALLY RETRIES, which the error text used to only promise.
    //
    // The old code made a single attempt and, on a timeout or a transient 5xx,
    // threw "Auth server slow — retrying" — while nothing retried. Worse, the
    // place that message reaches the user is the 401 path in invoke()/restGet():
    // the cached token had already been rejected, this refresh was the recovery,
    // and the panel printed a promise of a retry that never came. The only real
    // fix the user had was to press the button again themselves.
    //
    // Two attempts, the second with a wider window, then an honest message.
    // A confirmed sign-out (invalid_grant) still fails immediately — retrying a
    // token Supabase has actually revoked is pointless.
    let res = null;
    let lastKind = "";
    const refreshStartedAt = Date.now();
    for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
      // Out of budget: stop rather than start an attempt the caller will not
      // wait for.
      if (attempt > 1 && Date.now() - refreshStartedAt >= REFRESH_TOTAL_BUDGET_MS) break;
      const ctrl = new AbortController();
      // Each attempt gets what remains of the shared budget.
      const spent = Date.now() - refreshStartedAt;
      const remaining = Math.max(500, REFRESH_TOTAL_BUDGET_MS - spent);
      const budget = attempt === 1 ? Math.min(REFRESH_FIRST_ATTEMPT_MS, remaining) : remaining;
      const timer = setTimeout(() => ctrl.abort("refresh_timeout"), budget);
      let thisRes = null;
      try {
        thisRes = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: sess.refresh_token }),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        // Network abort / timeout / 504-ish failure. NEVER sign out here — the
        // refresh token is almost certainly still valid, gotrue is just slow.
        const isAbort = e?.name === "AbortError" || String(e?.message || "").includes("abort");
        lastKind = isAbort ? "timeout" : "network";
        logAuth(isAbort ? "refresh_timeout" : "refresh_network_error", { attempt, message: String(e?.message || e) });
        if (attempt < REFRESH_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAY_MS));
          continue;
        }
        break;
      }
      clearTimeout(timer);
      if (thisRes.ok) { res = thisRes; break; }

      // Distinguish "Supabase says you're really signed out" (400/401 with
      // invalid_grant) from transient 5xx. Only the former clears session.
      let bodyText = "";
      try { bodyText = await thisRes.text(); } catch (_) { /* ignore */ }
      const isHardSignOut =
        (thisRes.status === 400 || thisRes.status === 401) &&
        /invalid[_ ]grant|refresh[_ ]token[_ ]not[_ ]found|expired/i.test(bodyText);
      if (isHardSignOut) {
        logAuth("confirmed_signed_out", { status: thisRes.status });
        await clearSessionExplicit("invalid_grant");
        throw new Error("Not signed in");
      }
      lastKind = `http_${thisRes.status}`;
      logAuth("refresh_transient_failure", { attempt, status: thisRes.status });
      if (attempt < REFRESH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAY_MS));
        continue;
      }
    }

    if (!res) {
      // Every attempt failed and the token was not revoked, so the last-known-good
      // token is still the best thing we have.
      if (allowStaleFallback && sess.access_token) {
        const ageMs = Date.now() - ((sess.expires_at || 0) * 1000);
        if (ageMs < STALE_TOKEN_GRACE_MS) {
          logAuth("reused_cached_token", { stale_by_ms: Math.max(0, ageMs), after: lastKind });
          return sess;
        }
      }
      logAuth("refresh_gave_up", { after: lastKind, attempts: REFRESH_ATTEMPTS });
      // Says what happened and what to do, instead of describing a retry that
      // has already been tried twice.
      throw new Error("Could not refresh sign-in (auth server did not respond) — try again");
    }
    const data = await res.json();
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || sess.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    };
    await setSession(next);
    logAuth("refresh_success");
    return next;
  })();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}

// Direct email/password sign-in, entirely inside the extension — no web app
// tab required. Same Supabase Auth endpoint the website's own login form
// uses under the hood, just called directly with grant_type=password instead
// of refresh_token. The resulting session is kept alive indefinitely by the
// existing refreshToken()/ensureFreshSession() machinery above — the user
// stays signed in until they explicitly sign out.
async function signInWithPassword(email, password) {
  const res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.message || "Invalid email or password";
    throw new Error(msg);
  }
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  await setSession(next);
  return next;
}

async function ensureFreshSession() {
  let s = await getSession();
  if (!s) throw new Error("Not signed in");
  if (s.expires_at && s.expires_at - Math.floor(Date.now() / 1000) < 60) {
    try {
      s = await refreshToken();
    } catch (e) {
      // If we still have a token at all, let the caller try with it. Real
      // 401s downstream will trigger a second refresh attempt.
      const cur = await getSession();
      if (cur?.access_token) return cur;
      throw e;
    }
  }
  return s;
}

async function invoke(fn, body) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/functions/v1/${fn}`;
  const headers = {
    "Content-Type": "application/json",
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
  };
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body || {}) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body || {}) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

// ── Reserved units: can they cover FUTURE demand? ───────────────────────────
//
// PORTED FROM src/lib/replenishment.ts, which this file’s forecast claimed to
// be a "verbatim port of" and was not. The shared library excludes Reserved
// when the last FBA receipt is older than reservedFreshDays; this file added
// Reserved unconditionally, so two implementations of one model disagreed and
// the extension was the optimistic one.
//
// The reasoning, which is the shared library’s: Reserved sits in an ambiguous
// state. Either it is still checking in from a recent shipment, in which case
// it becomes Available and does cover future demand -- or it is already
// committed to a customer order, in which case it never will. A recent
// receipt is the only evidence that distinguishes them.
//
// UNKNOWN KEEPS IT, which is the optimistic direction and is deliberately the
// shared library’s choice rather than mine: daysSinceLastReceived == null
// means no received shipment was found for the ASIN, not that the stock is
// stale. Changing that would change every reorder figure in the app, so the
// two implementations agree on it and the decision stays in one place.
//
// A SEPARATE FUNCTION so the parity test can run it, rather than grep the
// source and hope. background.js is a service worker and cannot be loaded
// whole in a test; this can be extracted and executed.
const REP_RESERVED_FRESH_DAYS = 7;

function repPipelineStock(available, inbound, reserved, daysSinceLastReceived, reservedFreshDays) {
  const fresh = Number.isFinite(reservedFreshDays) ? reservedFreshDays : REP_RESERVED_FRESH_DAYS;
  const reservedExcluded = daysSinceLastReceived != null && daysSinceLastReceived > fresh;
  const effectiveReserved = reservedExcluded ? 0 : (Number(reserved) || 0);
  return {
    reservedExcluded,
    effectiveReserved,
    totalPipelineStock: (Number(available) || 0) + (Number(inbound) || 0) + effectiveReserved,
  };
}

// ── Ghost inventory rows, and whether an ASIN is still a listing ────────
//
// AT THE TOP LEVEL ON PURPOSE. Both of these were inline inside the
// INVSPRNT_FIND_LISTING handler, which cannot be loaded in a test -- this file
// is a service worker and registers chrome.* listeners as it parses. The
// Reserved-units rule in this same file was ported wrong and sat undetected
// for exactly that reason, so the rules that decide what the seller is told
// live where a test can extract and execute them.
//
// NOT_FOUND joins NOT_IN_CATALOG and DELETED (2026-11-16). The label printer
// already treated it as dead while the Add Purchase picker still offered it,
// so the picker could hand the user a SKU the printer then refused -- two
// ghost rules, one of them wrong.
//
// INACTIVE is NOT a ghost here, unlike src/lib/ghostFilter.ts which hides it
// from Synced Inventory. That rule also hides zero-stock rows, and logging a
// replenishment for an out-of-stock SKU is the commonest reason to open Add
// Purchase. This repo has also measured that an INACTIVE row with stock is
// usually STALE STOCK rather than a dead listing, so calling it gone would
// send the seller to relist something that is still there.
const GHOST_LISTING_STATUSES = ["NOT_IN_CATALOG", "DELETED", "NOT_FOUND"];

function isGhostInventoryRow(r) {
  if (!r) return true;
  if (GHOST_LISTING_STATUSES.includes(String(r.listing_status || "").toUpperCase())) return true;
  if (String(r.sku || "").toLowerCase().startsWith("amzn.gr.")) return true;
  return false;
}

// live    at least one inventory SKU that is not a ghost
// ghost   inventory rows exist and EVERY one is a ghost
// absent  no inventory row at all for this ASIN
//
// "absent" deliberately does not claim deletion: it says what we can see,
// which is nothing. Deleted-and-purged, never-listed and never-synced are
// indistinguishable from here, and guessing between them would put a false
// certainty in front of the seller.
function listingPresenceVerdict(asin, invRows, liveRows, clRows) {
  const rows = Array.isArray(invRows) ? invRows : [];
  const live = Array.isArray(liveRows) ? liveRows : [];
  return {
    asin: String(asin || "").trim().toUpperCase(),
    state: !rows.length ? "absent" : (live.length ? "live" : "ghost"),
    inventory_rows: rows.length,
    live_skus: live.map((r) => r && r.sku).filter(Boolean),
    ghosts: rows.filter(isGhostInventoryRow).map((r) => ({
      sku: r.sku || null,
      listing_status: r.listing_status || null,
      reason: r.ghost_reason || r.deleted_reason || null,
    })),
    purchase_history: Array.isArray(clRows) ? clRows.length : 0,
  };
}

async function restGet(path) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${path}`;
  const headers = { apikey: CFG.SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` };
  let res = await fetch(url, { headers });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetch(url, { headers });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

/**
 * Call a Postgres function through PostgREST.
 *
 * Added for get_asin_profit, which is where per-ASIN profit is DEFINED. The
 * panel must not recompute it: answering "what did this ASIN earn" by hand
 * produced four different numbers on 2026-10-03, and a second implementation
 * living in the extension would become a fifth that drifts from the Sales
 * Report without anyone noticing.
 */
async function restRpc(fn, args) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
    "Content-Type": "application/json",
  };
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(args || {}) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(args || {}) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

async function restInsert(table, row) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return Array.isArray(data) ? data[0] : data;
}

async function restPatch(path, body) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  let res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return Array.isArray(data) ? data[0] : data;
}



/**
 * Keep supplier_links honest.
 *
 * It is free-form jsonb, read by the supplier search, by hasSuppliers() in
 * FIND_LISTING and by firstSupplierLink() on the panel -- all of which treat
 * "a row exists" as "a retailer is on file". A blank editor row the seller
 * never filled in would satisfy all three. So: drop rows with no link, trim,
 * add the scheme Amazon-side links are stored with, and de-duplicate.
 */
function normalizeSupplierLinks(arr) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(arr) ? arr : []) {
    let link = String(raw?.link ?? "").trim();
    if (!link) continue;
    if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
    const key = link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ link, discount_code: String(raw?.discount_code ?? "").trim() });
  }
  return out;
}

function userIdFromJWT(access_token) {
  try { return JSON.parse(atob(access_token.split(".")[1])).sub; } catch { return null; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "INVSPRNT_SET_SESSION":
          await setSession(msg.session); sendResponse({ ok: true }); break;
        case "INVSPRNT_GET_SESSION": {
          const session = await getSession();
          const signed_out = await isSignedOutExplicit();
          sendResponse({ ok: true, session, signed_out });
          break;
        }
        case "INVSPRNT_SIGN_OUT":
          await clearSessionExplicit("popup_signout");
          sendResponse({ ok: true });
          break;
        case "INVSPRNT_SIGN_IN_PASSWORD": {
          await signInWithPassword(msg.email, msg.password);
          sendResponse({ ok: true });
          break;
        }
        case "INVSPRNT_EXPLICIT_SIGN_OUT":
          await clearSessionExplicit("web_app_logout");
          sendResponse({ ok: true });
          break;
        case "INVSPRNT_INVOKE": {
          const data = await invoke(msg.fn, msg.body);
          sendResponse({ ok: true, data });
          break;
        }
        case "INVSPRNT_LOOKUP_FNSKU": {
          const asin = encodeURIComponent(msg.asin);
          const data = await restGet(`fnsku_map?asin=eq.${asin}&select=fnsku,condition&limit=1`);
          sendResponse({ ok: true, data: Array.isArray(data) ? data[0] || null : null });
          break;
        }
        case "INVSPRNT_GET_PRIMARY_SELLER_AUTH": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const rows = await restGet(
            `seller_authorizations?user_id=eq.${uid}&select=seller_id,selling_partner_id,marketplace_id,is_active`
          );
          const active = (Array.isArray(rows) ? rows : []).filter((r) => r.is_active !== false);
          const picked = active.find((r) => r.marketplace_id === "ATVPDKIKX0DER") || active[0] || null;
          sendResponse({ ok: true, data: picked });
          break;
        }
        case "INVSPRNT_LOAD_FNSKU_SOURCES": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const asin = encodeURIComponent(String(msg.asin || "").trim().toUpperCase());
          const sellerId = encodeURIComponent(String(msg.sellerId || ""));
          const marketplaceId = encodeURIComponent(String(msg.marketplaceId || ""));
          const [fnskuRows, inventoryRows, createdListingRows] = await Promise.all([
            sellerId && marketplaceId
              ? restGet(`fnsku_map?seller_id=eq.${sellerId}&marketplace_id=eq.${marketplaceId}&asin=eq.${asin}&select=fnsku,condition,seller_sku&order=updated_at.desc`)
              : Promise.resolve([]),
            // listing_status / ghost_reason / deleted_reason are needed by the
            // panel to keep DEAD SKUs out of the FNSKU label picker. Printing a
            // ghost FNSKU sends physical units to Amazon under a SKU that no
            // longer exists.
            restGet(`inventory?user_id=eq.${uid}&asin=eq.${asin}&select=fnsku,sku,title,image_url,listing_status,ghost_reason,deleted_reason&order=updated_at.desc`),
            // Phase 4 — read from shared active_created_listings view (validation + ghost gate).
            restGet(`active_created_listings?user_id=eq.${uid}&asin=eq.${asin}&select=fnsku,sku,title,image_url&order=updated_at.desc`),
          ]);
          sendResponse({ ok: true, data: { fnskuRows, inventoryRows, createdListingRows } });
          break;
        }
        case "INVSPRNT_GET_FEE_BASIS": {
          // What Amazon will ACTUALLY charge to fulfil one unit.
          //
          // Measured 2026-10-07 over 656 ASINs with both a quote and settled
          // orders: the Product Fees API quote under-states what Amazon bills,
          // and the error grows with the fee -- -$0.08 under $4, +$0.54 in the
          // $6-9 band, +$2.20 above $9, $2,382.83 of fulfilment cost never
          // budgeted. The mechanism is dimensional weight: B09N6FR8MT is
          // 10.9 x 10.6 x 5.0 in at 0.82 lb, quoted $3.52 and billed $6.72 on
          // every one of 27 units, because 578 cubic inches / 139 is 4.11 lb.
          //
          // get_asin_fba_fee_basis returns the billed fee when this ASIN has
          // been sold, and a dimensional-weight cross-check when it has not.
          // One definition, so this panel and the other cannot drift.
          const asinFB = String(msg.asin || "").trim().toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asinFB)) { sendResponse({ ok: false, error: "Invalid ASIN" }); break; }
          const rowsFB = await restRpc("get_asin_fba_fee_basis", {
            p_asin: asinFB,
            p_marketplace: String(msg.marketplace || "US").toUpperCase(),
          });
          sendResponse({ ok: true, data: Array.isArray(rowsFB) ? rowsFB[0] || null : rowsFB });
          break;
        }
        case "INVSPRNT_GET_FEE_CACHE": {
          // asin_fee_cache is maintained by the order sync and the repricer.
          // Reading it costs nothing; asking SP-API for fees again would spend
          // the same pricing quota the repricer runs on.
          const s3 = await ensureFreshSession();
          const uid3 = userIdFromJWT(s3.access_token);
          const asin3 = encodeURIComponent(String(msg.asin || "").toUpperCase());
          const mk3 = encodeURIComponent(String(msg.marketplace || "US").toUpperCase());
          const rows3 = await restGet(
            `asin_fee_cache?user_id=eq.${uid3}&asin=eq.${asin3}&marketplace=eq.${mk3}&select=fba_fee_fixed,referral_rate,is_media&limit=1`,
          );
          sendResponse({ ok: true, data: Array.isArray(rows3) ? rows3[0] || null : null });
          break;
        }
        case "INVSPRNT_GET_ASIN_PROFIT": {
          // The SAME definition the Sales Report uses: get_asin_profit excludes
          // -REFUND rows and zero-priced rows, counts returned units from both
          // records deduplicated, and costs a return as the FBA fee Amazon keeps
          // plus min($5, 20% x referral) -- never the refunded price.
          const asinP = String(msg.asin || "").toUpperCase();
          const today = new Date();
          const start = msg.start || new Date(today.getFullYear(), today.getMonth() - 12, today.getDate())
            .toISOString().slice(0, 10);
          const end = msg.end || today.toISOString().slice(0, 10);
          const rows = await restRpc("get_asin_profit", { p_asin: asinP, p_start: start, p_end: end });
          const row = Array.isArray(rows) ? rows[0] || null : rows;
          sendResponse({ ok: true, data: row, window: { start, end } });
          break;
        }
        case "INVSPRNT_GET_RETURN_STATS": {
          // Return history for the ASIN being priced. asin_return_stats is a
          // security_invoker view over the seller's own sales_orders, so RLS
          // scopes it to them and no extra filter is needed beyond the ASIN.
          const s2 = await ensureFreshSession();
          const uid2 = userIdFromJWT(s2.access_token);
          const asin2 = encodeURIComponent(String(msg.asin || "").toUpperCase());
          const rows2 = await restGet(
            `asin_return_stats?user_id=eq.${uid2}&asin=eq.${asin2}&select=units_sold,units_returned,orders_returned,return_rate_pct,last_return_date,units_sold_12m,units_returned_12m,first_sale_date&limit=1`,
          );
          sendResponse({ ok: true, data: Array.isArray(rows2) ? rows2[0] || null : null });
          break;
        }
        case "INVSPRNT_LOAD_MARKETPLACES": {
          // List user's connected marketplaces (selling regions).
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const data = await restGet(
            `seller_authorizations?user_id=eq.${uid}&select=marketplace_id,is_active&is_active=eq.true`,
          );
          // Also load primary_marketplace_id from profiles
          const prof = await restGet(`profiles?id=eq.${uid}&select=primary_marketplace_id&limit=1`);
          sendResponse({ ok: true, data: { marketplaces: data || [], primary: prof?.[0]?.primary_marketplace_id || null } });
          break;
        }
        case "INVSPRNT_GET_IMAGE_FALLBACK": {
          // Used by the panel before saving a created_listings row when the
          // Amazon DOM/Catalog scrape returned no image. We pull from the
          // user's own inventory and active_created_listings views first
          // (cheap, already-cached images), so Product Library never shows
          // "no image" for an ASIN we've previously seen.
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const asin = encodeURIComponent(String(msg.asin || "").trim().toUpperCase());
          let image_url = null;
          try {
            const inv = await restGet(`inventory?user_id=eq.${uid}&asin=eq.${asin}&select=image_url&order=updated_at.desc.nullslast&limit=1`);
            image_url = inv?.[0]?.image_url || null;
          } catch {}
          if (!image_url) {
            try {
              const cl = await restGet(`created_listings?user_id=eq.${uid}&asin=eq.${asin}&select=image_url&order=updated_at.desc.nullslast&limit=1`);
              image_url = cl?.[0]?.image_url || null;
            } catch {}
          }
          sendResponse({ ok: true, data: { image_url } });
          break;
        }
        case "INVSPRNT_SAVE_LISTING": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          // Phase 4 (C2) — strip client-only hints, derive validation_status.
          // FBA listings actually submitted to Amazon start PENDING_VALIDATION
          // and are promoted to ACTIVE by the FNSKU worker. FBM/local-only
          // (DB-only or FBM channel or FBA-blocked) save as ACTIVE because no
          // Amazon-side validation gate applies.
          const incoming = msg.row || {};
          const fc = String(incoming.fulfillment_channel || "").toUpperCase();
          const createMode = String(incoming._create_mode || "").toLowerCase();
          const fbaBlocked = incoming.fba_blocked === true;
          const isFbaSubmit = fc === "FBA" && createMode === "amazon" && !fbaBlocked;
          const validation_status = isFbaSubmit ? "PENDING_VALIDATION" : "ACTIVE";
          const { _create_mode, fulfillment_channel, ...rest } = incoming;

          // Defense-in-depth image fallback: even if the panel forgot to
          // backfill, try one last lookup so we don't insert image_url=null.
          if (!rest.image_url && rest.asin) {
            try {
              const a = encodeURIComponent(String(rest.asin).trim().toUpperCase());
              const inv = await restGet(`inventory?user_id=eq.${uid}&asin=eq.${a}&select=image_url&order=updated_at.desc.nullslast&limit=1`);
              rest.image_url = inv?.[0]?.image_url || null;
              if (!rest.image_url) {
                const cl = await restGet(`created_listings?user_id=eq.${uid}&asin=eq.${a}&select=image_url&order=updated_at.desc.nullslast&limit=1`);
                rest.image_url = cl?.[0]?.image_url || null;
              }
            } catch {}
          }

          const row = { ...rest, user_id: uid, validation_status };
          const data = await restInsert("created_listings", row);
          sendResponse({ ok: true, data });
          break;
        }
        case "INVSPRNT_SAVE_THINKING": {
          // "Still Thinking to buy" — lightweight save before commit.
          // No cost/units required. Stores ASIN + image + title + supplier
          // URL (auto from current Amazon/source tab or first supplier slot).
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const r = msg.row || {};
          const asin = String(r.asin || "").trim().toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asin)) {
            sendResponse({ ok: false, error: "Invalid ASIN" });
            break;
          }
          let supplier_url = r.supplier_url ? String(r.supplier_url) : null;
          let supplier_domain = null;
          if (supplier_url) {
            try { supplier_domain = new URL(supplier_url).hostname.replace(/^www\./, ""); } catch {}
          }
          const row = {
            user_id: uid,
            asin,
            title: r.title || null,
            image_url: r.image_url || null,
            supplier_url,
            supplier_domain,
            discount_code: r.discount_code ? String(r.discount_code).trim() || null : null,
            marketplace: r.marketplace || null,
            notes: r.notes || null,
            status: "thinking",
          };
          // Re-saving the same ASIN collides with
          // still_thinking_user_asin_active_uidx -- (user_id, asin) WHERE
          // status='thinking'. This used to catch that, re-READ the row and
          // report "already", while the panel said "(refreshed)". Nothing was
          // refreshed. So the common case -- saving an ASIN bare off Amazon,
          // then saving it again from the shop you found -- never recorded the
          // shop, and before the page had a retailer editor there was nowhere
          // to add it either. Now the conflict path PATCHES.
          //
          // It sends only the fields it actually learned. still_thinking_sync_
          // suppliers() MERGES a new supplier_url into supplier_links rather
          // than replacing it, so saving from a second shop adds a candidate
          // instead of overwriting the first -- which is the whole point of
          // parking an ASIN here while you compare sources.
          let data;
          try {
            data = await restInsert("still_thinking_listings", row);
          } catch (e) {
            const msgTxt = String(e?.message || e);
            if (/duplicate|unique|conflict/i.test(msgTxt)) {
              const a = encodeURIComponent(asin);
              const patch = {};
              if (supplier_url) {
                patch.supplier_url = supplier_url;
                patch.supplier_domain = supplier_domain;
                patch.discount_code = row.discount_code;
              }
              // Title and image are worth refreshing on their own: early saves
              // often land before the snapshot has either.
              if (row.title) patch.title = row.title;
              if (row.image_url) patch.image_url = row.image_url;
              try {
                if (Object.keys(patch).length) {
                  data = await restPatch(
                    `still_thinking_listings?user_id=eq.${uid}&asin=eq.${a}&status=eq.thinking`,
                    patch,
                  );
                }
                if (!data) {
                  const cur = await restGet(`still_thinking_listings?user_id=eq.${uid}&asin=eq.${a}&status=eq.thinking&select=*&limit=1`);
                  data = Array.isArray(cur) ? cur[0] : cur;
                }
                sendResponse({
                  ok: true,
                  data,
                  already: true,
                  // The panel words its message from this, so it can no longer
                  // claim a refresh that did not happen.
                  updated: Object.keys(patch).length > 0,
                  supplierAdded: !!supplier_url,
                });
                break;
              } catch { /* fall through to the original error */ }
            }
            throw e;
          }
          sendResponse({ ok: true, data });
          break;
        }
        case "INVSPRNT_FIND_LISTING": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const asinRaw = String(msg.asin || "").trim().toUpperCase();
          const asin = encodeURIComponent(asinRaw);
          // SOURCE OF TRUTH: Inventory Library (public.inventory) only.
          // We intentionally do NOT read from created_listings here — historical
          // purchase rows include long-deleted/renamed SKUs and would surface
          // ghost SKUs that no longer exist on Amazon. The picker must reflect
          // SKUs that currently exist in the user's Amazon inventory.
          const invData = await restGet(
            `inventory?user_id=eq.${uid}&asin=eq.${asin}&select=asin,sku,fnsku,title,image_url,price,my_price,cost,available,reserved,inbound,listing_status,ghost_reason,deleted_reason,updated_at&order=updated_at.desc.nullslast&limit=50`
          );
          const invRows = Array.isArray(invData) ? invData : [];

          // Picker-specific ghost filter: drop only TRUE ghosts (rows that no
          // longer exist on Amazon). We deliberately keep zero-stock SKUs that
          // are still known to Amazon, because the most common reason to open
          // Add Purchase is to log a replenishment for an out-of-stock SKU.
          // Excludes:
          //   - listing_status NOT_IN_CATALOG / DELETED (confirmed gone)
          //   - SKUs starting with "amzn.gr." (Amazon-grading auto-relisted)
          // isGhostInventoryRow() is defined at the top of this file so a test
          // can execute it; see the comment there for why INACTIVE is excluded.

          // De-duplicate by SKU (multi-marketplace can repeat the same SKU);
          // keep the most recently updated row.
          const bySku = new Map();
          for (const r of invRows) {
            if (isGhostInventoryRow(r)) continue;
            const key = String(r.sku || "").toUpperCase();
            if (!key) continue;
            if (!bySku.has(key)) bySku.set(key, r);
          }
          const liveRows = Array.from(bySku.values());

          // Enrich with the user's existing created_listings history for this
          // ASIN so Add Purchase shows the source/supplier, last cost, last
          // units, and date from the Product Library — not just live inventory.
          // IMPORTANT: use created_listings directly, not active_created_listings.
          // The active view intentionally hides ghost/zero-stock rows; Add Purchase
          // must still recover supplier/image/purchase history for exactly those
          // zero-stock replenishment cases.
          let clRows = [];
          try {
            const cl = await restGet(
              `created_listings?user_id=eq.${uid}&asin=eq.${asin}&select=id,sku,title,image_url,price,units,amount,cost,supplier_links,fnsku,date_created,created_at,updated_at,fba_blocked,fba_block_reason&order=created_at.desc.nullslast&limit=50`
            );
            clRows = Array.isArray(cl) ? cl : [];
          } catch (_) { /* non-fatal */ }

          const hasSuppliers = (sl) => Array.isArray(sl) && sl.some((s) => (s?.link || "").trim());
          const pickFirst = (pred) => clRows.find(pred) || null;

          // Sort same-SKU pool by most-recent purchase date first so `latest`
          // is the freshest record (date_created beats created_at).
          const _ts = (r) => {
            const d = r?.date_created || r?.created_at;
            const t = d ? Date.parse(d) : NaN;
            return Number.isFinite(t) ? t : 0;
          };

          const enrichFromCreated = (sku) => {
            const skuU = String(sku || "").toUpperCase();
            const sameSku = clRows.filter((r) => String(r.sku || "").toUpperCase() === skuU);
            const pool = (sameSku.length ? sameSku : clRows).slice().sort((a, b) => _ts(b) - _ts(a));
            const latest = pool[0] || null;
            // Image and supplier may legitimately come from older rows when the
            // latest record is missing them — visual-only fallbacks.
            const supplierRow = pool.find((r) => hasSuppliers(r.supplier_links))
              || pickFirst((r) => hasSuppliers(r.supplier_links));
            const imageRow = pool.find((r) => r.image_url) || pickFirst((r) => r.image_url);
            return { latest, supplierRow, imageRow };
          };

          const toPickerRow = (inv) => {
            const e = enrichFromCreated(inv.sku);
            // CRITICAL: units / COG / total / date MUST all come from the SAME
            // (most recent) created_listings row. Additionally, COG (per-unit
            // `amount`) is RECOMPUTED from that row's cost/units because the
            // stored `amount` column can be a stale legacy value (e.g. row has
            // cost=273 units=20 but stored amount=12.82 from a prior edit;
            // correct per-unit is 273/20 = 13.65).
            const L = e.latest || {};
            const Lunits = Number(L.units) || 0;
            const Lcost = L.cost != null ? Number(L.cost) : null;
            const computedAmount = (Lunits > 0 && Lcost != null && Number.isFinite(Lcost))
              ? Lcost / Lunits
              : (L.amount ?? inv.cost ?? null);
            return {
              id: L.id || null,
              asin: inv.asin,
              sku: inv.sku,
              title: inv.title || L.title || null,
              image_url: inv.image_url || e.imageRow?.image_url || null,
              price: inv.price ?? inv.my_price ?? L.price ?? null,
              units: L.units ?? 0,
              amount: computedAmount,
              cost: L.cost ?? null,
              supplier_links: e.supplierRow?.supplier_links || [],
              // The LATEST row's own column, kept separate from the display
              // fallback above. Add Purchase's supplier editor needs to know
              // whether THIS batch recorded a retailer or merely inherited one
              // from an older purchase -- otherwise "save" would silently copy
              // last month's retailer onto a batch bought somewhere else.
              own_supplier_links: Array.isArray(L.supplier_links) ? L.supplier_links : [],
              fnsku: inv.fnsku || L.fnsku || null,
              date_created: L.date_created || null,
              created_at: L.created_at || null,
              fba_blocked: L.fba_blocked === true,
              fba_block_reason: L.fba_block_reason || null,
              _from_inventory: true,
              listing_status: inv.listing_status || null,
            };
          };

          let allRows = liveRows.map(toPickerRow);

          // If inventory has no live SKU but the user DOES have created_listings
          // history for this ASIN, surface those rows so Add Purchase still
          // works (e.g. listing exists in Product Library but inventory hasn't
          // synced yet, or stock is zero and SKU was filtered).
          if (!allRows.length && clRows.length) {
            const seen = new Set();
            for (const r of clRows) {
              const key = String(r.sku || "").toUpperCase();
              if (!key || seen.has(key)) continue;
              seen.add(key);
              allRows.push({
                id: r.id || null,
                asin: asinRaw,
                sku: r.sku,
                title: r.title || null,
                image_url: r.image_url || null,
                price: r.price ?? null,
                units: Number(r.units) || 0,
                amount: ((Number(r.units) || 0) > 0 && r.cost != null && Number.isFinite(Number(r.cost)))
                  ? Number(r.cost) / Number(r.units)
                  : (r.amount ?? null),
                cost: r.cost ?? null,
                supplier_links: hasSuppliers(r.supplier_links)
                  ? r.supplier_links
                  : (clRows.find((x) => hasSuppliers(x.supplier_links))?.supplier_links || []),
                own_supplier_links: Array.isArray(r.supplier_links) ? r.supplier_links : [],
                fnsku: r.fnsku || null,
                date_created: r.date_created || null,
                created_at: r.created_at || null,
                fba_blocked: r.fba_blocked === true,
                fba_block_reason: r.fba_block_reason || null,
                _from_inventory: false,
                listing_status: null,
              });
            }
          }

          // Sort picker rows by most recent purchase date first so the freshest
          // record is selected/displayed when Add Purchase searches by ASIN.
          // Prefer user-entered date_created, fall back to created_at.
          const _rowTs = (r) => {
            const d = r?.date_created || r?.created_at;
            const t = d ? Date.parse(d) : NaN;
            return Number.isFinite(t) ? t : 0;
          };
          allRows.sort((a, b) => _rowTs(b) - _rowTs(a));

          // ── IS THIS ASIN STILL A LISTING? ───────────────────────────────
          //
          // The ghost rows were being dropped SILENTLY, and that silence was
          // the bug. Reported 2026-11-16 on B0187YMN5K: the ASIN had been
          // deleted in Seller Central, so every inventory row was a ghost and
          // the only survivor was the seller’s own purchase history -- which
          // Add Purchase then displayed like a live listing, and Print Label
          // described as "no valid Amazon FNSKU found… press Find again in a
          // minute once Amazon has synced". There is nothing to sync. Amazon
          // does not issue an FNSKU for a listing that no longer exists.
          //
          // So report the verdict with the rows, rather than leaving each
          // caller to re-derive it from what is missing:
          //
          //   live    at least one inventory SKU that is not a ghost
          //   ghost   inventory rows exist and EVERY one is a ghost
          //   absent  no inventory row at all for this ASIN
          //
          // "absent" deliberately does not claim deletion: it says what we can
          // see, which is nothing. Deleted-and-purged, never-listed and
          // never-synced are indistinguishable from here, and guessing between
          // them would put a false certainty in front of the seller.
          const presence = listingPresenceVerdict(asinRaw, invRows, liveRows, clRows);

          const row = allRows[0] ? { ...allRows[0], _allRows: allRows, _presence: presence } : null;
          // Carried OUTSIDE data as well, because data is null when the ASIN has
          // no live SKU and no purchase history -- the case where the verdict
          // matters most.
          sendResponse({ ok: true, data: row, presence });
          break;
        }
        case "INVSPRNT_SEARCH_BY_SUPPLIER": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const query = String(msg.query || "").trim().toLowerCase();
          if (!query) { sendResponse({ ok: true, data: [] }); break; }
          // Fetch user's listings (most recent first) and filter client-side on
          // supplier_links because Postgres jsonb substring matching is not
          // exposed cleanly through PostgREST.
          const PAGE = 1000;
          const MAX_PAGES = 5; // up to 5000 rows
          const all = [];
          for (let p = 0; p < MAX_PAGES; p++) {
            const from = p * PAGE;
            const to = from + PAGE - 1;
            let urlSession = await ensureFreshSession();
            // Supplier search is historical purchase lookup; do not use
            // active_created_listings because it hides zero-stock/ghost rows that
            // still contain the user's supplier purchase source.
            const url = `${CFG.SUPABASE_URL}/rest/v1/created_listings?user_id=eq.${uid}&select=id,asin,sku,title,image_url,price,units,amount,cost,supplier_links,fnsku,date_created,created_at,fba_blocked,fba_block_reason&order=created_at.desc&supplier_links=not.is.null`;
            const headers = {
              apikey: CFG.SUPABASE_ANON_KEY,
              Authorization: `Bearer ${urlSession.access_token}`,
              Range: `${from}-${to}`,
              "Range-Unit": "items",
            };
            let res = await fetch(url, { headers });
            if (res.status === 401) {
              urlSession = await refreshToken();
              headers.Authorization = `Bearer ${urlSession.access_token}`;
              res = await fetch(url, { headers });
            }
            if (!res.ok) break;
            const text = await res.text();
            let rows; try { rows = text ? JSON.parse(text) : []; } catch { rows = []; }
            if (!Array.isArray(rows) || !rows.length) break;
            all.push(...rows);
            if (rows.length < PAGE) break;
          }
          const matches = all.filter((r) => {
            const links = Array.isArray(r.supplier_links) ? r.supplier_links : [];
            for (const l of links) {
              const link = String(l?.link || "").toLowerCase();
              const code = String(l?.discount_code || "").toLowerCase();
              if (link.includes(query) || code.includes(query)) return true;
            }
            return false;
          });
          // Cap response payload to a sane size
          sendResponse({ ok: true, data: matches.slice(0, 100) });
          break;
        }
        case "INVSPRNT_SEARCH_BY_TITLE": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const query = String(msg.query || "").trim();
          if (!query) { sendResponse({ ok: true, data: [] }); break; }
          // Use PostgREST ilike for fuzzy title matching. % wildcards on both sides.
          const pattern = encodeURIComponent(`*${query.replace(/[*%]/g, " ")}*`);
          // Title search is also a purchase-history lookup, so read the base
          // table to recover suppliers/images even when inventory is zero.
          const data = await restGet(
            `created_listings?user_id=eq.${uid}&title=ilike.${pattern}&select=id,asin,sku,title,image_url,price,units,amount,cost,supplier_links,fnsku,date_created,created_at,fba_blocked,fba_block_reason&order=created_at.desc&limit=100`
          );
          sendResponse({ ok: true, data: Array.isArray(data) ? data : [] });
          break;
        }
        case "INVSPRNT_ADD_PURCHASE": {
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const src = msg.source || {};
          const totalCost = Number(msg.totalCost) || 0;
          const units = Math.max(1, Number(msg.units) || 1);
          // HARD CONTRACT — Add Purchase MUST preserve the picked SKU exactly.
          // We never fabricate / generate / mutate a SKU here, and we never
          // upsert or merge into an existing row. Every Add Purchase click
          // creates a brand-new created_listings record carrying the same SKU
          // as the inventory/listing the user picked.
          const sku = String(src.sku || "").trim();
          if (!sku) {
            sendResponse({ ok: false, error: "Missing SKU on picked listing — refusing to fabricate one. Pick a SKU from the picker." });
            break;
          }
          if (!src.asin) {
            sendResponse({ ok: false, error: "Missing ASIN on picked listing." });
            break;
          }
          const today = new Date();
          const yyyymmdd = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
          const row = {
            user_id: uid,
            asin: src.asin,
            sku, // verbatim — same SKU as the source listing, every time
            fnsku: src.fnsku ?? null,
            title: src.title ?? null,
            image_url: src.image_url ?? null,
            price: src.price ?? null,
            cost: totalCost,
            amount: totalCost / units,
            units,
            // The retailer this batch was bought from, as typed on the panel.
            // It used to copy `src.supplier_links` unconditionally, which meant
            // every replenishment inherited the FIRST purchase's retailer and
            // there was no way to say "this one came from somewhere else" --
            // the panel had no field for it at all. An explicit empty array
            // from the panel is respected; only an absent key falls back.
            supplier_links: Array.isArray(msg.supplierLinks)
              ? normalizeSupplierLinks(msg.supplierLinks)
              : (Array.isArray(src.supplier_links) ? src.supplier_links : []),
            date_created: yyyymmdd,
            fba_blocked: msg.fbaBlocked === true,
            fba_block_reason: msg.fbaBlocked === true ? (msg.fbaBlockReason || "manufacturer_barcode_or_invalid_fnsku") : null,
            // Phase 4 — Add Purchase rows reference an existing inventory SKU,
            // so they bypass the PENDING_VALIDATION gate (no Amazon-side create).
            validation_status: "ACTIVE",
          };
          // restInsert is a plain POST (no upsert / no on-conflict) — every
          // call creates a new row. Two purchases for the same SKU produce
          // two separate created_listings records; they are NEVER merged.
          const data = await restInsert("created_listings", row);
          sendResponse({ ok: true, data });
          break;
        }
        case "INVSPRNT_UPDATE_LISTING": {
          // Mirrors src/components/listings/EditListingDialog.tsx save contract:
          //   cost = Total Cost, units = Units, amount = per-unit COG,
          //   supplier_links = normalized array. RLS scopes update to user_id.
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const id = String(msg.id || "").trim();
          const patch = msg.patch || {};
          if (!id) { sendResponse({ ok: false, error: "Missing listing id" }); break; }
          const allowed = {};
          if (patch.cost != null) allowed.cost = Number(patch.cost);
          if (patch.units != null) allowed.units = Number(patch.units);
          if (patch.amount != null) allowed.amount = Number(patch.amount);
          if (Array.isArray(patch.supplier_links)) allowed.supplier_links = normalizeSupplierLinks(patch.supplier_links);
          if (!Object.keys(allowed).length) {
            sendResponse({ ok: false, error: "Nothing to update" });
            break;
          }
          const data = await restPatch(
            `created_listings?id=eq.${encodeURIComponent(id)}&user_id=eq.${uid}`,
            allowed,
          );
          if (!data) { sendResponse({ ok: false, error: "Listing not found or not owned by you" }); break; }
          sendResponse({ ok: true, data });
          break;
        }
        case "INVSPRNT_REPLENISH_FORECAST": {
          // Mirrors src/pages/tools/NeedBuyAgain.tsx + src/lib/replenishment.ts
          // Aggregates a single ASIN's stock + sales velocity and returns the
          // same replenishment breakdown the web "Need to Buy Again" page uses.
          const s = await ensureFreshSession();
          const uid = userIdFromJWT(s.access_token);
          const asinRaw = String(msg.asin || "").trim().toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asinRaw)) {
            sendResponse({ ok: false, error: "Invalid ASIN" });
            break;
          }
          const asin = encodeURIComponent(asinRaw);

          const today = new Date();
          // No client-side cutoffs any more: the windows and their day
          // boundaries are computed server-side in America/Los_Angeles, which
          // is what order_date actually is. Deriving them from the browser's
          // clock put ~23% of rows on the wrong calendar day for anyone not in
          // Pacific time.

          const [invRows, salesWindows, settingsRows, shipItems] = await Promise.all([
            restGet(`inventory?user_id=eq.${uid}&asin=eq.${asin}&select=available,inbound,reserved,listing_status,sku`).catch(() => []),
            // SALES WINDOWS COME FROM THE SERVER, NOT FROM SCANNING ROWS.
            //
            // These two reads used to be:
            //   sales_orders?...&order_date=gte.${cutoff30}&limit=2000
            //   sales_orders?...&order=order_date.asc&limit=5000
            //
            // Both asked for more rows than PostgREST will ever return:
            // db-max-rows is 1000 here and `limit` can only LOWER that cap, not
            // raise it. The second one was worse -- sorted ASCENDING, so the
            // 1,000 rows it kept were the OLDEST orders and every recent sale
            // was cut off. On a listing whose lifetime orders exceed the cap
            // the panel showed 7d and 30d as ZERO with a small non-zero 90d,
            // while Seller Central showed a normal week -- the exact shape of
            // keeping the 1,000 OLDEST rows. Verified against the aggregate
            // 2026-11-22: all three windows were substantially non-zero.
            //
            // One aggregate instead: bounded work whatever the volume, a single
            // jsonb value with no row count to cap, and the SAME sales
            // definition as the Repricer page's get_repricer_asin_sales_json,
            // so the two screens cannot disagree. STABLE, so GET works and
            // restGet needs no change.
            // `asin` is already encodeURIComponent(asinRaw) from above -- encoding it
            // again would send B0G4BQ42W3 intact but mangle anything needing escapes.
            restGet(`rpc/get_asin_sales_windows_json?p_asin=${asin}`)
              .catch(() => null),
            restGet(`reorder_planning_settings?user_id=eq.${uid}&select=coverage_days,supplier_lead_time_days,prep_days,shipping_to_amazon_days,amazon_receiving_days,safety_percent&limit=1`).catch(() => []),
            // WHICH SHIPMENTS OF THIS ASIN WERE RECEIVED. Needed for the
            // Reserved rule above, and NOT available from the inventory row --
            // the web page builds it from fba_shipment_items joined to
            // fba_shipments, so the extension has to read the same two tables.
            // quantity_received > 0 matches the web query: a shipment line that
            // received nothing is not evidence of a receipt.
            restGet(`fba_shipment_items?user_id=eq.${uid}&asin=eq.${asin}&quantity_received=gt.0&select=shipment_id&limit=500`).catch(() => []),
          ]);

          // The received date of the newest of those shipments. A SECOND round
          // trip, because the ids are not known until the query above returns --
          // and skipped entirely when the ASIN has no received shipment lines,
          // which is the common case for something never sent to FBA.
          let daysSinceLastReceived = null;
          try {
            const ids = [...new Set((Array.isArray(shipItems) ? shipItems : [])
              .map((r) => r && r.shipment_id).filter(Boolean))];
            if (ids.length) {
              const inList = ids.map((x) => `"${String(x).replace(/"/g, "")}"`).join(",");
              const shipRows = await restGet(
                `fba_shipments?user_id=eq.${uid}&shipment_id=in.(${encodeURIComponent(inList)})`
                + `&received_date=not.is.null&select=received_date&order=received_date.desc&limit=1`
              ).catch(() => []);
              const newest = Array.isArray(shipRows) && shipRows[0] && shipRows[0].received_date;
              // NOT the daysSince helper below: that is a const arrow declared
              // later in this block, so calling it here is a temporal-dead-zone
              // ReferenceError -- which would have thrown on every ASIN that HAS
              // a received shipment, i.e. exactly the ones this rule is for.
              if (newest) {
                const ms = today.getTime() - new Date(newest).getTime();
                daysSinceLastReceived = Math.max(0, Math.floor(ms / 86400000));
              }
            }
          } catch (_) {
            // A failed lookup leaves it null, which KEEPS Reserved -- the same
            // answer as "no shipment found". Failing the other way would cut 23
            // units off a forecast because one query timed out.
            daysSinceLastReceived = null;
          }

          // Settings (with defaults matching NeedBuyAgain)
          const cfgRow = (Array.isArray(settingsRows) && settingsRows[0]) || {};
          const cfg = {
            coverage_days: Number(cfgRow.coverage_days ?? 30),
            supplier_lead_time_days: Number(cfgRow.supplier_lead_time_days ?? 0),
            prep_days: Number(cfgRow.prep_days ?? 0),
            shipping_to_amazon_days: Number(cfgRow.shipping_to_amazon_days ?? 0),
            amazon_receiving_days: Number(cfgRow.amazon_receiving_days ?? 0),
            safety_percent: Number(cfgRow.safety_percent ?? 10),
          };

          // Aggregate stock across all live SKUs for this ASIN (skip ghost rows)
          let available = 0, inbound = 0, reserved = 0;
          for (const r of Array.isArray(invRows) ? invRows : []) {
            const ls = String(r.listing_status || "").toUpperCase();
            if (ls === "NOT_IN_CATALOG" || ls === "DELETED") continue;
            if (String(r.sku || "").toLowerCase().startsWith("amzn.gr.")) continue;
            available += Number(r.available) || 0;
            inbound += Number(r.inbound) || 0;
            reserved += Number(r.reserved) || 0;
          }

          // Sales aggregation -- read straight off the envelope.
          //
          // NOTE on the previous shape: flipping that ascending sort to
          // descending would have fixed the 7/30/90 display and silently broken
          // the historical rate, because `earliestAll` was `all[0].order_date`
          // -- correct only while the sort is ascending. Under desc it becomes
          // the NEWEST order, historicalDays collapses toward 1, and the
          // fallback rate goes wildly high. The aggregate removes the ordering
          // question altogether: min() and max() do not care.
          const daysSince = (dateStr) => {
            if (!dateStr) return 30;
            const ms = today.getTime() - new Date(dateStr).getTime();
            return Math.max(1, Math.ceil(ms / 86400000));
          };
          const win = readSalesWindows(salesWindows);
          const recentUnits = win.units30d;
          const actualSalesPeriod = win.firstOrderDate30d
            ? Math.min(30, daysSince(win.firstOrderDate30d))
            : 30;
          const historicalUnits = win.unitsLifetime;
          const historicalDays = win.firstOrderDate ? daysSince(win.firstOrderDate) : null;
          const d7 = win.units7d, d30 = win.units30d, d90 = win.units90d;

          // computeReplenishmentBreakdown — verbatim port of src/lib/replenishment.ts
          let ads = 0;
          if (recentUnits > 0 && actualSalesPeriod > 0) {
            ads = recentUnits / actualSalesPeriod;
          } else if (historicalUnits > 0 && historicalDays && historicalDays > 0) {
            ads = historicalUnits / historicalDays;
          }
          const totalLeadTimeDays =
            (cfg.supplier_lead_time_days || 0) +
            (cfg.prep_days || 0) +
            (cfg.shipping_to_amazon_days || 0) +
            (cfg.amazon_receiving_days || 0);
          const planningDays = (cfg.coverage_days || 0) + totalLeadTimeDays;
          const pipe = repPipelineStock(available, inbound, reserved, daysSinceLastReceived);
          const totalPipelineStock = pipe.totalPipelineStock;
          const forecastDemand = ads * planningDays;
          const safetyStock = forecastDemand * ((cfg.safety_percent || 0) / 100);
          let replenishQty = 0;
          if (ads > 0) {
            const raw = forecastDemand + safetyStock - totalPipelineStock;
            replenishQty = raw <= 0 ? 0 : Math.round(raw);
          }
          const daysUntilStockout = ads > 0 ? totalPipelineStock / ads : null;
          let riskLevel = "unknown", riskLabel = "Unknown";
          if (ads > 0 && daysUntilStockout !== null) {
            if (daysUntilStockout <= totalLeadTimeDays) { riskLevel = "critical"; riskLabel = "Critical — Buy Now"; }
            else if (daysUntilStockout <= totalLeadTimeDays + 7) { riskLevel = "high"; riskLabel = "High"; }
            else if (daysUntilStockout <= totalLeadTimeDays + 14) { riskLevel = "medium"; riskLabel = "Medium"; }
            else { riskLevel = "low"; riskLabel = "Low"; }
          }

          sendResponse({
            ok: true,
            data: {
              asin: asinRaw,
              available, inbound, reserved,
              sales7d: d7, sales30d: d30, sales90d: d90,
              ads, totalLeadTimeDays, planningDays, forecastDemand, safetyStock,
              // WHICH SALES DROVE THE RATE. The panel showed 7d/30d/90d side by
              // side as though they were equals, and only one of them feeds the
              // forecast -- on a product whose 90-day rate is double its 30-day
              // rate, that is the difference between 38 and 71 days of cover.
              //
              // adsDays is the ACTUAL span used, not a flat 30: the window is
              // measured from the first order inside it, so an ASIN whose only
              // recent sale was 9 days ago is averaged over 9 days.
              adsSource: recentUnits > 0 ? 'recent' : (historicalUnits > 0 ? 'all-time' : 'none'),
              adsDays: recentUnits > 0 ? actualSalesPeriod : (historicalUnits > 0 ? historicalDays : null),
              reservedExcluded: pipe.reservedExcluded,
              effectiveReserved: pipe.effectiveReserved,
              daysSinceLastReceived,
              totalPipelineStock, daysUntilStockout, replenishQty, riskLevel, riskLabel,
              settings: cfg,
              hasSettings: !!(Array.isArray(settingsRows) && settingsRows[0]),
            },
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// ── Heal open tabs after an install or update (2026-09-18) ───────────────
//
// Updating or reloading the extension leaves the OLD content scripts running
// in every Amazon / InventorySprint tab that was already open, cut off from
// the new extension: their chrome.* calls throw "Extension context
// invalidated". On Amazon that broke the analyser panel (reported on its
// sign-in form); on inventorysprint.com it silently dropped the website's
// login hand-off, so signing in there never reached the extension.
//
// Re-inject the manifest's content scripts into those tabs. A reloaded
// extension gets a fresh isolated world, so the new copies do not collide
// with the old ones; content.js then removes the old panel and the old copy
// retires itself. Only for install/update -- on a Chrome update the scripts
// are still alive and must not be doubled. Failures are per tab (discarded
// tabs, chrome:// pages, tabs mid-navigation) and never block the rest.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  (async () => {
    const scripts = chrome.runtime.getManifest().content_scripts || [];
    let injected = 0, failed = 0;
    for (const cs of scripts) {
      let tabs = [];
      try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
      for (const tab of tabs) {
        if (!tab.id || tab.discarded || tab.status === "unloaded") continue;
        try {
          if (cs.css?.length) await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: cs.css });
          if (cs.js?.length) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js });
          injected++;
        } catch (e) {
          failed++;
          console.debug("[InvSPRNT-create] re-inject skipped for tab", tab.id, e?.message || e);
        }
      }
    }
    console.log(`[InvSPRNT-create] ${reason}: re-injected content scripts into ${injected} open tab(s), ${failed} skipped`);
  })();
});
