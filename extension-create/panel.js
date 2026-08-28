// Panel logic — mirrors src/pages/tools/CreateListing.tsx
const APP_URL = "https://inventorysprint.com";

const MARKETPLACES = {
  US: { id: "ATVPDKIKX0DER", name: "United States", flag: "🇺🇸", currency: "USD", symbol: "$", domain: "amazon.com" },
  CA: { id: "A2EUQ1WTGCTBG2", name: "Canada", flag: "🇨🇦", currency: "CAD", symbol: "C$", domain: "amazon.ca" },
  MX: { id: "A1AM78C64UM0Y8", name: "Mexico", flag: "🇲🇽", currency: "MXN", symbol: "$", domain: "amazon.com.mx" },
  BR: { id: "A2Q3Y263D00KWC", name: "Brazil", flag: "🇧🇷", currency: "BRL", symbol: "R$", domain: "amazon.com.br" },
  GB: { id: "A1F83G8C2ARO7P", name: "United Kingdom", flag: "🇬🇧", currency: "GBP", symbol: "£", domain: "amazon.co.uk" },
  DE: { id: "A1PA6795UKMFR9", name: "Germany", flag: "🇩🇪", currency: "EUR", symbol: "€", domain: "amazon.de" },
  FR: { id: "A13V1IB3VIYZZH", name: "France", flag: "🇫🇷", currency: "EUR", symbol: "€", domain: "amazon.fr" },
  IT: { id: "APJ6JRA9NG5V4",  name: "Italy",  flag: "🇮🇹", currency: "EUR", symbol: "€", domain: "amazon.it" },
  ES: { id: "A1RKKUPIHCS9HS", name: "Spain",  flag: "🇪🇸", currency: "EUR", symbol: "€", domain: "amazon.es" },
  JP: { id: "A1VC38T7YXB528", name: "Japan",  flag: "🇯🇵", currency: "JPY", symbol: "¥", domain: "amazon.co.jp" },
};
const VALID_FNSKU_RE = /^X[A-Z0-9]{9}$/;

// Per-marketplace display date format. DB always stores YYYY-MM-DD.
const DATE_FORMAT_BY_MARKET = {
  US: "MDY", MX: "DMY", BR: "DMY", CA: "YMD", GB: "DMY",
  DE: "DMY", FR: "DMY", IT: "DMY", ES: "DMY", JP: "YMD",
};
function formatDateForMarket(isoLike, mkCode) {
  if (!isoLike) return "—";
  const s = String(isoLike).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const [, y, mo, d] = m;
  const fmt = DATE_FORMAT_BY_MARKET[mkCode] || "MDY";
  if (fmt === "DMY") return `${d}/${mo}/${y}`;
  if (fmt === "YMD") return `${y}/${mo}/${d}`;
  return `${mo}/${d}/${y}`;
}

function marketplaceCodeForRow(row = {}) {
  return row.marketplace || row.marketplace_code || state.selectedMarketplace || state.marketplace || "US";
}

async function checkFbaEligibility(asin, row = {}, force = false) {
  const code = marketplaceCodeForRow(row);
  const m = MARKETPLACES[code] || MARKETPLACES.US;
  const condition = row.condition || $("apx-cond")?.value || "new_new";
  const r = await bg("ARBIPRO_INVOKE", {
    fn: "check-fba-listing-eligibility",
    body: { asin, marketplace: code, marketplaceId: m.id, condition, force },
  });
  if (!r?.ok) throw new Error(r?.error || "FBA eligibility check failed");
  return r.data || null;
}

function approvalUrlFor(asin, mkCode) {
  const map = {
    US: "sellercentral.amazon.com", CA: "sellercentral.amazon.ca",
    MX: "sellercentral.amazon.com.mx", BR: "sellercentral.amazon.com.br",
    GB: "sellercentral.amazon.co.uk", DE: "sellercentral.amazon.de",
    FR: "sellercentral.amazon.fr", IT: "sellercentral.amazon.it",
    ES: "sellercentral.amazon.es", JP: "sellercentral.amazon.co.jp",
  };
  const host = map[(mkCode || "US").toUpperCase()] || "sellercentral.amazon.com";
  return `https://${host}/hz/approvalrequest/restrictions/approve?asin=${encodeURIComponent(asin || "")}&itemcondition=new&ref_=xx_addlisting_dnav_xx`;
}

// Only an explicit New-condition restriction should block Create. A warning
// from FBA readiness is not approval-required when Seller Central allows New.
function isUnconfirmedApproval(elig) {
  return marketplaceApprovalStatus() === "approval_required";
}

function marketplaceApprovalStatus() {
  const code = state.selectedMarketplace || state.marketplace || "US";
  const gates = Array.isArray(state.product?.marketplaceGating) ? state.product.marketplaceGating : [];
  const gate = gates.find((g) => String(g.marketplace || "").toUpperCase() === String(code).toUpperCase());
  const status = String(gate?.status || state.product?.gatingStatus || "").toUpperCase();
  if (status === "APPROVED" || status === "ELIGIBLE") return "approved";
  if (status === "APPROVAL_REQUIRED" || status === "NEEDS_APPROVAL" || status === "GATED") return "approval_required";
  if (status === "RESTRICTED" || status === "NOT_ELIGIBLE" || status === "INELIGIBLE") return "restricted";
  return null;
}

function fbaWarningHtml(elig, fallback) {
  const issues = Array.isArray(elig?.blockingIssues) ? elig.blockingIssues : [];
  const lines = issues.length
    ? issues.map((i) => `<div>• <code>[${escapeHtml(i.code || "BLOCKED")}]</code> ${escapeHtml(i.message || "FBA blocked")}</div>`).join("")
    : `<div>• ${escapeHtml(fallback || elig?.fba_block_reason || "Amazon requires an action before this can move through FBA.")}</div>`;
  return `<strong>⛔ FBA action required</strong>
    <div>Amazon returned a real FBA restriction or barcode-mode issue for this ASIN.</div>
    <div style="margin-top:6px">${lines}</div>`;
}

function fbaUnconfirmedHtml(elig, asin, mkCode) {
  const stages = Array.isArray(elig?.stageStatuses) ? elig.stageStatuses : [];
  const sell = stages.find((s) => String(s.stage || "").toLowerCase() === "sellability");
  const reason = sell?.reason || "Amazon returned an approval-required restriction for New condition in this marketplace.";
  const url = approvalUrlFor(asin, mkCode);
  const m = MARKETPLACES[mkCode];
  // Name the marketplace explicitly -- without this, the warning reads as if
  // it could apply to whatever marketplace the user is currently focused on
  // (e.g. the "$X · US" line at the top of the card), when it's actually
  // scoped to whichever marketplace is selected in the Listing Details form.
  const mkLabel = m ? ` in ${m.flag} ${mkCode}` : "";
  return `<strong>⚠️ Approval required for New condition${mkLabel}</strong>
    <div style="margin-top:4px">${escapeHtml(reason)}</div>
    <div style="margin-top:6px"><a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:4px 10px;background:#f59e0b;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Apply for approval →</a></div>`;
}

function normalizeFbaEligibility(elig) {
  if (!elig) return elig;
  const blocking = Array.isArray(elig.blockingIssues) ? elig.blockingIssues : [];
  const onlyFnskuMissing = blocking.length > 0 && blocking.every((i) => String(i.code || "").toUpperCase() === "INVALID_FNSKU");
  if (elig.eligible === false && onlyFnskuMissing) {
    return {
      ...elig,
      eligible: true,
      blockingIssues: [],
      warnings: [...(Array.isArray(elig.warnings) ? elig.warnings : []), ...blocking.map((i) => ({ ...i, severity: "warn" }))],
      fba_block_reason: null,
    };
  }
  return elig;
}

function mergeLocalFnskuSignal(remote, local) {
  const normalizedLocal = normalizeFbaEligibility(local);
  if (!normalizedLocal) return remote;
  if (!remote || normalizedLocal.eligible === false) return normalizedLocal;
  return {
    ...remote,
    warnings: [...(Array.isArray(remote.warnings) ? remote.warnings : []), ...(Array.isArray(normalizedLocal.warnings) ? normalizedLocal.warnings : [])],
    infos: [...(Array.isArray(remote.infos) ? remote.infos : []), ...(Array.isArray(normalizedLocal.infos) ? normalizedLocal.infos : [])],
  };
}

function fbaReadinessHtml(elig) {
  const infos = Array.isArray(elig?.infos) ? elig.infos : [];
  const warnings = Array.isArray(elig?.warnings) ? elig.warnings : [];
  const stages = Array.isArray(elig?.stageStatuses) ? elig.stageStatuses : [];
  const fnskuInfo = [...infos, ...warnings].find((i) => ["FNSKU_PENDING_LISTING_CREATION", "FNSKU_PROPAGATING", "INVALID_FNSKU"].includes(String(i.code || "").toUpperCase()));
  const prep = stages.find((s) => String(s.stage || "").toLowerCase() === "prep" && ["ok", "warn"].includes(String(s.status || "").toLowerCase()));
  const hazmat = stages.find((s) => String(s.stage || "").toLowerCase() === "hazmat" && String(s.status || "").toLowerCase() !== "blocked");
  const lines = [];
  if (fnskuInfo) lines.push(`• ${escapeHtml(fnskuInfo.message || "Amazon assigns the FNSKU after listing creation or after propagation.")}`);
  if (prep?.reason) lines.push(`• Prep: ${escapeHtml(prep.reason)}`);
  if (hazmat?.reason && String(hazmat.status).toLowerCase() === "warn") lines.push(`• Compliance: ${escapeHtml(hazmat.reason)}`);
  if (!lines.length) return "";
  return `<strong>ℹ️ FBA can continue</strong><div>This is not a hard block. Follow Amazon’s questions/prep workflow, then re-check when Amazon finishes assigning the FNSKU.</div><div style="margin-top:6px">${lines.join("<br>")}</div>`;
}

function fbaStatusText(elig) {
  if (!elig) return "";
  if (elig.eligible === false) return "FBA action required before creating on Amazon.";
  if (isUnconfirmedApproval(elig)) return "Approval required for New condition in this marketplace.";
  const info = [...(Array.isArray(elig.infos) ? elig.infos : []), ...(Array.isArray(elig.warnings) ? elig.warnings : [])]
    .find((i) => ["FNSKU_PENDING_LISTING_CREATION", "FNSKU_PROPAGATING", "INVALID_FNSKU"].includes(String(i.code || "").toUpperCase()));
  return info ? "FBA can continue — FNSKU may appear after Amazon creates or updates the listing." : "";
}

function generateSKU() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const r = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${r(3)}-${r(3)}-${r(4)}`;
}

const $ = (id) => document.getElementById(id);
// ⚠️ THREE THINGS THIS HAS TO HANDLE. It previously did none of them, while
// the analyzer panel's own bg() has handled all three for a while.
//
// 1. chrome.runtime.lastError MUST be read inside the callback. If it is not,
//    Chrome logs "Unchecked runtime.lastError" — which chrome://extensions
//    files under Errors, so a routine service-worker hiccup looks like a fault.
//
// 2. chrome.runtime.sendMessage THROWS SYNCHRONOUSLY once the extension context
//    is invalidated — which is exactly what reloading the extension does to an
//    already-open panel. Inside a Promise executor that throw becomes a
//    rejection, and every caller here expects a resolved value it can test with
//    `r?.ok`, so the failure surfaced as an unhandled rejection instead.
//
// 3. MV3 service workers are terminated when idle, and the first message after
//    termination reliably fails with "message port closed" before the worker
//    restarts. One silent retry covers it.
//
// Always RESOLVES, never rejects — callers do `r?.ok ? r.data : null` or read
// `r?.data?.x` directly, so a rejection would bypass their error handling
// entirely. A failure is reported as { ok: false, error }.
const bg = (type, extra = {}, retries = 1) => new Promise((res) => {
  const attempt = (left) => {
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (r) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          if (left > 0) return attempt(left - 1);
          const msg = lastError.message || "runtime_error";
          console.log(`[InvSPRNT] bg(${type}) failed: ${msg}`);
          return res({ ok: false, error: msg });
        }
        if (r && r.ok === false) {
          const err = String(r.error || "");
          if (/not signed in|refresh \d|jwt|invalid token|expired/i.test(err)) {
            setTimeout(() => { try { checkAuth(); } catch {} }, 0);
          }
        }
        res(r);
      });
    } catch (e) {
      // Context invalidated cannot be retried back to life, but resolving with
      // a clean failure beats an unhandled rejection from a dead panel.
      if (left > 0) return attempt(left - 1);
      const msg = String(e?.message || e);
      console.log(`[InvSPRNT] bg(${type}) threw: ${msg}`);
      res({ ok: false, error: msg });
    }
  };
  attempt(retries);
});

const state = {
  asin: null,
  marketplace: "US",
  product: null,
  suppliers: [{ link: "", discount_code: "" }],
  selectedMarketplace: null,
  signedIn: false,
  marketplaces: [],
  primaryMkt: null,
};

/* ─── Drag — host content.js owns mouse tracking via overlay ─── */
const post = (msg) => parent.postMessage({ source: "arbipro-create-panel", ...msg }, "*");
$("apx-drag").addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) return;
  post({ type: "DRAG_BEGIN", sx: e.screenX, sy: e.screenY });
  e.preventDefault();
});
// Safety net: if mouseup happens inside the iframe, tell the host to end the drag.
window.addEventListener("mouseup", () => post({ type: "DRAG_END" }));

$("apx-close").addEventListener("click", () => post({ type: "CLOSE" }));
$("apx-reset").addEventListener("click", () => post({ type: "RESET_POS" }));
let collapsed = false;
function applyCollapsed(next) {
  collapsed = !!next;
  $("apx-body").classList.toggle("hidden", collapsed);
  $("apx-collapse").textContent = collapsed ? "+" : "–";
  post({ type: "COLLAPSE_TOGGLE", collapsed });
}
$("apx-collapse").addEventListener("click", () => applyCollapsed(!collapsed));

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "arbipro-host") return;
  if (d.type === "RESTORE_STATE") {
    collapsed = !!d.collapsed;
    $("apx-body").classList.toggle("hidden", collapsed);
    $("apx-collapse").textContent = collapsed ? "+" : "–";
    return;
  }
  if (d.type === "ASIN_CHANGED") {
    const newMarketplace = d.marketplace || "US";
    const marketplaceChanged = newMarketplace !== state.marketplace;
    const asinChanged = !!(d.asin && d.asin !== state.asin);
    state.marketplace = newMarketplace;
    $("apx-mkt").textContent = `${MARKETPLACES[state.marketplace]?.flag || ""} ${state.marketplace}`;
    if (marketplaceChanged) {
      const codes = getAuthorizedMarketplaceCodes();
      if (codes.includes(state.marketplace) && state.selectedMarketplace !== state.marketplace) {
        state.selectedMarketplace = state.marketplace;
        const sel = $("apx-mkt-select");
        if (sel) sel.value = state.marketplace;
        // Only live re-check eligibility when it's the SAME asin -- a
        // simultaneous asin change means the old eligibility data belongs to
        // a different product entirely, and the user needs to Fetch again
        // regardless (handled by the apx-fetch click handler below).
        if (!asinChanged && state.asin && state.product) runNewFbaEligibilityGate(true);
      }
    }
    if (asinChanged) {
      state.asin = d.asin;
      $("apx-asin").value = d.asin;
      newListing.bypass = false;
    }
  }
  if (d.type === "SOURCING_SESSION" && d.session) {
    state.sourcingSession = d.session;
    applySourcingPrefill();
  }
});

/* ─── Sourcing context (referrer-derived supplier) ─── */
state.sourcingSession = null;
state.recentSuppliers = [];

async function loadRecentSuppliers() {
  try {
    const o = await chrome.storage.local.get("arbipro_recent_suppliers");
    state.recentSuppliers = Array.isArray(o.arbipro_recent_suppliers) ? o.arbipro_recent_suppliers : [];
  } catch { state.recentSuppliers = []; }
  renderSupplierChips();
}

async function loadSourcingSession() {
  try {
    const o = await chrome.storage.local.get("arbipro_sourcing_session");
    const s = o.arbipro_sourcing_session;
    if (s && s.supplier_url && Date.now() - (s.source_timestamp || 0) < 30 * 60 * 1000) {
      state.sourcingSession = s;
      applySourcingPrefill();
    }
  } catch {}
}

function applySourcingPrefill() {
  const banner = $("apx-sourcing-banner");
  if (!banner) return;
  const s = state.sourcingSession;
  if (!s) { banner.classList.add("hidden"); return; }
  // Auto-fill the first supplier slot only if empty.
  if (state.suppliers[0] && !state.suppliers[0].link) {
    state.suppliers[0].link = s.supplier_url;
    if (typeof renderSuppliers === "function") renderSuppliers();
  }
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <span>📦 Sourced from <b>${s.supplier_domain}</b></span>
    <button id="apx-sourcing-dismiss" type="button">Dismiss</button>`;
  $("apx-sourcing-dismiss")?.addEventListener("click", () => {
    state.sourcingSession = null;
    chrome.storage.local.remove("arbipro_sourcing_session").catch(() => {});
    banner.classList.add("hidden");
  });
}

function renderSupplierChips() {
  const wrap = $("apx-supplier-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const r of state.recentSuppliers.slice(0, 8)) {
    if (!r?.url) continue;
    const chip = document.createElement("span");
    chip.className = "apx-supplier-chip";
    chip.textContent = r.domain;
    chip.title = r.url;
    chip.addEventListener("click", () => {
      // Apply to first empty slot, else add a new one.
      const idx = state.suppliers.findIndex((s) => !s.link);
      if (idx >= 0) state.suppliers[idx].link = r.url;
      else state.suppliers.push({ link: r.url, discount_code: "" });
      if (typeof renderSuppliers === "function") renderSuppliers();
    });
    wrap.appendChild(chip);
  }
}

async function pushRecentSupplier(url) {
  try {
    if (!url) return;
    let domain = "";
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { return; }
    const cur = await chrome.storage.local.get("arbipro_recent_suppliers");
    const list = Array.isArray(cur.arbipro_recent_suppliers) ? cur.arbipro_recent_suppliers : [];
    const filtered = list.filter((r) => r && r.domain !== domain);
    filtered.unshift({ domain, url, ts: Date.now() });
    await chrome.storage.local.set({ arbipro_recent_suppliers: filtered.slice(0, 10) });
    state.recentSuppliers = filtered.slice(0, 10);
    renderSupplierChips();
  } catch {}
}

/* ─── Auth gating ─── */
async function checkAuth() {
  const wasSignedIn = state.signedIn;
  const r = await bg("ARBIPRO_GET_SESSION");
  state.signedIn = !!r?.session?.access_token;
  $("apx-signin").classList.toggle("hidden", state.signedIn);
  $("apx-content").classList.toggle("hidden", !state.signedIn);
  if (state.signedIn) await loadMarketplaces();
  if (state.signedIn && !wasSignedIn && state.asin && !state.product) {
    setTimeout(() => $("apx-fetch")?.click(), 150);
  }
}
// Direct email/password sign-in, right here in the panel — no website tab.
// Content scripts can't reliably open the extension's own toolbar popup, so
// this mirrors it inline instead of sending the user off to a "connect" page.
$("apx-signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("apx-signin-email").value.trim();
  const password = $("apx-signin-password").value;
  const btn = $("apx-signin-btn");
  const errEl = $("apx-signin-error");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const r = await bg("ARBIPRO_SIGN_IN_PASSWORD", { email, password });
    if (!r?.ok) throw new Error(r?.error || "Sign in failed");
    $("apx-signin-password").value = "";
    // No explicit refresh here — the chrome.storage.onChanged listener below
    // already calls checkAuth() the moment setSession() writes the new
    // session, so an explicit call here was just a redundant second refresh
    // racing the same one.
  } catch (err) {
    errEl.textContent = String(err?.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.arbipro_session) checkAuth();
});

// The set of marketplace codes the user is actually authorized to sell in.
// Falls back to every known marketplace while state.marketplaces hasn't
// loaded yet (e.g. an ASIN_CHANGED event racing ahead of loadMarketplaces'
// background call) so auto-detection below isn't blocked by that race.
function getAuthorizedMarketplaceCodes() {
  return state.marketplaces.length
    ? state.marketplaces
        .map((m) => Object.keys(MARKETPLACES).find((c) => MARKETPLACES[c].id === m.marketplace_id))
        .filter(Boolean)
    : Object.keys(MARKETPLACES);
}

async function loadMarketplaces() {
  const r = await bg("ARBIPRO_LOAD_MARKETPLACES");
  if (!r?.ok) return;
  state.marketplaces = r.data?.marketplaces || [];
  state.primaryMkt = r.data?.primary || null;
  const sel = $("apx-mkt-select");
  const previousSelection = state.selectedMarketplace;
  sel.innerHTML = "";
  const codes = getAuthorizedMarketplaceCodes();
  for (const c of codes) {
    const m = MARKETPLACES[c];
    if (!m) continue;
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = `${m.flag} ${m.name}`;
    sel.appendChild(opt);
  }
  // loadMarketplaces() can legitimately re-run after the user has already
  // interacted with the panel (checkAuth() re-fires on every
  // arbipro_session storage change -- sign in/out, and any background
  // token refresh triggered by the bg() helper's auth-retry). A prior
  // selection -- whether the user picked it manually or it came from
  // auto-detection on an earlier run -- must be preserved across those
  // re-runs; only fall through to a fresh default if there wasn't one yet,
  // or the previous choice is no longer in the authorized list.
  const def = (previousSelection && codes.includes(previousSelection))
    ? previousSelection
    // Prefer the marketplace actually detected from the Amazon page the
    // user is browsing (state.marketplace, set from ASIN_CHANGED) over the
    // saved primary-marketplace profile setting, as long as it's one the
    // user is authorized to sell in. Falls back to the profile default
    // otherwise.
    : (state.marketplace && codes.includes(state.marketplace))
      ? state.marketplace
      : (state.primaryMkt || codes[0] || "US");
  sel.value = def;
  state.selectedMarketplace = def;
  // loadMarketplaces() can legitimately run more than once per page load
  // (checkAuth() re-runs on every arbipro_session storage change -- sign
  // in, sign out, token refresh -- and calls this when signed in). The
  // <select> element itself persists across those re-runs even though its
  // <option>s get rebuilt, so a plain addEventListener here would stack a
  // new listener on top of any prior one, firing the handler N times per
  // actual change. Guard with a one-time flag instead.
  if (!sel.dataset.changeListenerAttached) {
    sel.dataset.changeListenerAttached = "1";
    sel.addEventListener("change", () => {
      state.selectedMarketplace = sel.value;
      // Re-check eligibility for the newly selected marketplace so the
      // approval warning doesn't keep showing stale data for the
      // marketplace the user just switched away from.
      if (state.asin && state.product) runNewFbaEligibilityGate(true);
    });
  }
}

/* ─── Suppliers ─── */
function renderSuppliers() {
  const wrap = $("apx-suppliers");
  wrap.innerHTML = "";
  state.suppliers.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "apx-supplier-row";
    row.innerHTML = `
      <input data-i="${i}" data-k="link" placeholder="https://supplier..." value="${s.link || ""}" />
      <input data-i="${i}" data-k="discount_code" placeholder="Discount code" value="${s.discount_code || ""}" />
      <button data-rm="${i}" title="Remove">×</button>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      state.suppliers[i][k] = e.target.value;
    });
  });
  wrap.querySelectorAll("button[data-rm]").forEach((b) => {
    b.addEventListener("click", () => {
      state.suppliers.splice(+b.dataset.rm, 1);
      if (!state.suppliers.length) state.suppliers.push({ link: "", discount_code: "" });
      renderSuppliers();
    });
  });
}
$("apx-add-supplier").addEventListener("click", () => {
  state.suppliers.push({ link: "", discount_code: "" });
  renderSuppliers();
});

/* ─── Fetch product ─── */
$("apx-fetch").addEventListener("click", async () => {
  const asin = ($("apx-asin").value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) { setStatus("apx-fetch-status", "Enter a valid 10-char ASIN", "err"); return; }
  state.asin = asin;
  setStatus("apx-fetch-status", "Fetching…");
  const r = await bg("ARBIPRO_INVOKE", { fn: "fetch-listing-snapshot", body: { asin } });
  if (!r?.ok) { setStatus("apx-fetch-status", r?.error || "Failed", "err"); return; }
  state.product = r.data || {};
  setStatus("apx-fetch-status", "");
  renderProduct();
  $("apx-form").classList.remove("hidden");
  if (!$("apx-sku").value) $("apx-sku").value = generateSKU();
  if (state.product.price && !$("apx-sellprice").value) $("apx-sellprice").value = Number(state.product.price).toFixed(2);
  recalcRoi();
  renderSuppliers();
  newListing.fbaElig = null;
  renderNewFbaGate();
  setStatus("apx-action-status", "Checking FBA eligibility…");
  const elig = await runNewFbaEligibilityGate(false);
  setStatus("apx-action-status", fbaStatusText(elig));
});

function googleSearchTitle(title) {
  const q = (title || "").trim();
  if (!q) return;
  window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, "_blank", "noopener,noreferrer");
}

function renderProduct() {
  const p = state.product || {};
  $("apx-product-card").classList.remove("hidden");
  $("apx-img").src = p.imageUrl || "";
  const titleEl = $("apx-title");
  titleEl.innerHTML = "";
  const txt = document.createElement("span");
  txt.textContent = p.title || "—";
  titleEl.appendChild(txt);
  if (p.title) {
    const g = document.createElement("button");
    g.className = "apx-g-btn";
    g.title = "Search title on Google";
    g.textContent = "G";
    g.addEventListener("click", () => googleSearchTitle(p.title));
    titleEl.appendChild(g);
  }
  const m = MARKETPLACES[state.marketplace] || MARKETPLACES.US;
  $("apx-price").textContent = p.price != null ? `${m.symbol}${Number(p.price).toFixed(2)}` : "—";
  // chips
  const chipsWrap = $("apx-mkt-chips");
  chipsWrap.innerHTML = "";
  const list = (p.marketplaceGating || []).filter((g) =>
    g.status !== "NO_SELLER_AUTH" && g.status !== "NOT_CONNECTED"
  );
  for (const g of list) {
    const chip = document.createElement("span");
    // THROTTLED is amber, not red. It means Amazon rate-limited the check --
    // we never got an answer -- which is not the same as Amazon refusing the
    // listing, and colouring it like a refusal reads as a much worse result
    // than it is.
    const cls = g.status === "APPROVED" || g.status === "ELIGIBLE" ? "ok"
              : (g.status === "APPROVAL_REQUIRED" || g.status === "THROTTLED") ? "req" : "bad";
    chip.className = `apx-mkt-chip ${cls}`;
    chip.textContent = `${g.flag || ""} ${g.marketplace || g.name}: ${g.status}`;
    // The backend always sends `reasons`, and the chip was throwing it away --
    // so an "ERROR" chip gave no way to tell a 429 from a 500 from missing
    // credentials without opening the edge-function logs.
    chip.title = (Array.isArray(g.reasons) ? g.reasons : []).join(" · ") || String(g.status || "");
    chipsWrap.appendChild(chip);
  }
}

/* ─── ROI calc ─── */
["apx-totalcost", "apx-units", "apx-sellprice"].forEach((id) =>
  $(id).addEventListener("input", recalcRoi)
);
function recalcRoi() {
  const fees = state.product?.fees || {};
  const totalFees = (Number(fees.referralFee) || 0) + (Number(fees.fbaFee) || 0) + (Number(fees.variableClosingFee) || 0);
  const total = Number($("apx-totalcost").value) || 0;
  const units = Number($("apx-units").value) || 1;
  const price = Number($("apx-sellprice").value) || 0;
  const cog = total / Math.max(1, units);
  const profit = price - totalFees - cog;
  const roi = cog > 0 ? (profit / cog) * 100 : 0;
  $("apx-cog").textContent = `$${cog.toFixed(2)}`;
  $("apx-profit").textContent = `$${profit.toFixed(2)}`;
  $("apx-roi").textContent = cog > 0 ? `${roi.toFixed(0)}%` : "—";
}

/* ─── Validate / Create ─── */
const newListing = { fbaElig: null, checking: false, bypass: false };

// Build the "Create Anyway" bypass button HTML appended to the warning card.
// Users hit this when they've verified Seller Central manually allows New and
// the catalog-level approval restriction is stale. Once clicked, the gate is
// soft-overridden for this ASIN until they refresh or switch ASIN.
function bypassButtonHtml() {
  if (newListing.bypass) {
    return `<div style="margin-top:8px;padding:6px 10px;background:#10b981;color:#fff;border-radius:4px;font-size:12px;font-weight:600;">✓ Bypass active — FBA create enabled. You confirmed Seller Central allows New for this ASIN.</div>`;
  }
  return `<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    <button type="button" id="apx-new-fba-bypass" style="padding:6px 12px;background:#ef4444;color:#fff;border:0;border-radius:4px;font-weight:600;cursor:pointer;font-size:12px;">Bypass — Create Anyway</button>
    <span style="font-size:11px;color:#6b7280;">Use only if Seller Central confirms you can sell this ASIN as New.</span>
  </div>`;
}

function getMode() {
  return document.querySelector("input[name=mode]:checked")?.value || "amazon";
}
function setMode(mode) {
  const input = document.querySelector(`input[name=mode][value="${mode}"]`);
  if (input) input.checked = true;
}
function buildListingPayload(mode) {
  const code = state.selectedMarketplace || "US";
  const m = MARKETPLACES[code] || MARKETPLACES.US;
  return {
    asin: state.asin,
    sku: $("apx-sku").value.trim(),
    price: Number($("apx-sellprice").value),
    quantity: Number($("apx-qty").value) || 1,
    condition: $("apx-cond").value,
    fulfillmentChannel: $("apx-fc").value,
    cost: Number($("apx-totalcost").value),
    marketplaceId: m.id,
    marketplaceCode: code,
    mode,
  };
}

function renderNewFbaGate() {
  const rawBlocked = newListing.fbaElig && newListing.fbaElig.eligible === false;
  const rawUnconfirmed = !rawBlocked && isUnconfirmedApproval(newListing.fbaElig);
  const bypass = newListing.bypass && (rawBlocked || rawUnconfirmed);
  const blocked = rawBlocked && !bypass;
  const unconfirmed = rawUnconfirmed && !bypass;
  const warning = $("apx-new-fba-warning");
  if (warning) {
    const readyHtml = (!blocked && !unconfirmed) ? fbaReadinessHtml(newListing.fbaElig) : "";
    const showWarn = blocked || unconfirmed || !!readyHtml || bypass;
    warning.classList.toggle("hidden", !showWarn);
    warning.classList.toggle("info", !blocked && !unconfirmed && (!!readyHtml || bypass));
    let inner = blocked
      ? fbaWarningHtml(newListing.fbaElig)
      : unconfirmed
        ? fbaUnconfirmedHtml(newListing.fbaElig, state.asin, state.selectedMarketplace)
        : readyHtml;
    // Show bypass control whenever there's a raw block/approval gate, even if
    // already bypassed (so user gets confirmation banner).
    if (rawBlocked || rawUnconfirmed) inner += bypassButtonHtml();
    warning.innerHTML = inner;
    const bypassBtn = warning.querySelector("#apx-new-fba-bypass");
    if (bypassBtn) {
      bypassBtn.addEventListener("click", () => {
        const ok = confirm(
          "Bypass FBA approval gate?\n\n" +
          "Only continue if you have verified in Seller Central that you can create this listing as New.\n\n" +
          "InventorySprint will allow you to Create the listing, but Amazon may still reject the submission if you are not actually approved."
        );
        if (!ok) return;
        newListing.bypass = true;
        if ($("apx-fc")) $("apx-fc").value = "FBA";
        setMode("amazon");
        renderNewFbaGate();
      });
    }
  }
  const fbaOpt = document.querySelector('#apx-fc option[value="FBA"]');
  const amazonMode = document.querySelector('input[name=mode][value="amazon"]');
  const hardGate = !!(blocked || unconfirmed);
  if (fbaOpt) fbaOpt.disabled = hardGate;
  if (amazonMode) amazonMode.disabled = hardGate;
  if (hardGate) {
    if ($("apx-fc")?.value === "FBA") $("apx-fc").value = "FBM";
    if (getMode() === "amazon") setMode("database");
  }
}

async function runNewFbaEligibilityGate(force = true) {
  if (!state.asin) return null;
  newListing.checking = true;
  renderNewFbaGate();
  try {
    let elig = null;
    let edgeError = null;
    try {
      elig = normalizeFbaEligibility(await checkFbaEligibility(state.asin, { marketplace: state.selectedMarketplace }, force));
    } catch (e) {
      edgeError = e;
    }
    if (!elig || elig.eligible !== false) {
      const local = await localFnskuFallback(state.asin);
      if (local) elig = mergeLocalFnskuSignal(elig, local);
    }
    if (!elig && edgeError) {
      elig = {
        eligible: false,
        blockingIssues: [{ code: "ELIGIBILITY_CHECK_FAILED", message: String(edgeError.message || edgeError) }],
        warnings: [],
        fba_block_reason: String(edgeError.message || edgeError),
      };
    }
    newListing.fbaElig = elig;
    renderNewFbaGate();
    return elig;
  } finally {
    newListing.checking = false;
    renderNewFbaGate();
  }
}

$("apx-validate").addEventListener("click", async () => {
  if (!validateForm()) return;
  setStatus("apx-action-status", "Checking FBA eligibility…");
  $("apx-validate").disabled = true;
  const elig = await runNewFbaEligibilityGate(true);
  const blockedHard = elig && elig.eligible === false && !newListing.bypass;
  if (!elig || blockedHard) {
    $("apx-validate").disabled = false;
    setStatus("apx-action-status", "FBA action required. Check the card above, fix the Amazon restriction/barcode issue, then re-check.", "err");
    return;
  }
  setStatus("apx-action-status", fbaStatusText(elig));
  setStatus("apx-action-status", "Validating…");
  const r = await bg("ARBIPRO_INVOKE", {
    fn: "create-amazon-listing",
    body: buildListingPayload("VALIDATION_PREVIEW"),
  });
  $("apx-validate").disabled = false;
  if (!r?.ok) { setStatus("apx-action-status", r?.error || "Validation failed", "err"); return; }
  renderIssues(r.data);
  setStatus("apx-action-status", r.data?.status === "ACCEPTED" || !(r.data?.issues?.length) ? "Looks good ✓" : "Issues found below", r.data?.status === "ACCEPTED" ? "ok" : "err");
});

$("apx-create").addEventListener("click", async () => {
  if (!validateForm()) return;

  // ─── Empty-purchase guard ───
  // Real OA workflow saves a purchase batch (cost + units) and at least one
  // supplier link. If all of those are missing, this almost always means
  // the user hit Create without filling the purchase block. Confirm before
  // we save a row that will look like a ghost in Product Library.
  const _totalChk = Number($("apx-totalcost").value) || 0;
  const _unitsChk = Number($("apx-units").value) || 0;
  const _suppliersChk = state.suppliers.filter((s) => (s.link || "").trim());
  const noPurchaseData = _totalChk <= 0 && _suppliersChk.length === 0;
  if (noPurchaseData) {
    const proceed = confirm(
      "No supplier or cost entered.\n\n" +
      "Click OK to create the Amazon listing only (no purchase batch will be saved — this row will appear empty in Product Library).\n\n" +
      "Click Cancel to go back and add the supplier link / total cost / units first."
    );
    if (!proceed) return;
  }

  setStatus("apx-action-status", "Checking FBA eligibility…");
  $("apx-create").disabled = true;
  try {
    const elig = await runNewFbaEligibilityGate(true);
    if (!elig) throw new Error("FBA eligibility check failed");
    const rawBlocked = elig.eligible === false;
    const bypass = !!newListing.bypass;
    const blocked = rawBlocked && !bypass;
    const saveAsFbmOnly = blocked && getMode() === "database" && $("apx-fc").value === "FBM";
    if (blocked && !saveAsFbmOnly) {
      setStatus("apx-action-status", "FBA action required. Check the card above, fix the Amazon restriction/barcode issue, then re-check.", "err");
      return;
    }
    setStatus("apx-action-status", saveAsFbmOnly ? "Saving FBM-only listing…" : "Creating…");

    // FNSKU lookup (non-blocking)
    let fnsku = null;
    try { const r = await bg("ARBIPRO_LOOKUP_FNSKU", { asin: state.asin }); fnsku = r?.data?.fnsku || null; } catch {}

    const total = Number($("apx-totalcost").value) || 0;
    const units = Number($("apx-units").value) || 1;
    const today = new Date();
    const yyyymmdd = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

    // Image fallback: if Amazon DOM/Catalog returned no image, ask background
    // to look up an image from inventory / active_created_listings before insert
    // so Product Library never shows "no image" for a valid ASIN.
    let imageUrl = state.product?.imageUrl || null;
    if (!imageUrl) {
      try {
        const r = await bg("ARBIPRO_GET_IMAGE_FALLBACK", { asin: state.asin });
        if (r?.ok && r.data?.image_url) imageUrl = r.data.image_url;
      } catch {}
    }

    const supplierLinks = state.suppliers.filter((s) => (s.link || "").trim());
    const row = {
      asin: state.asin,
      sku: $("apx-sku").value.trim(),
      fnsku,
      title: state.product?.title || null,
      image_url: imageUrl,
      price: Number($("apx-sellprice").value),
      cost: total,
      amount: total / Math.max(1, units),
      units,
      supplier_links: supplierLinks,
      date_created: yyyymmdd,
      fba_blocked: blocked,
      fba_block_reason: blocked ? (elig.fba_block_reason || "manufacturer_barcode_or_invalid_fnsku") : null,
      // Phase 4 — hints consumed by background to derive validation_status.
      // FBA + amazon-mode + not-blocked → PENDING_VALIDATION; otherwise ACTIVE.
      fulfillment_channel: $("apx-fc")?.value || "FBM",
      _create_mode: getMode(),
      validation_started_at: getMode() === "amazon" && !blocked && ($("apx-fc")?.value || "").toUpperCase() === "FBA" ? new Date().toISOString() : null,
    };

    const ins = await bg("ARBIPRO_SAVE_LISTING", { row });
    if (!ins?.ok) throw new Error(ins?.error || "DB insert failed");

    // Promote any saved supplier into the recent-suppliers list for next time.
    for (const s of supplierLinks) await pushRecentSupplier(s.link);

    if (getMode() === "amazon" && !blocked) {
      const r = await bg("ARBIPRO_INVOKE", {
        fn: "create-amazon-listing",
        body: { ...buildListingPayload("SUBMIT"), createdListingId: ins?.data?.id || null },
      });
      if (!r?.ok) throw new Error(r?.error || "Amazon create failed");
      renderIssues(r.data);
    }
    setStatus("apx-action-status", blocked ? "FBM-only listing saved to InventorySprint ✓" : "Saved to InventorySprint ✓", "ok");
    resetForm();
  } catch (e) {
    setStatus("apx-action-status", String(e.message || e), "err");
  } finally {
    $("apx-create").disabled = false;
  }
});

/* ─── Still Thinking ─── */
// Lightweight save for items the user is considering but hasn't decided to
// buy yet. Requires only that the ASIN was fetched (so we have title/image).
// Cost/units NOT required — that comes later in the Add Purchase flow.
$("apx-thinking")?.addEventListener("click", async () => {
  if (!state.asin || !/^[A-Z0-9]{10}$/.test(state.asin)) {
    setStatus("apx-action-status", "Fetch a product first", "err");
    return;
  }
  const btn = $("apx-thinking");
  btn.disabled = true;
  setStatus("apx-action-status", "Saving to Still Thinking…");
  try {
    // Supplier URL priority:
    //   1) sourcing session (referrer-derived supplier the user came from)
    //   2) first non-empty supplier slot the user typed
    const sourcingUrl = state.sourcingSession?.supplier_url || null;
    const matchingSlot = state.suppliers.find((s) => (s.link || "").trim() === (sourcingUrl || "").trim())
      || state.suppliers.find((s) => (s.link || "").trim());
    const typedUrl = (state.suppliers.find((s) => (s.link || "").trim())?.link) || null;
    const supplier_url = sourcingUrl || typedUrl || null;
    const discount_code = (matchingSlot?.discount_code || "").trim() || null;

    let imageUrl = state.product?.imageUrl || null;
    if (!imageUrl) {
      try {
        const r = await bg("ARBIPRO_GET_IMAGE_FALLBACK", { asin: state.asin });
        if (r?.ok && r.data?.image_url) imageUrl = r.data.image_url;
      } catch {}
    }

    const r = await bg("ARBIPRO_SAVE_THINKING", {
      row: {
        asin: state.asin,
        title: state.product?.title || null,
        image_url: imageUrl,
        supplier_url,
        discount_code,
        marketplace: state.marketplace || "US",
      },
    });
    if (!r?.ok) throw new Error(r?.error || "Save failed");
    setStatus(
      "apx-action-status",
      r.already
        ? "Already in Still Thinking ✓ (refreshed)"
        : "Saved to Still Thinking ✓ — view in InventorySprint › Still Thinking",
      "ok",
    );
  } catch (e) {
    setStatus("apx-action-status", String(e.message || e), "err");
  } finally {
    btn.disabled = false;
  }
});

/* ─── Open records pages in InventorySprint ─── */
const APP_BASE = (self.ARBIPRO_CFG?.APP_URL || "https://inventorysprint.com").replace(/\/+$/, "");
$("apx-open-thinking")?.addEventListener("click", () => {
  chrome.tabs.create({ url: `${APP_BASE}/tools/still-thinking` });
});
$("apx-open-buyagain")?.addEventListener("click", () => {
  chrome.tabs.create({ url: `${APP_BASE}/tools/need-buy-again` });
});

function validateForm() {
  if (!state.asin || !/^[A-Z0-9]{10}$/.test(state.asin)) { setStatus("apx-action-status", "Fetch a product first", "err"); return false; }
  if (!$("apx-sku").value.trim()) { setStatus("apx-action-status", "SKU required", "err"); return false; }
  if (!(Number($("apx-sellprice").value) > 0)) { setStatus("apx-action-status", "Sell price required", "err"); return false; }
  if (!(Number($("apx-totalcost").value) > 0)) { setStatus("apx-action-status", "Total cost required", "err"); return false; }
  return true;
}

function renderIssues(data) {
  const wrap = $("apx-issues");
  const issues = data?.issues || [];
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", !issues.length);
  for (const i of issues) {
    const div = document.createElement("div");
    div.className = "iss " + (i.severity === "WARNING" ? "warn" : i.severity === "INFO" ? "ok" : "");
    div.textContent = `[${i.severity || "ERROR"}] ${i.code || ""} — ${i.message || ""}`;
    wrap.appendChild(div);
  }
}

function resetForm() {
  // Keep panel open, reset only the inputs (per user requirement).
  $("apx-sku").value = generateSKU();
  $("apx-totalcost").value = "";
  $("apx-units").value = "1";
  $("apx-qty").value = "1";
  state.suppliers = [{ link: "", discount_code: "" }];
  newListing.fbaElig = null;
  renderNewFbaGate();
  renderSuppliers();
  recalcRoi();
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

/* ─── Tabs ─── */
document.querySelectorAll(".apx-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".apx-tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("apx-mode-new").classList.toggle("hidden", tab !== "new");
    $("apx-mode-purchase").classList.toggle("hidden", tab !== "purchase");
    $("apx-mode-edit").classList.toggle("hidden", tab !== "edit");
    $("apx-mode-print").classList.toggle("hidden", tab !== "print");
    if (tab === "purchase" && state.asin && !$("apx-p-asin").value) {
      $("apx-p-asin").value = state.asin;
    }
    if (tab === "edit" && state.asin && !$("apx-e-asin").value) {
      $("apx-e-asin").value = state.asin;
    }
    if (tab === "print") {
      if (state.asin && !$("apx-l-asin").value) $("apx-l-asin").value = state.asin;
      void checkPrintClient();
    }
  });
});

/* ─── Add Purchase mode ─── */
const purchase = { source: null, fbaElig: null, checking: false };

function fmtMoney(n) {
  const v = Number(n);
  return isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function renderPurchaseSuppliers(links) {
  const wrap = $("apx-p-suppliers");
  wrap.innerHTML = "";
  const arr = Array.isArray(links) ? links : [];
  if (!arr.length) {
    wrap.innerHTML = `<div class="apx-k">No supplier on file</div>`;
    return;
  }
  arr.forEach((s) => {
    const link = (s?.link || "").trim();
    const code = (s?.discount_code || "").trim();
    const row = document.createElement("div");
    row.className = "apx-p-supplier";
    const url = link ? (/^https?:\/\//i.test(link) ? link : `https://${link}`) : "";
    row.innerHTML = `
      <a href="${url}" target="_blank" rel="noopener noreferrer" title="${link}">${link || "—"}</a>
      ${code ? `<span class="code">${code}</span>` : ""}
      ${link ? `<button data-open="${url}">Open</button>` : ""}
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("button[data-open]").forEach((b) => {
    b.addEventListener("click", () => window.open(b.dataset.open, "_blank", "noopener,noreferrer"));
  });
}

function renderSkuPicker(containerId, rows, selectedSku, onPick) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = "";
  if (!Array.isArray(rows) || rows.length <= 1) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const label = document.createElement("div");
  label.className = "apx-k";
  label.style.cssText = "margin-bottom:4px";
  label.textContent = `${rows.length} SKUs found for this ASIN — pick one:`;
  box.appendChild(label);
  rows.forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSel = r.sku === selectedSku;
    btn.className = `apx-option${isSel ? " selected" : ""}`;
    const units = r.units != null ? `${r.units}u` : "";
    const cog = r.amount != null ? `$${Number(r.amount).toFixed(2)}` : "";
    const meta = [units, cog].filter(Boolean).join(" · ");
    btn.innerHTML = `<b>${escapeHtml(r.sku || "—")}</b>${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}${isSel ? `<div class="meta">✓ Selected</div>` : ""}`;
    btn.addEventListener("click", () => onPick(r));
    box.appendChild(btn);
  });
}

/* ─── Need to Buy Again forecast (Add Purchase) ──────────────────────
 * Mirrors src/pages/tools/NeedBuyAgain.tsx — uses inventory + sales_orders
 * and the user's reorder_planning_settings to show "how many to reorder"
 * the moment a listing is found.
 */
const REP_RISK_LABEL = {
  critical: "Buy now",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "No data",
};
function fmtRepNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(Number(n)).toLocaleString();
}
function renderReplenish(d) {
  const card = $("apx-p-replenish");
  if (!card) return;
  card.classList.remove("hidden");
  const risk = (d?.riskLevel || "unknown");
  const pill = $("apx-rep-risk");
  pill.className = "apx-rep-risk apx-rep-" + risk;
  pill.textContent = REP_RISK_LABEL[risk] || "—";
  $("apx-rep-qty").textContent = fmtRepNum(d?.replenishQty);
  $("apx-rep-stockout").textContent =
    d?.daysUntilStockout === null || d?.daysUntilStockout === undefined
      ? "—"
      : Math.round(d.daysUntilStockout).toLocaleString();
  $("apx-rep-avail").textContent = fmtRepNum(d?.available);
  $("apx-rep-inbound").textContent = fmtRepNum(d?.inbound);
  $("apx-rep-reserved").textContent = fmtRepNum(d?.reserved);
  $("apx-rep-s7").textContent = fmtRepNum(d?.sales7d);
  $("apx-rep-s30").textContent = fmtRepNum(d?.sales30d);
  $("apx-rep-s90").textContent = fmtRepNum(d?.sales90d);
  const ads = Number(d?.ads || 0);
  const lt = Number(d?.totalLeadTimeDays || 0);
  const plan = Number(d?.planningDays || 0);
  const adsTxt = ads > 0 ? `${(Math.round(ads * 10) / 10)} units/day` : "no recent sales";
  $("apx-rep-meta").textContent =
    `ADS ${adsTxt} · plan ${plan}d (lead ${lt}d + coverage ${plan - lt}d)`;
  $("apx-rep-status").textContent = d?.hasSettings
    ? ""
    : "Using default lead-time / coverage. Tune in Need to Buy Again → Reorder Planning.";
  $("apx-rep-status").style.color = "var(--muted)";
}
async function loadReplenishForecast(asin) {
  const card = $("apx-p-replenish");
  if (!card || !asin) return;
  card.classList.remove("hidden");
  $("apx-rep-qty").textContent = "…";
  $("apx-rep-stockout").textContent = "…";
  $("apx-rep-status").textContent = "Calculating from your inventory + 90-day sales…";
  $("apx-rep-status").style.color = "var(--muted)";
  try {
    const r = await bg("ARBIPRO_REPLENISH_FORECAST", { asin });
    if (!r?.ok) throw new Error(r?.error || "Forecast failed");
    if (purchase.source?.asin !== asin) return; // stale
    renderReplenish(r.data || {});
  } catch (e) {
    $("apx-rep-status").textContent = `Forecast unavailable: ${e.message || e}`;
    $("apx-rep-status").style.color = "var(--bad)";
  }
}

function renderPurchaseCard(row) {
  purchase.source = row;
  purchase.fbaElig = row.fba_blocked === true
    ? { eligible: false, blockingIssues: [], warnings: [], fba_block_reason: row.fba_block_reason || "manufacturer_barcode_or_invalid_fnsku" }
    : null;
  $("apx-p-card").classList.remove("hidden");
  $("apx-p-form").classList.remove("hidden");
  $("apx-p-img").src = row.image_url || "";
  const ptEl = $("apx-p-title");
  ptEl.innerHTML = "";
  const ptxt = document.createElement("span");
  ptxt.textContent = row.title || "—";
  ptEl.appendChild(ptxt);
  if (row.title) {
    const g = document.createElement("button");
    g.className = "apx-g-btn";
    g.title = "Search title on Google";
    g.textContent = "G";
    g.addEventListener("click", () => googleSearchTitle(row.title));
    ptEl.appendChild(g);
  }
  const asinLbl = $("apx-p-asin-lbl");
  asinLbl.innerHTML = "";
  if (row.asin) {
    const mkCode = row.marketplace || row.marketplace_code || state.marketplace || "US";
    const domain = (MARKETPLACES[mkCode] || MARKETPLACES.US).domain;
    const a = document.createElement("a");
    a.href = `https://www.${domain}/dp/${row.asin}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = row.asin;
    a.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;pointer-events:auto;position:relative;z-index:2";
    a.title = "Open on Amazon";
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener,noreferrer");
      e.preventDefault();
    });
    asinLbl.appendChild(a);
  } else {
    asinLbl.textContent = "—";
  }
  $("apx-p-price").textContent = fmtMoney(row.price);
  { const skuEl = document.getElementById("apx-p-sku-lbl"); if (skuEl) skuEl.textContent = row.sku || "—"; }
  $("apx-p-units").textContent = row.units ?? "—";
  $("apx-p-cog").textContent = fmtMoney(row.amount);
  $("apx-p-total").textContent = fmtMoney(row.cost);
  $("apx-p-date").textContent = formatDateForMarket(row.date_created || row.created_at, marketplaceCodeForRow(row));
  renderPurchaseSuppliers(row.supplier_links);
  // Reset form
  $("apx-p-totalcost").value = "";
  $("apx-p-newunits").value = "1";
  $("apx-p-fbm-confirm").checked = false;
  recalcPurchaseCog();
  renderPurchaseFbaGate();
  loadReplenishForecast(row.asin);
  // Kick off FBA eligibility check in the background WITHOUT disabling the
  // Add Purchase button. The check can be slow (edge function + SP-API), and
  // blocking the UI here is what makes Find/Add feel like it "hangs forever".
  // The button stays usable; if the ASIN turns out to be FBA-blocked the
  // gate will appear afterwards and the user can confirm FBM-only.
  (async () => {
    try {
      let elig = null;
      try { elig = normalizeFbaEligibility(await checkFbaEligibility(row.asin, row, false)); } catch {}
      if (!elig || elig.eligible !== false) {
        const local = await localFnskuFallback(row.asin).catch(() => null);
        if (local) elig = mergeLocalFnskuSignal(elig, local);
      }
      if (purchase.source?.asin === row.asin && elig) {
        purchase.fbaElig = elig;
        renderPurchaseFbaGate();
      }
    } catch {}
  })();
}

function renderPurchaseFbaGate() {
  const blocked = purchase.fbaElig && purchase.fbaElig.eligible === false;
  const confirmed = $("apx-p-fbm-confirm")?.checked === true;
  const warning = $("apx-p-fba-warning");
  const readyHtml = !blocked ? fbaReadinessHtml(purchase.fbaElig) : "";
  warning.classList.toggle("hidden", !blocked && !readyHtml);
  warning.classList.toggle("info", !blocked && !!readyHtml);
  warning.innerHTML = blocked ? fbaWarningHtml(purchase.fbaElig) : readyHtml;
  $("apx-p-fbm-confirm-wrap").classList.toggle("hidden", !blocked);
  const btn = $("apx-p-add");
  btn.textContent = blocked ? "Save as FBM only" : "Add Purchase";
  btn.disabled = purchase.checking || (blocked && !confirmed);
}

async function localFnskuFallback(asin) {
  // Mirrors Print Label's local check. Manufacturer-barcode mode remains a hard
  // safety issue, but a missing X-FNSKU by itself is only a propagation warning.
  try {
    const options = await loadFnskuOptionsLikeWeb(asin, false).catch(() => []);
    if (Array.isArray(options) && options.some((o) => isValidFnsku(o?.fnsku))) return null;
    const lookup = await bg("ARBIPRO_LOOKUP_FNSKU", { asin });
    const fnsku = normalizeFnsku(lookup?.data?.fnsku);
    if (fnsku && fnsku === normalizeFnsku(asin)) {
      return {
        eligible: false,
        blockingIssues: [{
          code: "MANUFACTURER_BARCODE_MODE",
          message: "Listing is configured to use the manufacturer barcode (UPC/EAN). Amazon only allows this for registered brand owners.",
        }],
        warnings: [],
        fba_block_reason: "manufacturer_barcode_mode",
      };
    }
    if (!fnsku || !isValidFnsku(fnsku)) {
      return {
        eligible: true,
        blockingIssues: [],
        warnings: [{
          code: "INVALID_FNSKU",
          message: "No valid Amazon FNSKU is visible yet. Continue Amazon listing creation, answer any compliance/prep questions, then re-check after propagation.",
        }],
        infos: [{
          code: "FNSKU_PENDING_LISTING_CREATION",
          message: "Amazon normally assigns the FNSKU after the FBA listing is created or updated.",
        }],
        fba_block_reason: null,
      };
    }
  } catch {}
  return null;
}

async function refreshPurchaseFbaEligibility(row, force = false) {
  if (!row?.asin) return null;
  purchase.checking = true;
  renderPurchaseFbaGate();
  try {
    let elig = null;
    let edgeError = null;
    try {
      elig = normalizeFbaEligibility(await checkFbaEligibility(row.asin, row, force));
    } catch (e) {
      edgeError = e;
    }
    // Always cross-check against local fnsku data so a flaky edge function
    // can never let a manufacturer-barcode ASIN through Add Purchase.
    if (!elig || elig.eligible !== false) {
      const local = await localFnskuFallback(row.asin);
      if (local) elig = mergeLocalFnskuSignal(elig, local);
    }
    if (!elig && edgeError) {
      elig = {
        eligible: false,
        blockingIssues: [{ code: "ELIGIBILITY_CHECK_FAILED", message: String(edgeError.message || edgeError) }],
        warnings: [],
        fba_block_reason: String(edgeError.message || edgeError),
      };
      setStatus("apx-p-action-status", String(edgeError.message || edgeError), "err");
    }
    if (purchase.source?.asin === row.asin) {
      purchase.fbaElig = elig;
      renderPurchaseFbaGate();
    }
    return elig;
  } finally {
    purchase.checking = false;
    renderPurchaseFbaGate();
  }
}

function recalcPurchaseCog() {
  const t = Number($("apx-p-totalcost").value) || 0;
  const u = Math.max(1, Number($("apx-p-newunits").value) || 1);
  $("apx-p-newcog").value = t > 0 ? `$${(t / u).toFixed(2)}` : "";
}
["apx-p-totalcost", "apx-p-newunits"].forEach((id) =>
  $(id)?.addEventListener("input", recalcPurchaseCog)
);
$("apx-p-fbm-confirm")?.addEventListener("change", renderPurchaseFbaGate);

$("apx-p-find").addEventListener("click", async () => {
  const asin = ($("apx-p-asin").value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    setStatus("apx-p-find-status", "Enter a valid 10-char ASIN", "err");
    return;
  }
  setStatus("apx-p-find-status", "Searching…");
  $("apx-p-card").classList.add("hidden");
  $("apx-p-form").classList.add("hidden");
  $("apx-p-replenish")?.classList.add("hidden");
  purchase.source = null;
  purchase.fbaElig = null;
  renderPurchaseFbaGate();
  const r = await bg("ARBIPRO_FIND_LISTING", { asin });
  if (!r?.ok) { setStatus("apx-p-find-status", r?.error || "Search failed", "err"); return; }
  if (!r.data) {
    setStatus("apx-p-find-status", "No existing listing for this ASIN. Switch to New Listing.", "err");
    return;
  }
  setStatus("apx-p-find-status", "");
  const allRows = Array.isArray(r.data._allRows) ? r.data._allRows : [r.data];
  const pick = (row) => {
    renderSkuPicker("apx-p-sku-picker", allRows, row.sku, pick);
    renderPurchaseCard({ ...row, _allRows: allRows });
  };
  pick(r.data);
});

$("apx-p-add").addEventListener("click", async () => {
  if (!purchase.source) { setStatus("apx-p-action-status", "Find a listing first", "err"); return; }
  const total = Number($("apx-p-totalcost").value) || 0;
  const units = Math.max(1, Number($("apx-p-newunits").value) || 1);
  if (!(total > 0)) { setStatus("apx-p-action-status", "Total cost required", "err"); return; }
  if (!(units >= 1)) { setStatus("apx-p-action-status", "Units must be ≥ 1", "err"); return; }
  // Use whatever FBA result we already have (from the background check
  // kicked off after Find). Do NOT force-refresh here — that's the call
  // that previously made Add Purchase appear to hang.
  const elig = purchase.fbaElig;
  if (elig && elig.eligible === false && !$("apx-p-fbm-confirm").checked) {
    setStatus("apx-p-action-status", "Blocked from FBA. Tick the FBM-only confirmation to save without sending this ASIN into FBA workflows.", "err");
    renderPurchaseFbaGate();
    return;
  }
  setStatus("apx-p-action-status", "Saving…");
  $("apx-p-add").disabled = true;
  try {
    const r = await bg("ARBIPRO_ADD_PURCHASE", {
      source: purchase.source,
      totalCost: total,
      units,
      fbaBlocked: elig?.eligible === false,
      fbaBlockReason: elig?.eligible === false ? (elig.fba_block_reason || "manufacturer_barcode_or_invalid_fnsku") : null,
    });
    if (!r?.ok) throw new Error(r?.error || "Insert failed");
    setStatus("apx-p-action-status", elig?.eligible === false
      ? `FBM-only purchase saved — ${units} units @ $${(total/units).toFixed(2)} COG ✓`
      : `Purchase added — ${units} units @ $${(total/units).toFixed(2)} COG ✓`, "ok");
    $("apx-p-totalcost").value = "";
    $("apx-p-newunits").value = "1";
    recalcPurchaseCog();
    // Refresh card to show latest
    const r2 = await bg("ARBIPRO_FIND_LISTING", { asin: purchase.source.asin });
    if (r2?.ok && r2.data) {
      const allRows2 = Array.isArray(r2.data._allRows) ? r2.data._allRows : [r2.data];
      const currentSku = purchase.source?.sku;
      const same = allRows2.find((x) => x.sku === currentSku) || r2.data;
      const pick2 = (row) => {
        renderSkuPicker("apx-p-sku-picker", allRows2, row.sku, pick2);
        renderPurchaseCard({ ...row, _allRows: allRows2 });
      };
      pick2(same);
    }
  } catch (e) {
    setStatus("apx-p-action-status", String(e.message || e), "err");
  } finally {
    renderPurchaseFbaGate();
  }
});

/* ─── Sub-tabs (ASIN / Supplier) inside Add Purchase ─── */
document.querySelectorAll(".apx-subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sub = btn.dataset.sub;
    document.querySelectorAll(".apx-subtab").forEach((b) => b.classList.toggle("active", b === btn));
    $("apx-sub-asin").classList.toggle("hidden", sub !== "asin");
    $("apx-sub-title").classList.toggle("hidden", sub !== "title");
    $("apx-sub-supplier").classList.toggle("hidden", sub !== "supplier");
  });
});

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function firstSupplierLink(links) {
  const arr = Array.isArray(links) ? links : [];
  for (const s of arr) {
    const link = (s?.link || "").trim();
    if (link) return link;
  }
  return "";
}

function renderSupplierResults(rows) {
  const wrap = $("apx-p-supplier-results");
  wrap.innerHTML = "";
  if (!rows || !rows.length) {
    wrap.innerHTML = `<div class="apx-k" style="text-align:center;padding:8px">No matching purchases found.</div>`;
    return;
  }
  rows.forEach((row, idx) => {
    const div = document.createElement("div");
    div.className = "apx-sup-result";
    div.dataset.idx = String(idx);
    const url = firstSupplierLink(row.supplier_links);
    const mkCodeS = row.marketplace || state.marketplace || "US";
    const created = formatDateForMarket(row.date_created || row.created_at, mkCodeS);
    const domainS = (MARKETPLACES[mkCodeS] || MARKETPLACES.US).domain;
    const asinHtmlS = row.asin
      ? `<a href="https://www.${domainS}/dp/${escapeHtml(row.asin)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;cursor:pointer" data-asin-link="1"><b>${escapeHtml(row.asin)}</b></a>`
      : "<b>—</b>";
    div.innerHTML = `
      <img src="${escapeHtml(row.image_url || "")}" alt="" />
      <div class="body">
        <div class="title">${escapeHtml(row.title || "—")}</div>
        <div class="row">
          <span>${asinHtmlS}</span>
          ${row.price != null ? `<span>· ${fmtMoney(row.price)}</span>` : ""}
        </div>
        <div class="row">
          <span>Units <b>${row.units ?? "—"}</b></span>
          <span>COG <b>${fmtMoney(row.amount)}</b></span>
          <span>Total <b>${fmtMoney(row.cost)}</b></span>
        </div>
        <div class="row"><span>Created: <b>${escapeHtml(created)}</b></span></div>
        ${url ? `<div class="url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>` : ""}
      </div>`;
    div.addEventListener("click", (e) => {
      if (e.target.closest('[data-asin-link="1"]')) return;
      wrap.querySelectorAll(".apx-sup-result").forEach((el) => el.classList.remove("selected"));
      div.classList.add("selected");
      renderPurchaseCard(row);
      // Scroll the purchase card into view
      $("apx-p-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    wrap.appendChild(div);
  });
}

$("apx-p-supplier-find").addEventListener("click", async () => {
  const q = ($("apx-p-supplier").value || "").trim();
  if (!q) { setStatus("apx-p-supplier-status", "Enter a supplier name or domain", "err"); return; }
  setStatus("apx-p-supplier-status", "Searching…");
  $("apx-p-supplier-results").innerHTML = "";
  $("apx-p-card").classList.add("hidden");
  $("apx-p-form").classList.add("hidden");
  const r = await bg("ARBIPRO_SEARCH_BY_SUPPLIER", { query: q });
  if (!r?.ok) { setStatus("apx-p-supplier-status", r?.error || "Search failed", "err"); return; }
  const rows = r.data || [];
  setStatus("apx-p-supplier-status", `${rows.length} match${rows.length === 1 ? "" : "es"}. Click a record to add a new purchase.`, rows.length ? "ok" : "err");
  renderSupplierResults(rows);
});
$("apx-p-supplier").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("apx-p-supplier-find").click();
});

function renderTitleResults(rows) {
  const wrap = $("apx-p-title-results");
  wrap.innerHTML = "";
  if (!rows || !rows.length) {
    wrap.innerHTML = `<div class="apx-k" style="text-align:center;padding:8px">No matching listings found.</div>`;
    return;
  }
  rows.forEach((row, idx) => {
    const div = document.createElement("div");
    div.className = "apx-sup-result";
    div.dataset.idx = String(idx);
    const url = firstSupplierLink(row.supplier_links);
    const mkCodeT = row.marketplace || state.marketplace || "US";
    const created = formatDateForMarket(row.date_created || row.created_at, mkCodeT);
    const domainT = (MARKETPLACES[mkCodeT] || MARKETPLACES.US).domain;
    const asinHtmlT = row.asin
      ? `<a href="https://www.${domainT}/dp/${escapeHtml(row.asin)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;cursor:pointer" data-asin-link="1"><b>${escapeHtml(row.asin)}</b></a>`
      : "<b>—</b>";
    div.innerHTML = `
      <img src="${escapeHtml(row.image_url || "")}" alt="" />
      <div class="body">
        <div class="title">${escapeHtml(row.title || "—")}</div>
        <div class="row">
          <span>${asinHtmlT}</span>
          ${row.price != null ? `<span>· ${fmtMoney(row.price)}</span>` : ""}
        </div>
        <div class="row">
          <span>Units <b>${row.units ?? "—"}</b></span>
          <span>COG <b>${fmtMoney(row.amount)}</b></span>
          <span>Total <b>${fmtMoney(row.cost)}</b></span>
        </div>
        <div class="row"><span>Created: <b>${escapeHtml(created)}</b></span></div>
        ${url ? `<div class="url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>` : ""}
      </div>`;
    div.addEventListener("click", (e) => {
      if (e.target.closest('[data-asin-link="1"]')) return;
      wrap.querySelectorAll(".apx-sup-result").forEach((el) => el.classList.remove("selected"));
      div.classList.add("selected");
      renderPurchaseCard(row);
      $("apx-p-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    wrap.appendChild(div);
  });
}

$("apx-p-title-find").addEventListener("click", async () => {
  const q = ($("apx-p-title-q").value || "").trim();
  if (q.length < 2) { setStatus("apx-p-title-status", "Enter at least 2 characters", "err"); return; }
  setStatus("apx-p-title-status", "Searching…");
  $("apx-p-title-results").innerHTML = "";
  $("apx-p-card").classList.add("hidden");
  $("apx-p-form").classList.add("hidden");
  const r = await bg("ARBIPRO_SEARCH_BY_TITLE", { query: q });
  if (!r?.ok) { setStatus("apx-p-title-status", r?.error || "Search failed", "err"); return; }
  const rows = r.data || [];
  setStatus("apx-p-title-status", `${rows.length} match${rows.length === 1 ? "" : "es"}. Click a record to add a new purchase.`, rows.length ? "ok" : "err");
  renderTitleResults(rows);
});
$("apx-p-title-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("apx-p-title-find").click();
});

/* ─── Boot ─── */
post({ type: "READY" });
checkAuth();
renderSuppliers();
loadRecentSuppliers();
loadSourcingSession();
// Re-check auth every 5s in case the user just signed in via handoff tab.
setInterval(checkAuth, 5000);

/* ─── Print Label mode ─── */
const PRINT_CLIENT_URLS = ["http://localhost:7777", "http://127.0.0.1:7777"];
const printState = { listing: null, options: [], selectedOptionIndex: null, clientUrl: null, connected: false, fbaElig: null };

function isValidFnsku(value) {
  return VALID_FNSKU_RE.test((value || "").toString().trim().toUpperCase());
}

function normalizeSku(value) {
  return (value || "").toString().trim();
}

function normalizeFnsku(value) {
  return (value || "").toString().trim().toUpperCase();
}

function fnskuBlockReason(fnsku, asin) {
  const normalized = normalizeFnsku(fnsku);
  const normalizedAsin = normalizeFnsku(asin);
  if (!normalized) return "Not safe to print — no valid Amazon FNSKU found.";
  if (normalizedAsin && normalized === normalizedAsin) return "Blocked: ASIN is using manufacturer barcode, not Amazon FNSKU.";
  if (!isValidFnsku(normalized)) return "Not safe to print — no valid Amazon FNSKU found.";
  return null;
}

function renderPrintSafety() {
  const row = printState.listing;
  const fnsku = normalizeFnsku($("apx-l-fnsku-input")?.value || row?.fnsku);
  const localReason = fnskuBlockReason(fnsku, row?.asin);
  const fbaBlocked = printState.fbaElig && printState.fbaElig.eligible === false;
  const warn = $("apx-l-warning");
  const printBtn = $("apx-l-print");
  const selected = $("apx-l-selected");
  if (fbaBlocked || localReason) {
    warn.classList.remove("hidden");
    warn.innerHTML = fbaBlocked
      ? fbaWarningHtml(printState.fbaElig, "FBA action required for this ASIN — review the readiness details below before printing a thermal label.")
      : `<strong>⛔ ${escapeHtml(localReason)}</strong><div>This listing appears to use manufacturer barcode instead of an Amazon FNSKU. Only X-prefixed Amazon FNSKUs can be printed.</div>`;
    if (selected) selected.classList.add("hidden");
  } else {
    warn.classList.add("hidden");
    warn.textContent = "";
  }
  if (printBtn) {
    printBtn.disabled = !row || !!localReason || !!fbaBlocked;
    printBtn.title = fbaBlocked ? (printState.fbaElig?.fba_block_reason || "FBA blocked") : (localReason || "");
  }
}

async function getPrimarySellerAuth() {
  const r = await bg("ARBIPRO_GET_PRIMARY_SELLER_AUTH", {});
  return r?.ok ? r.data : null;
}

async function runRescueForSkus(asin, skus) {
  const results = await Promise.all((skus || []).map((sku) =>
    bg("ARBIPRO_INVOKE", { fn: "rescue-inventory-asin", body: { asin, sku } })
  ));
  return results
    .map((result, index) => {
      const identity = result?.data?.matched_summary_identity || result?.data?.verification_trace?.matched_summary_identity;
      const fnsku = normalizeFnsku(identity?.fnsku);
      if (!isValidFnsku(fnsku)) return null;
      return { fnsku, condition: identity?.condition || "NEW", sku: skus[index] };
    })
    .filter(Boolean);
}

async function syncFnskuFromAmazon(asin) {
  try {
    const live = await bg("ARBIPRO_INVOKE", { fn: "get-fnsku", body: { asin } });
    const data = live?.data || {};
    const fnsku = (data.fnsku || "").toString().trim().toUpperCase();
    if (live?.ok && isValidFnsku(fnsku)) {
      return { fnsku, condition: data.condition || null, source: data.source || "amazon" };
    }
  } catch {}
  return null;
}

async function loadFnskuOptionsLikeWeb(asin, allowAutoSync = true) {
  const sellerAuth = await getPrimarySellerAuth();
  const sellerId = sellerAuth?.seller_id || sellerAuth?.selling_partner_id || "";
  const marketplaceId = sellerAuth?.marketplace_id || "ATVPDKIKX0DER";

  // Helper: read every cached fnsku_map row for this ASIN.
  const readCached = async () => {
    const sources = await bg("ARBIPRO_LOAD_FNSKU_SOURCES", { asin, sellerId, marketplaceId });
    const rows = Array.isArray(sources?.data?.fnskuRows) ? sources.data.fnskuRows : [];
    const inventoryRows = Array.isArray(sources?.data?.inventoryRows) ? sources.data.inventoryRows : [];
    const createdListingRows = Array.isArray(sources?.data?.createdListingRows) ? sources.data.createdListingRows : [];

    // ⚠️ GHOST SKUs MUST NOT REACH THE LABEL PICKER.
    //
    // fnsku_map keeps a row per (fnsku, condition) forever, including SKUs the
    // seller has since deleted in Seller Central. This function used to filter
    // on isValidFnsku() alone -- a FORMAT check -- so a dead SKU's FNSKU was
    // offered exactly like a live one, and renderFnskuOptions() defaults
    // selectedOptionIndex to 0, so it could be PRE-SELECTED.
    //
    // Observed 2026-08-24 on B09XFCCC9B: the picker offered X0042DN6RV
    // (SKU 1062183890, deleted) alongside X0058P2FZV (SKU 05Y-5W2-D434, live),
    // with the dead one selected. Printing that label sends physical units to
    // Amazon under a SKU that no longer exists -- and unlike a bad number on a
    // screen, it cannot be undone with an UPDATE.
    //
    // get-fnsku already refuses to resurrect ghost SKUs on the server side, and
    // the background handler already fetches active_created_listings, described
    // in its own comment as the "validation + ghost gate". Neither was wired to
    // this list.
    const deadSkus = new Set();
    for (const r of inventoryRows) {
      const sku = normalizeSku(r?.sku);
      if (!sku) continue;
      const status = String(r?.listing_status || "").toUpperCase();
      // Explicit markers first. NOT_IN_CATALOG / DELETED / NOT_FOUND are
      // unambiguous. INACTIVE is deliberately NOT treated as dead -- a listing
      // can sit inactive and still be real, and hiding a valid FNSKU would push
      // the user to hand-type one, which is worse.
      const isDead = !!r?.ghost_reason || !!r?.deleted_reason ||
        ["NOT_IN_CATALOG", "DELETED", "NOT_FOUND"].includes(status);
      if (isDead) deadSkus.add(sku);
    }

    // SKUs backed by an active created listing are known-good; used to order
    // the survivors so the DEFAULT selection is the safest one available.
    const liveSkus = new Set();
    for (const r of createdListingRows) {
      const sku = normalizeSku(r?.sku);
      if (sku) liveSkus.add(sku);
    }

    const merged = new Map();
    for (const r of rows) {
      const fnsku = normalizeFnsku(r?.fnsku);
      if (!isValidFnsku(fnsku)) continue;
      const sku = normalizeSku(r?.seller_sku);
      if (sku && deadSkus.has(sku)) {
        // console.log, NOT console.warn: chrome://extensions surfaces warnings
        // in its Errors panel, and hiding a ghost SKU is EXPECTED behaviour, not an
        // anomaly. Warning on every lookup of an ASIN with an old SKU trains the
        // user to ignore that panel, which is worse than it being quiet.
        console.log(`[InvSPRNT] FNSKU option hidden: ${fnsku} / ${sku} is a deleted or ghosted SKU`);
        continue;
      }
      const condition = (r?.condition || "NEW").toString().toUpperCase();
      merged.set(`${fnsku}|${condition}`, { fnsku, condition, sku, isLive: !!(sku && liveSkus.has(sku)) });
    }

    // Known-good first, so selectedOptionIndex = 0 lands on a live SKU.
    return Array.from(merged.values()).sort((a, b) => Number(b.isLive) - Number(a.isLive));
  };

  // First read from DB cache.
  let options = await readCached();

  // If we don't have at least 2 cached options, ask get-fnsku to refresh from Amazon
  // (it now scans every known SKU for this ASIN and upserts NEW + USED + COLLECTIBLE rows).
  if (allowAutoSync && options.length < 2) {
    try {
      await bg("ARBIPRO_INVOKE", { fn: "get-fnsku", body: { asin } });
    } catch (e) { /* swallow — fall back to cache */ }
    options = await readCached();
  }

  // Last-ditch: per-SKU rescue for any inventory SKU still missing from fnsku_map.
  if (allowAutoSync && options.length < 2) {
    const sources = await bg("ARBIPRO_LOAD_FNSKU_SOURCES", { asin, sellerId, marketplaceId });
    const data = sources?.data || {};
    const inventoryRows = Array.isArray(data.inventoryRows) ? data.inventoryRows : [];
    const createdListingRows = Array.isArray(data.createdListingRows) ? data.createdListingRows : [];
    const knownSkus = new Set(options.map((o) => o.sku).filter(Boolean));
    const missing = Array.from(new Set([...inventoryRows, ...createdListingRows]
      .map((r) => normalizeSku(r?.sku))
      .filter((s) => s && !knownSkus.has(s))));
    if (missing.length) {
      await runRescueForSkus(asin, missing);
      options = await readCached();
    }
  }

  if (options.length) return options;

  // Final fallback: single live FNSKU lookup.
  const liveFnsku = await syncFnskuFromAmazon(asin);
  return liveFnsku?.fnsku ? [liveFnsku] : [];
}

function loadThermalSettings() {
  try {
    const raw = localStorage.getItem("thermalPrinterSettings.v1");
    if (!raw) return { sizeId: "2x1", dpi: 203, printerName: "", printerLanguage: "auto" };
    const p = JSON.parse(raw);
    return {
      sizeId: p.sizeId || "2x1",
      dpi: p.dpi || 203,
      printerName: typeof p.printerName === "string" ? p.printerName : "",
      printerLanguage: p.printerLanguage || "auto",
    };
  } catch {
    return { sizeId: "2x1", dpi: 203, printerName: "", printerLanguage: "auto" };
  }
}

async function checkPrintClient() {
  setStatus("apx-l-client-status", "Checking print client…");
  for (const baseUrl of PRINT_CLIENT_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const h = await res.json().catch(() => ({}));
      printState.clientUrl = baseUrl;
      printState.connected = true;
      const printer = h?.printer ? ` · ${h.printer}` : "";
      setStatus("apx-l-client-status", `Print client connected${printer}`, "ok");
      return true;
    } catch { /* try next */ }
  }
  printState.clientUrl = null;
  printState.connected = false;
  setStatus(
    "apx-l-client-status",
    "SprintPrint is not connected. Start it to print labels.",
    "err",
  );
  return false;
}

function renderPrintCard(row) {
  printState.listing = row;
  $("apx-l-card").classList.remove("hidden");
  $("apx-l-form").classList.remove("hidden");
  $("apx-l-img").src = row.image_url || "";
  $("apx-l-title").textContent = row.title || "—";
  const lAsinLbl = $("apx-l-asin-lbl");
  lAsinLbl.innerHTML = "";
  if (row.asin) {
    const mkCode = row.marketplace || row.marketplace_code || state.marketplace || "US";
    const domain = (MARKETPLACES[mkCode] || MARKETPLACES.US).domain;
    const a = document.createElement("a");
    a.href = `https://www.${domain}/dp/${row.asin}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = row.asin;
    a.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;pointer-events:auto;position:relative;z-index:2";
    a.title = "Open on Amazon";
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener,noreferrer");
      e.preventDefault();
    });
    lAsinLbl.appendChild(a);
  } else {
    lAsinLbl.textContent = "—";
  }
  const fnsku = (row.fnsku || "").toString().trim().toUpperCase();
  $("apx-l-fnsku").textContent = fnsku || "missing";
  $("apx-l-fnsku-input").value = fnsku;
  $("apx-l-qty").value = "1";
  renderPrintSafety();
}

function renderFnskuOptions(options) {
  printState.options = Array.isArray(options) ? options : [];
  const box = $("apx-l-options");
  const selected = $("apx-l-selected");
  box.innerHTML = "";
  if (!printState.options.length) {
    box.classList.add("hidden");
    selected.classList.add("hidden");
    return;
  }
  if (printState.selectedOptionIndex == null || !printState.options[printState.selectedOptionIndex]) printState.selectedOptionIndex = 0;
  const current = printState.options[printState.selectedOptionIndex];
  const unsafe = fnskuBlockReason(current.fnsku, printState.listing?.asin) || (printState.fbaElig && printState.fbaElig.eligible === false);
  const hasPicker = printState.options.length > 1;
  // When there are 2+ FNSKU/condition options (e.g. two SKUs sharing one
  // ASIN), the picker list below already marks the active choice with
  // "✓ Selected" -- showing this summary card on top of it repeated the
  // same FNSKU/SKU/condition a second time right above the picker, which
  // read as a confusing duplicate rather than a confirmation. Only show it
  // when there's a single option and no picker to convey that instead.
  selected.classList.toggle("hidden", !!unsafe || hasPicker);
  selected.innerHTML = (unsafe || hasPicker) ? "" : `Selected for Printing<br><b>${current.fnsku}</b> • ${current.condition || "NEW"}${current.sku ? `<div>SKU: <b>${current.sku}</b></div>` : ""}<div>✓ This FNSKU and condition will be used for the label</div>`;
  if (current.condition) $("apx-l-cond").value = current.condition;
  box.classList.toggle("hidden", printState.options.length <= 1);
  printState.options.forEach((option, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `apx-option${index === printState.selectedOptionIndex ? " selected" : ""}`;
    btn.innerHTML = `<b>${option.fnsku}</b> • ${option.condition || "NEW"}${option.sku ? `<div class="meta">SKU: ${option.sku}</div>` : ""}${index === printState.selectedOptionIndex ? `<div class="meta">✓ Selected</div>` : ""}`;
    btn.addEventListener("click", () => {
      printState.selectedOptionIndex = index;
      const next = printState.options[index];
      printState.listing = { ...printState.listing, fnsku: next.fnsku, condition: next.condition || "NEW", sku: next.sku || printState.listing?.sku };
      renderPrintCard(printState.listing);
      renderFnskuOptions(printState.options);
    });
    box.appendChild(btn);
  });
  renderPrintSafety();
}

$("apx-l-find").addEventListener("click", async () => {
  const asin = ($("apx-l-asin").value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    setStatus("apx-l-find-status", "Enter a valid 10-char ASIN", "err");
    return;
  }
  setStatus("apx-l-find-status", "Searching…");
  $("apx-l-card").classList.add("hidden");
  $("apx-l-form").classList.add("hidden");
  $("apx-l-selected").classList.add("hidden");
  $("apx-l-options").classList.add("hidden");
  printState.options = [];
  printState.selectedOptionIndex = null;
  printState.fbaElig = null;
  const r = await bg("ARBIPRO_FIND_LISTING", { asin });
  if (!r?.ok) { setStatus("apx-l-find-status", r?.error || "Search failed", "err"); return; }
  let listing = r.data || { asin, title: asin, image_url: "" };
  const allRows = Array.isArray(r.data?._allRows) ? r.data._allRows : (r.data ? [r.data] : []);
  setStatus("apx-l-find-status", "Checking FBA eligibility and saved FNSKU options…");
  const [elig, options] = await Promise.all([
    checkFbaEligibility(asin, listing, true).then(normalizeFbaEligibility).catch((e) => ({ eligible: false, fba_block_reason: String(e.message || e), blockingIssues: [{ code: "ELIGIBILITY_CHECK_FAILED", message: String(e.message || e) }] })),
    loadFnskuOptionsLikeWeb(asin, true).catch(() => []),
  ]);
  printState.fbaElig = elig;
  // Pick the FNSKU option matching the chosen SKU when possible.
  const pickForSku = (skuPref) => {
    if (!options.length) return { ...listing, fnsku: null, condition: listing.condition || "NEW", sku: skuPref || listing.sku };
    const match = options.find((o) => o.sku && skuPref && o.sku === skuPref) || options[0];
    printState.selectedOptionIndex = options.indexOf(match);
    return { ...listing, fnsku: match.fnsku, condition: match.condition || listing.condition || "NEW", sku: match.sku || skuPref || listing.sku };
  };
  const renderForRow = (row) => {
    listing = { ...listing, ...row };
    const next = pickForSku(row.sku);
    renderSkuPicker("apx-l-sku-picker", allRows, row.sku, renderForRow);
    renderPrintCard(next);
    renderFnskuOptions(options);
  };
  if (allRows.length > 1) {
    renderForRow(allRows[0]);
  } else {
    listing = options.length
      ? { ...listing, fnsku: options[0].fnsku, condition: options[0].condition || listing.condition || "NEW", sku: options[0].sku || listing.sku }
      : { ...listing, fnsku: null, condition: listing.condition || "NEW" };
    renderPrintCard(listing);
    renderFnskuOptions(options);
  }
  const reason = fnskuBlockReason(listing.fnsku, asin);
  const blocked = elig && elig.eligible === false;
  const ready = !blocked && !reason && isValidFnsku(listing.fnsku);
  setStatus("apx-l-find-status", ready ? "FNSKU ready ✓" : (blocked ? "Blocked: ASIN is using manufacturer barcode, not Amazon FNSKU" : "Not safe to print — no valid Amazon FNSKU found."), ready ? "ok" : "err");
  void checkPrintClient();
});

$("apx-l-asin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("apx-l-find").click();
});

$("apx-l-recheck").addEventListener("click", () => { void checkPrintClient(); });

$("apx-l-fnsku-input").addEventListener("input", (e) => {
  const fnsku = normalizeFnsku(e.target.value);
  e.target.value = fnsku;
  if (!printState.listing) return;
  printState.listing = { ...printState.listing, fnsku };
  $("apx-l-fnsku").textContent = fnsku || "missing";
  renderPrintSafety();
});

$("apx-l-print").addEventListener("click", async () => {
  let row = printState.listing;
  if (!row) { setStatus("apx-l-action-status", "Find a listing first", "err"); return; }
  let fnsku = normalizeFnsku($("apx-l-fnsku-input").value || row.fnsku);
  const elig = await checkFbaEligibility(row.asin, row, true).then(normalizeFbaEligibility).catch((e) => ({ eligible: false, fba_block_reason: String(e.message || e), blockingIssues: [{ code: "ELIGIBILITY_CHECK_FAILED", message: String(e.message || e) }] }));
  printState.fbaElig = elig;
  if (elig && elig.eligible === false) {
    renderPrintSafety();
    setStatus("apx-l-action-status", "Cannot print yet — FBA action required (check readiness panel)", "err");
    return;
  }
  if (fnskuBlockReason(fnsku, row.asin)) {
    renderPrintSafety();
    setStatus("apx-l-action-status", fnskuBlockReason(fnsku, row.asin), "err");
    return;
  }
  if (!isValidFnsku(fnsku)) {
    setStatus("apx-l-action-status", "Checking saved and live Amazon FNSKU options…");
    const options = await loadFnskuOptionsLikeWeb(row.asin, true).catch(() => []);
    if (options.length) {
      const picked = options[0];
      printState.listing = { ...row, fnsku: picked.fnsku, condition: picked.condition || row.condition || "NEW", sku: picked.sku || row.sku };
      row = printState.listing;
      renderPrintCard(printState.listing);
      renderFnskuOptions(options);
      fnsku = picked.fnsku;
    }
  }
  if (fnskuBlockReason(fnsku, row.asin) || !isValidFnsku(fnsku)) {
    renderPrintSafety();
    setStatus("apx-l-action-status", "Cannot print — FNSKU missing or invalid", "err");
    return;
  }
  const qty = Math.max(1, Math.min(100, Number($("apx-l-qty").value) || 0));
  if (!qty) { setStatus("apx-l-action-status", "Quantity must be 1–100", "err"); return; }
  if (!printState.connected) {
    const ok = await checkPrintClient();
    if (!ok) { setStatus("apx-l-action-status", "Print client not running", "err"); return; }
  }
  const settings = loadThermalSettings();
  const condition = printState.options.length ? (row.condition || $("apx-l-cond").value || "NEW") : ($("apx-l-cond").value || "NEW");
  const labels = Array.from({ length: qty }, () => ({
    asin: row.asin,
    fnsku,
    condition,
    title: row.title || row.asin,
  }));
  const payload = {
    sizeId: settings.sizeId,
    dpi: settings.dpi,
    mode: settings.printerLanguage,
    printerName: settings.printerName || undefined,
    labels,
  };
  setStatus("apx-l-action-status", `Sending ${qty} label${qty === 1 ? "" : "s"} to printer…`);
  $("apx-l-print").disabled = true;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(`${printState.clientUrl}/print-labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    if (!res.ok || (parsed && parsed.success === false)) {
      throw new Error(parsed?.error || parsed?.detail || text || `HTTP ${res.status}`);
    }
    const printer = parsed?.printer ? ` (${parsed.printer})` : "";
    setStatus("apx-l-action-status", `Sent ${qty} label${qty === 1 ? "" : "s"}${printer} ✓`, "ok");
  } catch (e) {
    const msg = String(e?.message || e);
    setStatus(
      "apx-l-action-status",
      msg.includes("aborted") || msg.includes("Failed to fetch")
        ? "SprintPrint is not connected. Start it and Recheck."
        : msg,
      "err",
    );
  } finally {
    $("apx-l-print").disabled = false;
  }
});

/* ─── Edit Listing mode ────────────────────────────────────────────
 * Mirrors src/components/listings/EditListingDialog.tsx used by the
 * Created Listings page. Loads the most recent created_listings row
 * for an ASIN (with SKU picker when multiple), lets the user change
 * Total Cost / Units / COG (linked recalc) and supplier links, and
 * PATCHes created_listings by id via ARBIPRO_UPDATE_LISTING.
 */
const edit = {
  row: null,       // currently selected row from ARBIPRO_FIND_LISTING
  allRows: [],     // sibling SKU rows for the picker
  suppliers: [{ link: "", discount_code: "" }],
};

function normalizeSupplierUrl(u) {
  const t = String(u || "").trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function renderEditSuppliers() {
  const wrap = $("apx-e-suppliers");
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = edit.suppliers.length ? edit.suppliers : [{ link: "", discount_code: "" }];
  list.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "apx-supplier-row";
    row.style.cssText = "display:grid;grid-template-columns:1fr auto auto;gap:4px;margin-bottom:4px;align-items:center";
    row.innerHTML = `
      <input data-i="${i}" data-k="link" placeholder="https://supplier..." value="${escapeHtml(s.link || "")}" />
      <button data-open="${i}" title="Open supplier link" class="apx-primary ghost" style="font-size:11px;padding:4px 8px">↗</button>
      <button data-rm="${i}" title="Remove" style="background:transparent;border:1px solid var(--line);color:var(--bad);border-radius:6px;padding:4px 8px;cursor:pointer">×</button>
      <input data-i="${i}" data-k="discount_code" placeholder="Discount code (optional)" value="${escapeHtml(s.discount_code || "")}" style="grid-column:1 / -1" />`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      if (!edit.suppliers[i]) edit.suppliers[i] = { link: "", discount_code: "" };
      edit.suppliers[i][k] = e.target.value;
    });
  });
  wrap.querySelectorAll("button[data-open]").forEach((b) => {
    b.addEventListener("click", () => {
      const i = +b.dataset.open;
      const url = normalizeSupplierUrl(edit.suppliers[i]?.link);
      if (!url) { setStatus("apx-e-action-status", "No supplier link to open", "err"); return; }
      window.open(url, "_blank", "noopener,noreferrer");
    });
  });
  wrap.querySelectorAll("button[data-rm]").forEach((b) => {
    b.addEventListener("click", () => {
      edit.suppliers.splice(+b.dataset.rm, 1);
      if (!edit.suppliers.length) edit.suppliers.push({ link: "", discount_code: "" });
      renderEditSuppliers();
    });
  });
}

$("apx-e-add-supplier")?.addEventListener("click", () => {
  edit.suppliers.push({ link: "", discount_code: "" });
  renderEditSuppliers();
});

function renderEditCard(row) {
  edit.row = row;
  $("apx-e-card").classList.remove("hidden");
  $("apx-e-form").classList.remove("hidden");
  $("apx-e-img").src = row.image_url || "";
  $("apx-e-title").textContent = row.title || "—";
  const asinLbl = $("apx-e-asin-lbl");
  asinLbl.textContent = row.asin || "—";
  $("apx-e-price").textContent = fmtMoney(row.price);
  $("apx-e-sku-lbl").textContent = row.sku || "—";

  // Initial values — Contract A: amount = UNIT cost, cost = TOTAL batch cost
  const units = Number(row.units) || 0;
  const total = row.cost != null ? Number(row.cost) : null;
  const unitCost = (units > 0 && total != null && Number.isFinite(total))
    ? total / units
    : (row.amount != null ? Number(row.amount) : null);
  $("apx-e-totalcost").value = total != null && Number.isFinite(total) ? total.toFixed(2) : "";
  $("apx-e-units").value = units > 0 ? String(units) : "";
  $("apx-e-cog").value = unitCost != null && Number.isFinite(unitCost) ? unitCost.toFixed(2) : "";

  edit.suppliers = Array.isArray(row.supplier_links) && row.supplier_links.length
    ? row.supplier_links.map((s) => ({ link: s?.link || "", discount_code: s?.discount_code || "" }))
    : [{ link: "", discount_code: "" }];
  renderEditSuppliers();
  setStatus("apx-e-action-status", "");
}

function editRecalcFromTotalUnits() {
  const tc = parseFloat($("apx-e-totalcost").value);
  const u = parseInt($("apx-e-units").value, 10);
  if (!isNaN(tc) && !isNaN(u) && u > 0) {
    $("apx-e-cog").value = (tc / u).toFixed(2);
  }
}
function editRecalcFromCogUnits() {
  const c = parseFloat($("apx-e-cog").value);
  const u = parseInt($("apx-e-units").value, 10);
  if (!isNaN(c) && !isNaN(u) && u > 0) {
    $("apx-e-totalcost").value = (c * u).toFixed(2);
  }
}
$("apx-e-totalcost")?.addEventListener("input", editRecalcFromTotalUnits);
$("apx-e-units")?.addEventListener("input", editRecalcFromTotalUnits);
$("apx-e-cog")?.addEventListener("input", editRecalcFromCogUnits);

$("apx-e-find")?.addEventListener("click", async () => {
  const asin = ($("apx-e-asin").value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    setStatus("apx-e-find-status", "Enter a valid 10-char ASIN", "err");
    return;
  }
  setStatus("apx-e-find-status", "Looking up your listing…");
  $("apx-e-card").classList.add("hidden");
  $("apx-e-form").classList.add("hidden");
  $("apx-e-sku-picker").classList.add("hidden");
  const r = await bg("ARBIPRO_FIND_LISTING", { asin });
  if (!r?.ok) { setStatus("apx-e-find-status", r?.error || "Not found in your Created Listings", "err"); return; }
  const row = r.data;
  if (!row) { setStatus("apx-e-find-status", "No listing found for this ASIN in your account", "err"); return; }
  if (!row.id) {
    setStatus("apx-e-find-status", "This ASIN has no Created Listings row yet — use the New Listing tab first.", "err");
    return;
  }
  setStatus("apx-e-find-status", "");
  edit.allRows = Array.isArray(row._allRows) ? row._allRows.filter((r) => r.id) : [row];
  renderSkuPicker("apx-e-sku-picker", edit.allRows, row.sku, (picked) => {
    renderSkuPicker("apx-e-sku-picker", edit.allRows, picked.sku, () => {});
    renderEditCard(picked);
  });
  renderEditCard(row);
});

$("apx-e-cancel")?.addEventListener("click", () => {
  $("apx-e-card").classList.add("hidden");
  $("apx-e-form").classList.add("hidden");
  $("apx-e-sku-picker").classList.add("hidden");
  $("apx-e-asin").value = "";
  setStatus("apx-e-find-status", "");
  setStatus("apx-e-action-status", "");
  edit.row = null;
  edit.allRows = [];
  edit.suppliers = [{ link: "", discount_code: "" }];
});

$("apx-e-save")?.addEventListener("click", async () => {
  if (!edit.row?.id) {
    setStatus("apx-e-action-status", "Find a listing first", "err");
    return;
  }
  const tc = parseFloat($("apx-e-totalcost").value);
  const u = parseInt($("apx-e-units").value, 10);
  const c = parseFloat($("apx-e-cog").value);
  if (isNaN(tc) || tc < 0) { setStatus("apx-e-action-status", "Invalid total cost", "err"); return; }
  if (isNaN(u) || u <= 0) { setStatus("apx-e-action-status", "Invalid units", "err"); return; }
  if (isNaN(c) || c < 0) { setStatus("apx-e-action-status", "Invalid COG", "err"); return; }

  const suppliers = edit.suppliers
    .map((s) => ({ link: String(s.link || "").trim(), discount_code: String(s.discount_code || "").trim() }))
    .filter((s) => s.link);

  $("apx-e-save").disabled = true;
  setStatus("apx-e-action-status", "Saving…");
  const r = await bg("ARBIPRO_UPDATE_LISTING", {
    id: edit.row.id,
    patch: {
      cost: Number(tc.toFixed(2)),
      units: u,
      amount: Number(c.toFixed(4)),
      supplier_links: suppliers,
    },
  });
  $("apx-e-save").disabled = false;
  if (!r?.ok) { setStatus("apx-e-action-status", r?.error || "Save failed", "err"); return; }
  setStatus("apx-e-action-status", "Listing updated ✓", "ok");
  // Refresh the displayed card with the new values.
  const updated = { ...edit.row, cost: tc, units: u, amount: c, supplier_links: suppliers };
  renderEditCard(updated);
});

