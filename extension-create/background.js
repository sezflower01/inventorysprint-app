// Service worker — token storage, refresh, edge-function proxy, REST insert.
// Identical contract to the Analyzer extension so the same /tools/ext-handoff
// page works without changes.
importScripts("config.js");

const CFG = self.ARBIPRO_CFG;

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
// How long a previously-valid access token is still considered usable as a
// "last-known-good" fallback after its nominal expiry, when the refresh
// endpoint is slow/unreachable. SP-API/edge calls will still get a 401 if the
// token is truly dead, but most of the time gotrue is just slow.
const STALE_TOKEN_GRACE_MS = 10 * 60 * 1000; // 10 min

function logAuth(event, extra) {
  try {
    const tag = "[arbipro-auth]";
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("refresh_timeout"), REFRESH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
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
      logAuth(isAbort ? "refresh_timeout" : "refresh_network_error", String(e?.message || e));
      if (allowStaleFallback && sess.access_token) {
        const ageMs = Date.now() - ((sess.expires_at || 0) * 1000);
        if (ageMs < STALE_TOKEN_GRACE_MS) {
          logAuth("reused_cached_token", { stale_by_ms: Math.max(0, ageMs) });
          return sess; // hand back last-known-good token
        }
      }
      throw new Error("Auth server slow — retrying");
    }
    clearTimeout(timer);
    if (!res.ok) {
      // Distinguish "Supabase says you're really signed out" (400/401 with
      // invalid_grant) from transient 5xx. Only the former clears session.
      let bodyText = "";
      try { bodyText = await res.text(); } catch (_) { /* ignore */ }
      const isHardSignOut =
        (res.status === 400 || res.status === 401) &&
        /invalid[_ ]grant|refresh[_ ]token[_ ]not[_ ]found|expired/i.test(bodyText);
      if (isHardSignOut) {
        logAuth("confirmed_signed_out", { status: res.status });
        await clearSessionExplicit("invalid_grant");
        throw new Error("Not signed in");
      }
      // Transient (504, 5xx, throttle). Reuse cached token if still warm.
      logAuth("refresh_transient_failure", { status: res.status });
      if (allowStaleFallback && sess.access_token) {
        const ageMs = Date.now() - ((sess.expires_at || 0) * 1000);
        if (ageMs < STALE_TOKEN_GRACE_MS) {
          logAuth("reused_cached_token", { stale_by_ms: Math.max(0, ageMs) });
          return sess;
        }
      }
      throw new Error("Auth server slow — retrying");
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



function userIdFromJWT(access_token) {
  try { return JSON.parse(atob(access_token.split(".")[1])).sub; } catch { return null; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "ARBIPRO_SET_SESSION":
          await setSession(msg.session); sendResponse({ ok: true }); break;
        case "ARBIPRO_GET_SESSION": {
          const session = await getSession();
          const signed_out = await isSignedOutExplicit();
          sendResponse({ ok: true, session, signed_out });
          break;
        }
        case "ARBIPRO_SIGN_OUT":
          await clearSessionExplicit("popup_signout");
          sendResponse({ ok: true });
          break;
        case "ARBIPRO_SIGN_IN_PASSWORD": {
          await signInWithPassword(msg.email, msg.password);
          sendResponse({ ok: true });
          break;
        }
        case "ARBIPRO_EXPLICIT_SIGN_OUT":
          await clearSessionExplicit("web_app_logout");
          sendResponse({ ok: true });
          break;
        case "ARBIPRO_INVOKE": {
          const data = await invoke(msg.fn, msg.body);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_LOOKUP_FNSKU": {
          const asin = encodeURIComponent(msg.asin);
          const data = await restGet(`fnsku_map?asin=eq.${asin}&select=fnsku,condition&limit=1`);
          sendResponse({ ok: true, data: Array.isArray(data) ? data[0] || null : null });
          break;
        }
        case "ARBIPRO_GET_PRIMARY_SELLER_AUTH": {
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
        case "ARBIPRO_LOAD_FNSKU_SOURCES": {
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
        case "ARBIPRO_LOAD_MARKETPLACES": {
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
        case "ARBIPRO_GET_IMAGE_FALLBACK": {
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
        case "ARBIPRO_SAVE_LISTING": {
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
        case "ARBIPRO_SAVE_THINKING": {
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
          // Upsert on (user_id, asin) where status='thinking' — re-saving the
          // same ASIN refreshes supplier/title/image instead of erroring.
          let data;
          try {
            data = await restInsert("still_thinking_listings", row);
          } catch (e) {
            const msgTxt = String(e?.message || e);
            if (/duplicate|unique|conflict/i.test(msgTxt)) {
              // Already exists — fetch current row and report ok.
              try {
                const a = encodeURIComponent(asin);
                const cur = await restGet(`still_thinking_listings?user_id=eq.${uid}&asin=eq.${a}&status=eq.thinking&select=*&limit=1`);
                data = Array.isArray(cur) ? cur[0] : cur;
                sendResponse({ ok: true, data, already: true });
                break;
              } catch { /* fall through */ }
            }
            throw e;
          }
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_FIND_LISTING": {
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
            `inventory?user_id=eq.${uid}&asin=eq.${asin}&select=asin,sku,fnsku,title,image_url,price,my_price,cost,available,reserved,inbound,listing_status,updated_at&order=updated_at.desc.nullslast&limit=50`
          );
          const invRows = Array.isArray(invData) ? invData : [];

          // Picker-specific ghost filter: drop only TRUE ghosts (rows that no
          // longer exist on Amazon). We deliberately keep zero-stock SKUs that
          // are still known to Amazon, because the most common reason to open
          // Add Purchase is to log a replenishment for an out-of-stock SKU.
          // Excludes:
          //   - listing_status NOT_IN_CATALOG / DELETED (confirmed gone)
          //   - SKUs starting with "amzn.gr." (Amazon-grading auto-relisted)
          const isGhost = (r) => {
            if (!r) return true;
            const ls = String(r.listing_status || "").toUpperCase();
            if (ls === "NOT_IN_CATALOG" || ls === "DELETED") return true;
            if (String(r.sku || "").toLowerCase().startsWith("amzn.gr.")) return true;
            return false;
          };

          // De-duplicate by SKU (multi-marketplace can repeat the same SKU);
          // keep the most recently updated row.
          const bySku = new Map();
          for (const r of invRows) {
            if (isGhost(r)) continue;
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

          const row = allRows[0] ? { ...allRows[0], _allRows: allRows } : null;
          sendResponse({ ok: true, data: row });
          break;
        }
        case "ARBIPRO_SEARCH_BY_SUPPLIER": {
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
        case "ARBIPRO_SEARCH_BY_TITLE": {
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
        case "ARBIPRO_ADD_PURCHASE": {
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
            supplier_links: Array.isArray(src.supplier_links) ? src.supplier_links : [],
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
        case "ARBIPRO_UPDATE_LISTING": {
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
          if (Array.isArray(patch.supplier_links)) allowed.supplier_links = patch.supplier_links;
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
        case "ARBIPRO_REPLENISH_FORECAST": {
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
          const cutoff30Date = new Date(today.getTime() - 30 * 86400000);
          const cutoff30 = cutoff30Date.toISOString().slice(0, 10);

          const [invRows, recentSales, allSales, settingsRows] = await Promise.all([
            restGet(`inventory?user_id=eq.${uid}&asin=eq.${asin}&select=available,inbound,reserved,listing_status,sku`).catch(() => []),
            restGet(`sales_orders?user_id=eq.${uid}&asin=eq.${asin}&order_date=gte.${cutoff30}&select=quantity,order_date&limit=2000`).catch(() => []),
            restGet(`sales_orders?user_id=eq.${uid}&asin=eq.${asin}&select=quantity,order_date&order=order_date.asc&limit=5000`).catch(() => []),
            restGet(`reorder_planning_settings?user_id=eq.${uid}&select=coverage_days,supplier_lead_time_days,prep_days,shipping_to_amazon_days,amazon_receiving_days,safety_percent&limit=1`).catch(() => []),
          ]);

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

          // Sales aggregation
          const recent = Array.isArray(recentSales) ? recentSales : [];
          const recentUnits = recent.reduce((s, r) => s + (Number(r.quantity) || 1), 0);
          let earliestRecent = null;
          for (const r of recent) {
            if (!r.order_date) continue;
            if (!earliestRecent || r.order_date < earliestRecent) earliestRecent = r.order_date;
          }
          const daysSince = (dateStr) => {
            if (!dateStr) return 30;
            const ms = today.getTime() - new Date(dateStr).getTime();
            return Math.max(1, Math.ceil(ms / 86400000));
          };
          const actualSalesPeriod = earliestRecent ? Math.min(30, daysSince(earliestRecent)) : 30;

          const all = Array.isArray(allSales) ? allSales : [];
          const historicalUnits = all.reduce((s, r) => s + (Number(r.quantity) || 1), 0);
          const earliestAll = all.length ? all[0].order_date : null;
          const historicalDays = earliestAll ? daysSince(earliestAll) : null;

          // Sales buckets (7/30/90)
          const cutoff7 = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
          const cutoff90 = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
          let d7 = 0, d30 = 0, d90 = 0;
          for (const r of all) {
            const q = Number(r.quantity) || 1;
            const od = r.order_date || "";
            if (od >= cutoff7) d7 += q;
            if (od >= cutoff30) d30 += q;
            if (od >= cutoff90) d90 += q;
          }

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
          const totalPipelineStock = available + inbound + reserved;
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
