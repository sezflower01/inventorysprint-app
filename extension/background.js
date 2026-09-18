// Service worker — token storage, refresh, and edge-function proxy.
importScripts("config.js");

const CFG = self.ARBIPRO_CFG;

async function getSession() {
  const { arbipro_session } = await chrome.storage.local.get("arbipro_session");
  return arbipro_session || null;
}

async function setSession(s) {
  // A successful session set means we are NOT signed out anymore.
  await chrome.storage.local.set({ arbipro_session: s });
  await chrome.storage.local.remove("arbipro_signed_out");
}

// Explicit logout — only called when:
//   1. The user clicks "Log out" in InventorySprint web app (LOGOUT broadcast), or
//   2. Supabase confirms invalid_grant / refresh_token_not_found.
// Sets a sticky flag so panels can show "Please log in to InventorySprint again"
// instead of silently retrying with no token.
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
const STALE_TOKEN_GRACE_MS = 10 * 60 * 1000; // 10 min last-known-good window

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
      const isAbort = e?.name === "AbortError" || String(e?.message || "").includes("abort");
      logAuth(isAbort ? "refresh_timeout" : "refresh_network_error", String(e?.message || e));
      if (allowStaleFallback && sess.access_token) {
        const ageMs = Date.now() - ((sess.expires_at || 0) * 1000);
        if (ageMs < STALE_TOKEN_GRACE_MS) {
          logAuth("reused_cached_token", { stale_by_ms: Math.max(0, ageMs) });
          return sess;
        }
      }
      throw new Error("Auth server slow — retrying");
    }
    clearTimeout(timer);
    if (!res.ok) {
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
// of refresh_token. The resulting session is stored and kept alive
// indefinitely by the existing refreshToken()/ensureFreshSession() machinery
// above, exactly like a session obtained via the web app handoff — the user
// stays signed in until they explicitly sign out.
async function signInWithPassword(email, password) {
  logAuth("password_signin_started");
  const res = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.message || "Invalid email or password";
    logAuth("password_signin_failed", { status: res.status });
    throw new Error(msg);
  }
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  await setSession(next);
  logAuth("password_signin_success");
  return next;
}

async function ensureFreshSession() {
  let s = await getSession();
  if (!s) throw new Error("Not signed in");
  if (s.expires_at && s.expires_at - Math.floor(Date.now() / 1000) < 60) {
    try {
      s = await refreshToken();
    } catch (e) {
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
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// PostgREST GET with auto-refresh on 401.
// Cloudflare-in-front-of-Supabase transient error codes — worth a retry,
// unlike a real 4xx/5xx from PostgREST itself.
const RETRYABLE_STATUS = new Set([522, 523, 524]);
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function restGet(path) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
  };
  let res = await fetchWithRetry(url, { headers });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetchWithRetry(url, { headers });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

// PostgREST upsert with conflict target.
async function restUpsert(table, row, onConflict) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation,resolution=merge-duplicates",
  };
  let res = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(row) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return Array.isArray(data) ? data[0] : data;
}

// PostgREST insert with auto-refresh on 401. RLS ensures user_id matches caller.
async function restInsert(table, row) {
  let s = await ensureFreshSession();
  const url = `${CFG.SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${s.access_token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  let res = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (res.status === 401) {
    s = await refreshToken();
    headers.Authorization = `Bearer ${s.access_token}`;
    res = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(row) });
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return Array.isArray(data) ? data[0] : data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "ARBIPRO_SET_SESSION":
          await setSession(msg.session);
          sendResponse({ ok: true });
          break;
        case "ARBIPRO_GET_SESSION": {
          const session = await getSession();
          const signed_out = await isSignedOutExplicit();
          sendResponse({ ok: true, session, signed_out });
          break;
        }
        case "ARBIPRO_SIGN_OUT":
          // Local-only sign out from inside the extension popup.
          await clearSessionExplicit("popup_signout");
          sendResponse({ ok: true });
          break;
        case "ARBIPRO_SIGN_IN_PASSWORD": {
          await signInWithPassword(msg.email, msg.password);
          sendResponse({ ok: true });
          break;
        }
        case "ARBIPRO_EXPLICIT_SIGN_OUT":
          // Broadcast from inventorysprint.com web app — user clicked Log out.
          await clearSessionExplicit("web_app_logout");
          sendResponse({ ok: true });
          break;
        case "ARBIPRO_INVOKE": {
          const data = await invoke(msg.fn, msg.body);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_SAVE_SCAN": {
          // Inject user_id from JWT so RLS passes.
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const row = { ...msg.row, user_id: payload.sub };
          const data = await restInsert("mobile_scan_history", row);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_SAVE_COST": {
          // Persist cost-per-ASIN via SECURITY DEFINER RPC. Avoids the
          // broken upsert path (duplicate rows + barcode unique-index conflict
          // with historical scan rows) that silently dropped writes.
          let s = await ensureFreshSession();
          const r = msg.row || {};
          const url = `${CFG.SUPABASE_URL}/rest/v1/rpc/save_mobile_scan_cost_memory`;
          const headers = {
            apikey: CFG.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${s.access_token}`,
            "Content-Type": "application/json",
          };
          const body = JSON.stringify({
            _asin: r.asin,
            _barcode: r.barcode || null,
            _total_cost: r.total_cost,
            _units: r.units,
            _sale_price_override: r.sale_price_override,
          });
          let res = await fetch(url, { method: "POST", headers, body });
          if (res.status === 401) {
            s = await refreshToken();
            headers.Authorization = `Bearer ${s.access_token}`;
            res = await fetch(url, { method: "POST", headers, body });
          }
          const text = await res.text();
          let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
          if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_LOAD_COST": {
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const asin = encodeURIComponent(msg.asin);
          const data = await restGet(
            `mobile_scan_cost_memory?user_id=eq.${payload.sub}&asin=eq.${asin}&select=total_cost,units,sale_price_override&limit=1`,
          );
          sendResponse({ ok: true, data: Array.isArray(data) ? data[0] || null : null });
          break;
        }
        case "ARBIPRO_CHECK_ADMIN": {
          // Gates admin-only panel affordances (e.g. the decision-JSON debug
          // button). Same RLS-scoped self-read the web app's admin settings
          // already relies on — a user can read their own user_roles row.
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const data = await restGet(
            `user_roles?user_id=eq.${payload.sub}&role=eq.admin&select=role&limit=1`,
          );
          sendResponse({ ok: true, isAdmin: Array.isArray(data) && data.length > 0 });
          break;
        }
        case "ARBIPRO_LOG_DECISION": {
          // Inject user_id from JWT so RLS passes; mirrors web ProductAnalyzer schema.
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const row = { ...msg.row, user_id: payload.sub, source: "extension" };
          const data = await restInsert("analyzer_decision_log", row);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_RECORD_DECISION_ACTION": {
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const row = { ...msg.row, user_id: payload.sub };
          const data = await restInsert("analyzer_decision_action", row);
          sendResponse({ ok: true, data });
          break;
        }
        case "ARBIPRO_EXPORT_DECISION_MEMORY": {
          // Pulls the caller's full decision memory (RLS restricts to user_id).
          // Paginates in 1000-row chunks since PostgREST defaults cap at 1000.
          const s = await ensureFreshSession();
          const payload = JSON.parse(atob(s.access_token.split(".")[1]));
          const uid = payload.sub;
          async function fetchAll(table, selectCols) {
            const out = [];
            let from = 0; const page = 1000;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const path = `${table}?user_id=eq.${uid}&select=${selectCols}&order=created_at.desc&limit=${page}&offset=${from}`;
              const chunk = await restGet(path);
              const arr = Array.isArray(chunk) ? chunk : [];
              out.push(...arr);
              if (arr.length < page) break;
              from += page;
              if (out.length >= 50000) break; // safety cap
            }
            return out;
          }
          const [logs, actions] = await Promise.all([
            fetchAll("analyzer_decision_log", "*"),
            fetchAll("analyzer_decision_action", "*"),
          ]);
          sendResponse({ ok: true, data: { logs, actions, user_id: uid, exported_at: new Date().toISOString() } });
          break;
        }
        case "ARBIPRO_LOAD_FX": {
          // Load USD->X conversion rates so the panel can convert a USD
          // source cost into the marketplace currency for accurate ROI.
          // fx_rates is readable by any authenticated user (public SELECT).
          const data = await restGet(`fx_rates?base=eq.USD&select=quote,rate,as_of`);
          const map = {};
          (Array.isArray(data) ? data : []).forEach((r) => {
            if (r?.quote && Number.isFinite(Number(r.rate))) map[r.quote] = Number(r.rate);
          });
          sendResponse({ ok: true, data: map });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
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
          console.debug("[arbipro] re-inject skipped for tab", tab.id, e?.message || e);
        }
      }
    }
    console.log(`[arbipro] ${reason}: re-injected content scripts into ${injected} open tab(s), ${failed} skipped`);
  })();
});