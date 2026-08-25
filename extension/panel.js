// Panel UI logic. Receives ASIN_CHANGED from content.js, calls edge functions
// via background.js, renders data, and computes profit/ROI + decision signal.
(function () {
  const CFG = self.ARBIPRO_CFG;
  const $ = (id) => document.getElementById(id);

  const fmtMoney = (n, ccy = "USD") => {
    if (n == null || !isFinite(n)) return "—";
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy }).format(n); }
    catch { return "$" + Number(n).toFixed(2); }
  };
  const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
  // Shared range labels — keep in sync with the data-range buttons in panel.html
  // and the range enum accepted by mobile-scan-price-history.
  const RANGE_LABELS = { "90": "3M", "180": "6M", "365": "1Y", "730": "2Y", "1825": "5Y", "SINCE_LISTED": "Since Listed" };
  const estimateMonthlySales = (intel = {}) => {
    const backendEstimate = Number(intel.est_monthly_sales ?? intel.monthly_sold);
    if (Number.isFinite(backendEstimate) && backendEstimate > 0) return Math.round(backendEstimate);
    const bsr = Number(intel.bsr_current);
    return Number.isFinite(bsr) && bsr > 0 ? Math.max(1, Math.round(100000 * Math.pow(bsr, -0.6))) : null;
  };

  let state = {
    asin: null, marketplace: "US", currency: "USD",
    fees: null, feesRefPrice: null, eligibility: null, stability: null, history: null,
    fbaElig: null, // { eligible, blockingIssues[], warnings[], fba_block_reason }
    fbaComplianceLoading: false, fbaComplianceError: null,
    dims: null,
    cached: false, fetched_at: null, signedIn: false,
    // null = not checked yet, true/false = resolved. Gates admin-only panel
    // affordances (e.g. the decision-JSON debug button) — see checkSession().
    isAdmin: null,
    // True until the current scan's data is fully consistent — see loadData()
    // and renderSellerAmpSkeleton(). Starts true so nothing renders a real
    // (and possibly false-alarm) verdict before the first scan even starts.
    summaryLoading: true,
    range: "90", // '90' (3M) | '180' (6M) | '365' (1Y)
    sellerMode: "FBA", // 'FBA' | 'FBM' — picks correct competitor lane
    // USD -> marketplace currency map (e.g. { CAD: 1.3872, MXN: 17.9, BRL: 5.37 }).
    // Used to convert the USD source cost the user typed into the marketplace
    // currency so Profit / ROI line up with the (foreign-currency) sale price
    // and Amazon fees for CA / MX / BR / GB / DE / etc.
    fxRates: { USD: 1 },
  };

  // Marketplace → default currency. Used to set state.currency immediately on
  // tab switch so the Total-cost USD→local conversion fires without waiting
  // for fetch-listing-snapshot to come back.
  const MARKETPLACE_CURRENCY = {
    US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
    GB: "GBP", UK: "GBP",
    DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR",
    SE: "SEK", PL: "PLN", BE: "EUR", IE: "EUR",
    JP: "JPY", AU: "AUD", IN: "INR", AE: "AED", SA: "SAR",
    SG: "SGD", TR: "TRY", EG: "EGP",
  };
  function currencyForMarketplace(mkt) {
    return MARKETPLACE_CURRENCY[String(mkt || "US").toUpperCase()] || "USD";
  }

  // Marketplace → SP-API MarketplaceId. Forwarded to fetch-listing-snapshot
  // so SP-API returns fees for the SAME marketplace the user is browsing
  // (CA must use CA referral % + CA FBA fulfillment fee in CAD). Without
  // this, fees default to US and under-count CA/MX/BR FBA fulfillment,
  // inflating ROI vs the web Repricer.
  const MARKETPLACE_ID = {
    US: "ATVPDKIKX0DER", CA: "A2EUQ1WTGCTBG2",
    MX: "A1AM78C64UM0Y8", BR: "A2Q3Y263D00KWC",
    GB: "A1F83G8C2ARO7P", UK: "A1F83G8C2ARO7P",
    DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH",
    IT: "APJ6JRA9NG5V4",  ES: "A1RKKUPIHCS9HS",
    NL: "A1805IZSGTT6HS", SE: "A2NODRKZP88ZB9",
    PL: "A1C3SOZRARQ6R3", BE: "AMEN7PMS3EDWL",
    IE: "A28R8C7NBKEWEA", JP: "A1VC38T7YXB528",
    AU: "A39IBJ37TRP1C6", IN: "A21TJRUUN4KGV",
    AE: "A2VIGQ35RCS4UG", SA: "A17E79C6D8DWNP",
    SG: "A19VAU5U5O7RUS", TR: "A33AVAJ2PDY3EV",
    EG: "ARBP9OOSHTCHU",
  };
  function marketplaceIdFor(mkt) {
    return MARKETPLACE_ID[String(mkt || "US").toUpperCase()] || MARKETPLACE_ID.US;
  }

  // Lazy-load FX rates once per panel session. Background reads `fx_rates`
  // (public SELECT) and returns USD->X map. Safe to call repeatedly.
  let fxLoadPromise = null;
  function ensureFxRates() {
    if (fxLoadPromise) return fxLoadPromise;
    fxLoadPromise = bg("ARBIPRO_LOAD_FX", {})
      .then((r) => {
        if (r?.data && typeof r.data === "object") {
          state.fxRates = { USD: 1, ...r.data };
          // Re-render once rates land so the USD→local conversion shows up
          // without requiring the user to retype the cost.
          try { renderRoiAndSignal(); } catch (_) {}
          try { renderSellers(); } catch (_) {}
        }
      })
      .catch((e) => {
        console.debug("[InvSPRNT] fx load failed", e?.message || e);
        fxLoadPromise = null; // allow retry next render
      });
    return fxLoadPromise;
  }

  // Convert a USD-denominated source cost to the active marketplace currency.
  // The "Total cost" input is treated as USD (matches how the rest of the
  // platform stores supplier cost); fees and sale prices already arrive in
  // the marketplace currency, so we only need to lift the cost.
  function convertUsdToMarket(usdAmount) {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) return usdAmount || 0;
    const ccy = String(state.currency || "USD").toUpperCase();
    if (ccy === "USD") return usdAmount;
    const rate = Number(state.fxRates?.[ccy]);
    if (!Number.isFinite(rate) || rate <= 0) return usdAmount; // no rate yet — fall back
    return usdAmount * rate;
  }



  // Decision Memory (Phase 1 data capture). Mirrors web ProductAnalyzer schema.
  // 10-min dedup keyed by asin+marketplace; one decisionId per scan window.
  const DM_DEDUP_MS = 10 * 60 * 1000;
  let dmState = { decisionId: null, key: null, lastLogAt: 0, pending: false, recorded: null };
  // Dedup key for the last brand-history lookup fired — avoids re-querying
  // on every re-render of the same scan.
  let brandHistoryState = { key: null };

  // Pick the price an FBA seller (or FBM seller) would realistically sell at.
  // Default mode FBA: never anchor to an FBM-held Buy Box — that competition
  // doesn't apply to us. Use BB only when BB owner is FBA, else lowest FBA.
  function pickAnchorPrice(offers, mode) {
    const list = Array.isArray(offers) ? offers : [];
    const bbOffer = list.find(o => o.isBuyBox);
    const bb = bbOffer?.landed ?? null;
    const bbIsFba = !!bbOffer?.isFBA;
    const fbaPrices = list.filter(o => o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const fbmPrices = list.filter(o => !o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const lowestFba = fbaPrices.length ? Math.min(...fbaPrices) : null;
    const lowestFbm = fbmPrices.length ? Math.min(...fbmPrices) : null;
    if (mode === "FBM") {
      // FBM competes mainly with FBM (and any FBM-held BB)
      if (bb != null && !bbIsFba) return bb;
      return lowestFbm ?? bb ?? lowestFba ?? null;
    }
    // FBA (default): only trust BB if FBA-held; otherwise FBA-only lane
    if (bb != null && bbIsFba) return bb;
    return lowestFba ?? bb ?? lowestFbm ?? null;
  }

  function getActualFeeTotal(fees) {
    if (!fees) return null;
    const total = Number(fees.totalFees);
    if (Number.isFinite(total) && total > 0) return total;
    const parts = [fees.referralFee, fees.fbaFee, fees.variableClosingFee, fees.otherFees]
      .map((v) => Number(v) || 0);
    const sum = parts.reduce((acc, v) => acc + v, 0);
    return sum > 0 ? sum : null;
  }

  function computeWebStyleRoi(salePrice, unitCost, fees) {
    const baseFees = getActualFeeTotal(fees);
    if (!(salePrice > 0) || !(unitCost > 0) || baseFees == null) {
      return { unitFees: baseFees, profit: null, roi: null, margin: null };
    }
    // If testing a price different from the one Amazon's fee estimate was
    // computed against (Sale override edited away from the default BB
    // price), rescale only the referral-fee portion — it's a % of sale
    // price on Amazon — same approach as the per-seller ROI column in
    // renderSellers(). fbaFee / closing fees are fixed absolute per-unit
    // costs and don't move with price.
    let unitFees = baseFees;
    const refPrice = state.feesRefPrice;
    if (refPrice > 0 && Math.abs(salePrice - refPrice) > 0.005) {
      const refFee = Number(fees?.referralFee) || 0;
      const referralRate = refFee > 0 ? Math.min(0.45, refFee / refPrice) : 0.15;
      const nonReferralFees = baseFees - refFee;
      unitFees = salePrice * referralRate + nonReferralFees;
    }
    const profit = salePrice - unitCost - unitFees;
    return {
      unitFees,
      profit,
      roi: (profit / unitCost) * 100,
      margin: (profit / salePrice) * 100,
    };
  }

  const FEE_RETRY_DELAYS_MS = [2500, 7000, 15000];
  let feeRetryTimer = null;
  let feeRetryKey = null;

  function scheduleFeeRetry(asin, marketplace, attempt = 0) {
    if (!asin || attempt >= FEE_RETRY_DELAYS_MS.length || getActualFeeTotal(state.fees) != null) return;
    const key = `${asin}|${marketplace}`;
    if (feeRetryKey === `${key}|${attempt}`) return;
    feeRetryKey = `${key}|${attempt}`;
    if (feeRetryTimer) clearTimeout(feeRetryTimer);
    feeRetryTimer = setTimeout(async () => {
      try {
        const prod = await bg("ARBIPRO_INVOKE", { fn: "fetch-listing-snapshot", body: { asin, marketplaceId: marketplaceIdFor(marketplace) } }).then(r => r?.data ?? null);
        if (state.asin !== asin || state.marketplace !== marketplace) return;
        const hasFees = getActualFeeTotal(prod?.fees) != null;
        if (hasFees) {
          state.fees = prod.fees;
          state.feesRefPrice = Number.isFinite(Number(prod.price)) && Number(prod.price) > 0 ? Number(prod.price) : state.feesRefPrice;
          renderRoiAndSignal();
          renderSellers();
          renderSellerAmpSummary();
          return;
        }
      } catch (e) {
        console.debug("[InvSPRNT] fee retry failed", e?.message || e);
      }
      if (state.asin === asin && state.marketplace === marketplace && getActualFeeTotal(state.fees) == null) {
        scheduleFeeRetry(asin, marketplace, attempt + 1);
      }
    }, FEE_RETRY_DELAYS_MS[attempt]);
  }

  // Gating (Eligibility/Status + FBA Compliance) comes from a LIVE Amazon
  // SP-API restrictions check every single time fetch-listing-snapshot
  // runs — there's no server-side cache to bypass, so pressing "Recheck"
  // doesn't do anything a plain re-fetch wouldn't. The reason it "fixes"
  // things is purely TIMING: Amazon's restrictions API has its own
  // eventual-consistency lag right after a real approval, and our own
  // seller-account override (checked against inventory/created_listings/
  // repricer_assignments — see fetch-listing-snapshot/index.ts) can miss
  // a just-created row by a few seconds. The Create Listing tool calls this
  // exact same endpoint — it only LOOKS more "in sync" because it happens to
  // be checked a little later. This auto-retry closes that gap without
  // requiring a manual click: one-time-per-scan, and only while the
  // selected marketplace isn't already "approved".
  const GATING_RETRY_DELAYS_MS = [4000, 10000, 20000];
  let gatingRetryTimer = null;
  let gatingRetryKey = null;

  function scheduleGatingRetry(asin, marketplace, attempt = 0) {
    if (!asin || attempt >= GATING_RETRY_DELAYS_MS.length || selectedMarketplaceGatingStatus() === "approved") return;
    const key = `${asin}|${marketplace}`;
    if (gatingRetryKey === `${key}|${attempt}`) return;
    gatingRetryKey = `${key}|${attempt}`;
    if (gatingRetryTimer) clearTimeout(gatingRetryTimer);
    gatingRetryTimer = setTimeout(async () => {
      try {
        const prod = await bg("ARBIPRO_INVOKE", { fn: "fetch-listing-snapshot", body: { asin, marketplaceId: marketplaceIdFor(marketplace) } }).then(r => r?.data ?? null);
        if (state.asin !== asin || state.marketplace !== marketplace) return;
        if (prod) {
          // Same clear-then-apply pattern as the main fetch (loadData) so a
          // stale prior gate never survives a retry that returns nothing.
          state.product = state.product || {};
          delete state.product.marketplaceGating;
          delete state.product.gatingStatus;
          if (prod.gatingStatus) state.product.gatingStatus = prod.gatingStatus;
          if (Array.isArray(prod.marketplaceGating)) state.product.marketplaceGating = prod.marketplaceGating;
          renderMeta(); renderEligibility(); renderFbaEligibility(); renderFbaCompliance(); renderSellerAmpSummary();
        }
      } catch (e) {
        console.debug("[InvSPRNT] gating retry failed", e?.message || e);
      }
      if (state.asin === asin && state.marketplace === marketplace && selectedMarketplaceGatingStatus() !== "approved") {
        scheduleGatingRetry(asin, marketplace, attempt + 1);
      }
    }, GATING_RETRY_DELAYS_MS[attempt]);
  }

  const MARKETPLACES = {
    US: { id: "ATVPDKIKX0DER" }, CA: { id: "A2EUQ1WTGCTBG2" }, MX: { id: "A1AM78C64UM0Y8" }, BR: { id: "A2Q3Y263D00KWC" },
    GB: { id: "A1F83G8C2ARO7P" }, UK: { id: "A1F83G8C2ARO7P" }, DE: { id: "A1PA6795UKMFR9" }, FR: { id: "A13V1IB3VIYZZH" },
    IT: { id: "APJ6JRA9NG5V4" }, ES: { id: "A1RKKUPIHCS9HS" }, JP: { id: "A1VC38T7YXB528" },
  };

  // Mirrors extension-create/panel.js: missing INVALID_FNSKU alone is a
  // propagation warning, not an approval/FBA hard block.
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

  function postHost(msg) {
    parent.postMessage({ source: "arbipro-panel", ...msg }, "*");
  }

  // ── Background bridge ──────────────────────────────────────────────
  // Hardened: timeout + auto-retry wakes the MV3 service worker when it sleeps.
  // Prevents the "have to disable/re-enable the extension" symptom.
  const bg = (type, extra = {}, { timeoutMs = 8000, retries = 1 } = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      const attempt = (left) => {
        let timer = setTimeout(() => {
          if (settled) return;
          if (left > 0) return attempt(left - 1);
          finish(reject, new Error("bg_timeout"));
        }, timeoutMs);
        try {
          chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
            clearTimeout(timer);
            const lastErr = chrome.runtime.lastError;
            if (lastErr) {
              // "message port closed" / SW restart → retry once silently
              if (left > 0) return attempt(left - 1);
              return finish(reject, new Error(lastErr.message || "runtime_error"));
            }
            if (!resp?.ok) {
              const err = String(resp?.error || "bg error");
              if (/not signed in|refresh \d|jwt|invalid token|expired/i.test(err)) {
                setTimeout(() => checkSession(), 0);
              }
              return finish(reject, new Error(err));
            }
            finish(resolve, resp);
          });
        } catch (e) {
          clearTimeout(timer);
          if (left > 0) return attempt(left - 1);
          finish(reject, e instanceof Error ? e : new Error(String(e)));
        }
      };
      attempt(retries);
    });

  async function checkSession() {
    const wasSignedIn = state.signedIn;
    try {
      const { session } = await bg("ARBIPRO_GET_SESSION");
      state.signedIn = !!session?.access_token;
    } catch { state.signedIn = false; }
    $("apx-signin").classList.toggle("hidden", state.signedIn);
    $("apx-content").classList.toggle("hidden", !state.signedIn);
    if (state.signedIn && !wasSignedIn && state.asin) {
      loadData(true);
    }
    if (state.signedIn && state.isAdmin === null) {
      checkAdminStatus();
    } else if (!state.signedIn) {
      state.isAdmin = null;
      applyAdminOnlyVisibility();
    }
  }

  // Admin-only panel affordances (currently: the decision-JSON debug
  // button). Resolved once per sign-in via the same RLS-scoped user_roles
  // self-read the web app's admin settings pages already rely on.
  async function checkAdminStatus() {
    try {
      const r = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "ARBIPRO_CHECK_ADMIN" }, resolve));
      state.isAdmin = !!(r?.ok && r.isAdmin);
    } catch (e) {
      console.warn("[apx] admin check failed", e?.message || e);
      state.isAdmin = false;
    }
    applyAdminOnlyVisibility();
  }

  function applyAdminOnlyVisibility() {
    const debugBtn = $("apx-fd-copy-debug");
    if (debugBtn) debugBtn.hidden = !state.isAdmin;
  }

  // ── Per-ASIN cache (chrome.storage.local, 10 min) ──────────────────
  const cacheKey = (a, m, r) => `cache:v7:${m}:${a}:r${r}`;
  async function readCache(a, m, r) {
    const k = cacheKey(a, m, r);
    const obj = await chrome.storage.local.get(k);
    const entry = obj[k];
    if (!entry) return null;
    if (Date.now() - entry.t > CFG.CACHE_TTL_MS) return null;
    return entry.v;
  }
  async function writeCache(a, m, r, v) {
    await chrome.storage.local.set({ [cacheKey(a, m, r)]: { t: Date.now(), v } });
  }

  // ── Cost persistence per ASIN (DB-backed, with local cache fallback) ─
  const costKey = (a) => `cost:${a}`;
  async function loadCost(a) {
    // 1) instant local cache for snappy UI
    const o = await chrome.storage.local.get(costKey(a));
    const local = o[costKey(a)] || { totalCost: "", units: "1", salePrice: "" };
    // 2) authoritative DB value (overrides local if present)
    if (state.signedIn) {
      try {
        const r = await new Promise((resolve, reject) =>
          chrome.runtime.sendMessage({ type: "ARBIPRO_LOAD_COST", asin: a }, (resp) =>
            resp?.ok ? resolve(resp.data) : reject(new Error(resp?.error || "load failed")),
          ),
        );
        if (r) {
          const remote = {
            totalCost: r.total_cost != null ? String(r.total_cost) : local.totalCost,
            units: r.units != null ? String(r.units) : (local.units || "1"),
            salePrice: r.sale_price_override != null ? String(r.sale_price_override) : local.salePrice,
          };
          await chrome.storage.local.set({ [costKey(a)]: remote });
          return remote;
        }
      } catch (e) {
        // Silent fallback: missing row / not-signed-in / transient network
        // shouldn't surface as a console error. Local cache is used instead.
        const msg = (e?.message || "").toLowerCase();
        const benign = !msg || msg.includes("load failed") || msg.includes("not signed") ||
          msg.includes("no row") || msg.includes("auth") || msg.includes("network") ||
          msg.includes("fetch");
        if (!benign) console.debug("[InvSPRNT] loadCost db", e?.message || String(e));
      }
    }
    return local;
  }
  let saveCostTimer = null;
  async function saveCost(a, v) {
    await chrome.storage.local.set({ [costKey(a)]: v });
    if (!state.signedIn) return;
    clearTimeout(saveCostTimer);
    saveCostTimer = setTimeout(() => {
      const totalCost = v.totalCost === "" ? null : Number(v.totalCost);
      const units = v.units === "" ? 1 : parseInt(v.units, 10) || 1;
      const sale = v.salePrice === "" ? null : Number(v.salePrice);
      const row = {
        asin: a,
        barcode: a, // keep parity with mobile scan history convention
        total_cost: Number.isFinite(totalCost) ? totalCost : null,
        units,
        sale_price_override: Number.isFinite(sale) ? sale : null,
      };
      chrome.runtime.sendMessage({ type: "ARBIPRO_SAVE_COST", row }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) { console.warn("[InvSPRNT] saveCost bridge", err.message); return; }
        if (!r?.ok) console.warn("[InvSPRNT] saveCost db", r?.error);
      });
    }, 600);
  }

  // ── Render helpers ─────────────────────────────────────────────────
  function renderMeta() {
    $("apx-asin").textContent = state.asin || "—";
    $("apx-mkt").textContent = state.marketplace;
    if (state.asin) {
      const analyzerUrl = `${CFG.APP_URL}/tools/product-analyzer?asin=${state.asin}&marketplace=${state.marketplace}`;
      const analyzerBtn = $("apx-open-analyzer-btn");
      if (analyzerBtn) analyzerBtn.href = analyzerUrl;
      const historyBtn = $("apx-open-history-btn");
      if (historyBtn) historyBtn.href = `${CFG.APP_URL}/tools/scan-history?asin=${state.asin}&marketplace=${state.marketplace}`;
    }
  }

  function renderFbaEligibility() {
    const box = document.getElementById("apx-fba-elig");
    if (!box) return;
    const e = state.fbaElig;
    if (!e) { box.style.display = "none"; box.innerHTML = ""; return; }

    const infos = e.infos || [];
    const marketplaceApproved = selectedMarketplaceGatingStatus() === "approved";
    const sellabilityCodes = new Set(["RESTRICTED", "NOT_ELIGIBLE", "APPROVAL_REQUIRED", "ASIN_NOT_ELIGIBLE", "BRAND_NOT_ELIGIBLE", "RESTRICTION"]);
    const blocks = (e.blockingIssues || []).filter((i) =>
      !(marketplaceApproved && sellabilityCodes.has(String(i.code || "").toUpperCase()))
    );
    const propagating = infos.find((i) => String(i.code || "").toUpperCase() === "FNSKU_PROPAGATING");
    const pending = infos.find((i) => String(i.code || "").toUpperCase() === "FNSKU_PENDING_LISTING_CREATION");
    const hardBlock = blocks.length > 0;

    if (hardBlock) {
      const issues = blocks.map((i) => `• [${i.code}] ${i.message}`).join("<br>");
      box.style.display = "block";
      box.style.cssText = "display:block;margin:6px 0;padding:8px;border:1px solid #f87171;background:#fef2f2;color:#7f1d1d;border-radius:6px;font-size:11px;line-height:1.4;";
      box.innerHTML = `<strong>⛔ FBA action required</strong><br>Amazon returned a specific restriction or barcode-mode issue. Resolve the item(s) below before sending inventory.<br><br>${issues}`;
    } else if (propagating) {
      box.style.display = "block";
      box.style.cssText = "display:block;margin:6px 0;padding:8px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:6px;font-size:11px;line-height:1.4;";
      box.innerHTML = `<strong>⏳ Waiting for Amazon FNSKU propagation</strong><br>${propagating.message || "Typically 15 min – 24 h after listing creation."} You can continue sourcing — labels & shipments will work once Amazon assigns it.`;
    } else if (pending) {
      box.style.display = "block";
      box.style.cssText = "display:block;margin:6px 0;padding:8px;border:1px solid #38bdf8;background:#f0f9ff;color:#075985;border-radius:6px;font-size:11px;line-height:1.4;";
      box.innerHTML = `<strong>ℹ️ FNSKU pending</strong><br>Amazon will mint the FNSKU after you create the FBA listing.`;
      } else if (e.eligible) {
      const stages = Array.isArray(e.stageStatuses) ? e.stageStatuses : [];
      const sellStage = stages.find((s) => String(s.stage || "").toLowerCase() === "sellability");
      const sellOk = marketplaceApproved || !sellStage || String(sellStage.status || "").toLowerCase() === "ok";
      const host = approvalHost(state.marketplace);
      const applyUrl = `https://${host}/hz/approvalrequest/restrictions/approve?asin=${encodeURIComponent(state.asin || "")}&itemcondition=new&ref_=xx_addlisting_dnav_xx`;
      box.style.display = "block";
      if (sellOk) {
        box.style.cssText = "display:block;margin:6px 0;padding:6px 8px;border:1px solid #34d399;background:#ecfdf5;color:#065f46;border-radius:6px;font-size:11px;line-height:1.4;";
        box.innerHTML = `<strong>✓ Approved by Amazon</strong> — no New-condition listing restrictions returned for this marketplace.`;
      } else {
        box.style.cssText = "display:block;margin:6px 0;padding:8px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:6px;font-size:11px;line-height:1.4;";
        box.innerHTML = `<strong>⚠️ Verify on Amazon</strong><br>${esc(sellStage?.reason || "No SP-API restriction returned — approval may still be required at listing time.")}<br><a href="${applyUrl}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;padding:4px 8px;background:#f59e0b;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Apply for approval →</a>`;
      }
    } else {
      box.style.display = "none"; box.innerHTML = "";
    }
  }

  const FBA_STAGE_LABEL = {
    sellability: "Sellable on Amazon",
    listing_creation: "Listing Creation Allowed",
    fba_eligibility: "FBA Eligible",
    hazmat: "Hazmat / Dangerous Goods",
    prep: "Prep Required",
    inbound_dry_run: "Inbound Dry-Run Tested",
  };
  const FBA_STAGE_HINT = {
    sellability: "Restrictions, gating, approval requirements",
    listing_creation: "Barcode mode, FNSKU readiness",
    fba_eligibility: "Item Preview eligibility for FBA",
    hazmat: "Dangerous goods classification & meltable flag",
    prep: "Polybag, bubble wrap, taping, labeling",
    inbound_dry_run: "Simulated shipment plan (on-demand only)",
  };
  // Direct YES/NO answer per stage. Hazmat inverts polarity: ok = "no hazmat"
  // = NO (good). Other stages: ok = capability available = YES (good).
  function fbaStageAnswer(stage, status) {
    if (status === "unknown") {
      if (stage === "inbound_dry_run") return { text: "NOT TESTED", tone: "unknown" };
      return { text: "NOT CHECKED", tone: "unknown" };
    }
    const inverted = stage === "hazmat";
    if (inverted) {
      if (status === "ok") return { text: "NO", tone: "good" };
      if (status === "warn") return { text: "CAUTION", tone: "warn" };
      return { text: "YES", tone: "bad" };
    }
    if (status === "ok") return { text: "YES", tone: "good" };
    if (status === "warn") return { text: "CAUTION", tone: "warn" };
    return { text: "NO", tone: "bad" };
  }
  function deriveFbaStages(resp) {
    if (!resp) return [];
    if (Array.isArray(resp.stageStatuses) && resp.stageStatuses.length) {
      const marketplaceApproved = selectedMarketplaceGatingStatus() === "approved";
      return resp.stageStatuses.map((s) =>
        marketplaceApproved && String(s.stage || "").toLowerCase() === "sellability" && String(s.status || "").toLowerCase() !== "blocked"
          ? { ...s, status: "ok", reason: "Approved for New condition in the selected marketplace." }
          : s,
      );
    }
    const blocks = resp.blockingIssues || [];
    const warns = resp.warnings || [];
    const infos = resp.infos || [];
    const findCode = (rows, codes) => rows.find((i) => codes.includes(String(i.code || "").toUpperCase()));
    const sellBlock = findCode(blocks, ["RESTRICTED", "NOT_ELIGIBLE", "APPROVAL_REQUIRED"]);
    const barcodeBlock = findCode(blocks, ["MANUFACTURER_BARCODE_MODE"]);
    const fnskuWarn = findCode(warns, ["INVALID_FNSKU"]);
    const fnskuPropagating = findCode(infos, ["FNSKU_PROPAGATING"]);
    return [
      sellBlock ? { stage: "sellability", status: "blocked", reason: sellBlock.message } : { stage: "sellability", status: "ok", reason: "No sellability blocks detected." },
      barcodeBlock
        ? { stage: "listing_creation", status: "blocked", reason: barcodeBlock.message }
        : fnskuPropagating
          ? { stage: "listing_creation", status: "ok", reason: fnskuPropagating.message }
          : fnskuWarn
            ? { stage: "listing_creation", status: "warn", reason: fnskuWarn.message }
            : { stage: "listing_creation", status: "ok", reason: "No listing-creation blocks detected." },
      { stage: "fba_eligibility", status: "unknown", reason: "Not verified yet." },
      { stage: "hazmat", status: "unknown", reason: "Not verified yet." },
      { stage: "prep", status: "unknown", reason: "Not verified yet." },
      { stage: "inbound_dry_run", status: "unknown", reason: "Run on demand from shipment tools." },
    ];
  }
  function renderFbaCompliance() {
    const box = $("apx-fba-compliance");
    if (!box) return;
    const stages = deriveFbaStages(state.fbaElig);
    const loading = state.fbaComplianceLoading;
    const error = state.fbaComplianceError;
    box.classList.remove("hidden");
    const checked = state.fbaElig?.checked_at ? new Date(state.fbaElig.checked_at).toLocaleString() : "";
    const rows = stages.map((s) => {
      const status = ["ok", "warn", "blocked", "unknown"].includes(s.status) ? s.status : "unknown";
      const { text, tone } = fbaStageAnswer(s.stage, status);
      return `<div class="apx-fba-row">
        <div class="apx-fba-main">
          <div class="apx-fba-k">${esc(FBA_STAGE_LABEL[s.stage] || s.stage)}</div>
          <div class="apx-fba-hint">${esc(FBA_STAGE_HINT[s.stage] || "Amazon SP-API verification")}</div>
          ${s.reason ? `<div class="apx-fba-reason">${esc(s.reason)}</div>` : ""}
        </div>
        <span class="apx-fba-status ${tone}">${esc(text)}</span>
      </div>`;
    }).join("");
    box.innerHTML = `<div class="apx-fba-head">
      <div>
        <div class="apx-fba-title">🛡️ FBA Compliance & Hazmat</div>
        <div class="apx-fba-source"><span class="apx-fba-badge">Source: Amazon SP-API</span>${state.fbaElig?.cached && checked ? `<span>Cached · ${checked}</span>` : checked ? `<span>Checked · ${checked}</span>` : ""}</div>
      </div>
    </div>
    ${error ? `<div class="apx-fba-error">Amazon check unavailable: ${esc(error)}</div>` : ""}
    ${!stages.length ? `<div class="apx-fba-empty">${loading ? "Checking Amazon…" : "Amazon compliance check has not run yet."}</div>` : `<div class="apx-fba-list">${rows}</div>`}`;
    // The Recheck button now lives in the top meta row (next to ASIN/Market/
    // Status) instead of down here — it's a single shared control, so just
    // reflect loading state on it rather than regenerating it per-render.
    const metaBtn = $("apx-meta-recheck");
    if (metaBtn) {
      metaBtn.disabled = loading;
      metaBtn.textContent = loading ? "Checking…" : "Recheck";
    }
  }

  function approvalHost(mkt) {
    const m = String(mkt || "US").toUpperCase();
    const map = {
      US: "sellercentral.amazon.com",
      CA: "sellercentral.amazon.ca",
      MX: "sellercentral.amazon.com.mx",
      BR: "sellercentral.amazon.com.br",
      UK: "sellercentral.amazon.co.uk",
      GB: "sellercentral.amazon.co.uk",
      DE: "sellercentral.amazon.de",
      FR: "sellercentral.amazon.fr",
      IT: "sellercentral.amazon.it",
      ES: "sellercentral.amazon.es",
      NL: "sellercentral.amazon.nl",
      SE: "sellercentral.amazon.se",
      PL: "sellercentral.amazon.pl",
      JP: "sellercentral.amazon.co.jp",
      AU: "sellercentral.amazon.com.au",
      AE: "sellercentral.amazon.ae",
      SA: "sellercentral.amazon.sa",
      IN: "sellercentral.amazon.in",
      SG: "sellercentral.amazon.sg",
      TR: "sellercentral.amazon.com.tr",
    };
    return map[m] || "sellercentral.amazon.com";
  }

  // Public storefront link for a seller row — reuses approvalHost()'s
  // per-marketplace TLD map (swapping "sellercentral." for "www.") instead
  // of duplicating the marketplace->domain list a second time.
  function sellerStorefrontUrl(sellerId, marketplace) {
    if (!sellerId) return null;
    const host = approvalHost(marketplace).replace(/^sellercentral\./, "www.");
    return `https://${host}/sp?ie=UTF8&seller=${encodeURIComponent(sellerId)}`;
  }

  function selectedMarketplaceGatingStatus() {
    const code = String(state.marketplace || "US").toUpperCase();
    const gates = Array.isArray(state.product?.marketplaceGating) ? state.product.marketplaceGating : [];
    const gate = gates.find((g) => String(g.marketplace || "").toUpperCase() === code);
    const status = String(gate?.status || state.product?.gatingStatus || "").toUpperCase();
    if (status === "APPROVED" || status === "ELIGIBLE") return "approved";
    if (status === "APPROVAL_REQUIRED" || status === "NEEDS_APPROVAL" || status === "GATED") return "approval_required";
    if (status === "RESTRICTED" || status === "NOT_ELIGIBLE" || status === "INELIGIBLE") return "restricted";
    return null;
  }

  function renderMarketplaceGatingChips() {
    const chipsWrap = $("apx-mkt-chips");
    if (!chipsWrap) return;
    chipsWrap.innerHTML = "";
    const list = (state.product?.marketplaceGating || []).filter((g) =>
      g.status !== "NO_SELLER_AUTH" && g.status !== "NOT_CONNECTED"
    );
    for (const g of list) {
      const chip = document.createElement("span");
      const cls = g.status === "APPROVED" || g.status === "ELIGIBLE" ? "ok"
                : g.status === "APPROVAL_REQUIRED" ? "req" : "bad";
      chip.className = `apx-mkt-chip ${cls}`;
      chip.textContent = `${g.flag || ""} ${g.marketplace || g.name}: ${g.status}`;
      chipsWrap.appendChild(chip);
    }
  }

  function renderEligibility() {
    const el = $("apx-elig");
    el.className = "apx-pill apx-elig-badge";
    renderMarketplaceGatingChips();

    // SOURCE OF TRUTH: per-marketplace gating from `fetch-listing-snapshot`
    // (same source the web Create Listing tool uses). The legacy
    // `state.eligibility` value (from `check-product-eligibility` with global
    // env-var seller) is intentionally NOT used here — it answered for the
    // wrong seller account and produced false "Apply →" banners on ASINs the
    // user is actually approved to sell.
    const gates = Array.isArray(state.product?.marketplaceGating) ? state.product.marketplaceGating : [];
    const productLoaded = !!state.product;
    const gateForMarket = selectedMarketplaceGatingStatus();
    const e = (gateForMarket || "").toLowerCase();

    if (!productLoaded || (!gateForMarket && gates.length === 0)) {
      el.innerHTML = "⏳ Checking…";
      el.classList.add("apx-elig-unknown");
      return;
    }

    if (e === "approved" || e === "eligible") {
      el.innerHTML = "✅ Approved";
      el.classList.add("apx-elig-approved");
    } else if (e === "restricted" || e === "not_eligible" || e === "ineligible") {
      el.innerHTML = "⛔ Restricted";
      el.classList.add("apx-elig-restricted");
    } else if (e === "approval_required" || e === "needs_approval" || e === "gated") {
      const host = approvalHost(state.marketplace);
      const url = `https://${host}/hz/approvalrequest/restrictions/approve?asin=${encodeURIComponent(state.asin || "")}&itemcondition=new&ref_=xx_addlisting_dnav_xx`;
      el.innerHTML = `⚠️ Needs Approval <a href="${url}" target="_blank" rel="noopener" class="apx-approval-btn" title="Apply for approval on Seller Central">Apply →</a>`;
      el.classList.add("apx-elig-needs");
    } else {
      // Gating exists but no row for selected marketplace, or NO_AUTH/ERROR.
      // Don't render "Apply" — surface unknown instead.
      el.innerHTML = "Eligibility N/A";
      el.classList.add("apx-elig-unknown");
    }
  }

  // Compute swing% from currently selected history range so the verdict
  // reacts to 3M / 6M / 1Y selection (matches Keepa stability classify thresholds).
  function computeSwingFromHistory() {
    const series = state.history?.series?.buybox || state.history?.series?.newPrice || [];
    const ys = series.map((p) => p.v).filter((v) => Number.isFinite(v) && v > 0);
    if (ys.length < 3) return null;
    const min = Math.min(...ys), max = Math.max(...ys);
    const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
    if (avg <= 0) return null;
    return ((max - min) / avg) * 100;
  }
  function effectiveStability() {
    const swing = computeSwingFromHistory();
    if (swing == null) return state.stability;
    let verdict = "unknown";
    if (swing <= 10) verdict = "stable";
    else if (swing <= 25) verdict = "moderate";
    else verdict = "volatile";
    return {
      ...(state.stability || {}),
      intel: state.stability?.intel || {},
      swing_pct: swing,
      verdict,
    };
  }
  function renderStability() {
    const intel = state.stability?.intel || {};
    $("apx-bsr").textContent = intel.bsr_current?.toLocaleString?.() ?? "—";
    $("apx-amz").textContent = intel.amazon_presence_pct != null ? `${Math.round(intel.amazon_presence_pct)}%` : "—";
    const fba = intel.sellers_fba ?? "—", fbm = intel.sellers_fbm ?? "—";
    $("apx-sellers").textContent = `${fba} / ${fbm}`;
    const swing = computeSwingFromHistory() ?? state.stability?.swing_pct;
    $("apx-swing").textContent = swing != null ? `${swing.toFixed(1)}%` : "—";
    const sales = estimateMonthlySales(intel);
    { const _b = $("apx-sa-sales-bar"); if (_b) _b.textContent = sales ? sales.toLocaleString() + "/mo" : "—"; }
  }

  // ── Dimensions & weight ────────────────────────────────────────────
  function fmtDimUnit(u) {
    if (!u) return "";
    const s = String(u).toLowerCase();
    if (s.startsWith("centim")) return "cm";
    if (s.startsWith("millim")) return "mm";
    if (s.startsWith("inch")) return "in";
    if (s.startsWith("meter")) return "m";
    return s;
  }
  function fmtWtUnit(u) {
    if (!u) return "";
    const s = String(u).toLowerCase();
    if (s.startsWith("gram")) return "g";
    if (s.startsWith("kilo")) return "kg";
    if (s.startsWith("pound")) return "lb";
    if (s.startsWith("ounce")) return "oz";
    return s;
  }
  function fmtDims(l, w, h, unit) {
    const parts = [l, w, h].filter((n) => Number.isFinite(n) && n > 0);
    if (parts.length === 0) return "—";
    const u = fmtDimUnit(unit);
    return parts.map((n) => +(+n).toFixed(2)).join(" × ") + (u ? " " + u : "");
  }
  function fmtWt(n, unit) {
    if (!Number.isFinite(n) || n <= 0) return "—";
    return (+n).toFixed(2) + " " + (fmtWtUnit(unit) || "");
  }
  function renderDims() {
    const d = state.dims;
    const pkgEl = $("apx-dims-pkg"), pkgWtEl = $("apx-dims-pkg-wt");
    const itemEl = $("apx-dims-item"), itemWtEl = $("apx-dims-item-wt");
    const srcEl = $("apx-dims-source");
    // Guard every element, matching setChip's `if (!el) return`. These five
    // were dereferenced directly (`pkgEl.textContent = "—"`), so a single
    // missing id -- or being called before the panel DOM is mounted -- threw a
    // TypeError. renderDims is 7th of 11 in renderAll(), so that throw took
    // renderFbaEligibility, renderFbaCompliance, renderRoiAndSignal and
    // renderSellerAmpSummary down with it: Eligible to list, Private-label
    // risk, Active alerts and Decision Confidence all blank while everything
    // rendered before it showed data. Observed 2026-08-23.
    if (!pkgEl || !pkgWtEl || !itemEl || !itemWtEl || !srcEl) return;
    if (!d) {
      pkgEl.textContent = "—"; pkgWtEl.textContent = "—";
      itemEl.textContent = "—"; itemWtEl.textContent = "—";
      srcEl.textContent = "—";
      return;
    }
    pkgEl.textContent = fmtDims(d.package_length, d.package_width, d.package_height, d.package_dim_unit);
    pkgWtEl.textContent = fmtWt(d.package_weight, d.package_weight_unit);
    itemEl.textContent = fmtDims(d.item_length, d.item_width, d.item_height, d.item_dim_unit);
    itemWtEl.textContent = fmtWt(d.item_weight, d.item_weight_unit);
    const srcLabel = d.cached ? "Cache" : (d.source === "spapi" ? "Amazon Catalog" : d.source === "keepa" ? "Keepa" : "—");
    const when = d.fetched_at ? new Date(d.fetched_at).toLocaleString() : "";
    srcEl.textContent = when ? `Source: ${srcLabel} · ${when}` : `Source: ${srcLabel}`;
    srcEl.title = `Dimensions source: ${srcLabel}${when ? ` — last updated ${when}` : ""}`;
  }

  function renderHistory() {
    const offers = state.history?.offers?.list || [];
    const fba = offers.filter(o => o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const fbm = offers.filter(o => !o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const bb = offers.find(o => o.isBuyBox)?.landed;
    // Same unguarded pattern as renderDims had. renderHistory is 4th of 11, so
    // a throw here would blank seven renderers rather than four.
    if (!$("apx-bb") || !$("apx-fba") || !$("apx-fbm")) return;
    $("apx-bb").textContent = fmtMoney(bb, state.currency);
    $("apx-fba").textContent = fba.length ? fmtMoney(Math.min(...fba), state.currency) : "—";
    $("apx-fbm").textContent = fbm.length ? fmtMoney(Math.min(...fbm), state.currency) : "—";
    if (state.fetched_at) {
      $("apx-cached").textContent = (state.cached ? "cached · " : "") + new Date(state.fetched_at).toLocaleTimeString();
    }
  }

  function renderRoiAndSignal() {
    const totalCostInput = parseFloat($("apx-cost").value) || 0;
    const units = Math.max(1, parseInt($("apx-units").value || "1", 10));
    const unitCostUsd = totalCostInput > 0 ? totalCostInput / units : 0;
    // For non-US marketplaces, convert the USD source cost into the
    // marketplace currency so Profit/ROI are computed in the same currency
    // as the Amazon sale price and fees (which come back in local currency).
    // No conversion happens when currency is USD or FX hasn't loaded yet.
    const unitCost = convertUsdToMarket(unitCostUsd);
    if (state.currency && state.currency !== "USD" && unitCostUsd > 0) ensureFxRates();
    const f = state.fees || null;
    const offers = state.history?.offers?.list || [];
    const bb = offers.find(o => o.isBuyBox)?.landed ?? null;
    // Anchor to the lane that actually matches our fulfillment (FBA vs FBM).
    // For an FBA seller, an FBM-held Buy Box is NOT our competition.
    const fallbackPrice = pickAnchorPrice(offers, state.sellerMode);
    // Sale field is read-only and always reflects the freshly-retrieved Buy
    // Box price — never a stale/persisted value from a previous session.
    const salePrice = bb != null ? bb : fallbackPrice;
    $("apx-sale").value = salePrice != null ? salePrice.toFixed(2) : "";
    const { unitFees, profit, roi } = computeWebStyleRoi(salePrice, unitCost, f);
    const feesAvailable = unitFees != null;
    // CRITICAL: never compute ROI without real Amazon fees — would inflate ROI.
    // Matches web `calculate-roi` behavior, which surfaces a fee error instead
    // of returning a fake number.
    const showFxHint = state.currency && state.currency !== "USD" && unitCostUsd > 0 && unitCost !== unitCostUsd;
    const unitCostText = unitCost > 0 ? fmtMoney(unitCost, state.currency) : "—";
    $("apx-unit-cost").textContent = showFxHint
      ? `${unitCostText} (≈ ${fmtMoney(unitCostUsd, "USD")})`
      : unitCostText;
    // Inline hint right under the Total cost input — shows the converted
    // marketplace-currency equivalent of the USD value the user typed.
    const convHintEl = $("apx-cost-converted");
    if (convHintEl) {
      if (showFxHint && totalCostInput > 0) {
        const totalConverted = convertUsdToMarket(totalCostInput);
        convHintEl.textContent = `≈ ${fmtMoney(totalConverted, state.currency)} (sale currency)`;
      } else {
        convHintEl.textContent = "";
      }
    }
    $("apx-fees").textContent = feesAvailable ? fmtMoney(unitFees, state.currency) : "fees unavailable";
    $("apx-profit").textContent = profit != null ? fmtMoney(profit, state.currency) : "—";
    $("apx-roi-out").textContent = roi != null ? roi.toFixed(0) + "%" : "—";

    // Sanity warning when ROI looks unrealistic (likely placeholder cost)
    const warn = $("apx-cost-warn");
    if (!feesAvailable && unitCost > 0 && salePrice != null) {
      warn.textContent = "⚠️ Amazon Fees API is temporarily throttled. ROI will auto-fill as soon as fees return; no manual refresh needed.";
      warn.classList.remove("hidden");
    } else if (roi != null && roi > 200 && unitCost > 0 && unitCost < 3 && salePrice != null) {
      warn.textContent = `⚠️ ROI ${roi.toFixed(0)}% looks too good — unit cost is only ${fmtMoney(unitCost, state.currency)}. Did you enter your real source cost?`;
      warn.classList.remove("hidden");
    } else if (showFxHint) {
      const rate = state.fxRates?.[state.currency];
      warn.textContent = `💱 Total cost treated as USD and converted to ${state.currency} at 1 USD = ${(+rate).toFixed(4)} for accurate ROI in this marketplace.`;
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
    }

    const sig = self.computeDecisionSignal(effectiveStability(), {
      profit, roi, hasCost: unitCost > 0,
    });
    const root = $("apx-signal");
    root.className = `apx-signal apx-${sig.level}`;
    $("apx-signal-emoji").textContent = sig.emoji;
    $("apx-signal-label").textContent = sig.label;
    const ul = $("apx-signal-reasons");
    ul.innerHTML = "";
    sig.reasons.forEach(r => {
      const li = document.createElement("li");
      li.textContent = r;
      ul.appendChild(li);
    });

    // Show retry button when there is no live intel/history yet
    const retryBtn = $("apx-signal-retry");
    if (retryBtn) {
      const hasIntel = !!(state.stability && state.stability.intel && Object.keys(state.stability.intel).some(k => state.stability.intel[k] != null));
      const hasOffers = !!(state.history?.offers?.list?.length);
      const noData = !hasIntel && !hasOffers;
      retryBtn.classList.toggle("hidden", !noData);
    }

    renderSimulator(unitCost, unitFees);
    if (typeof renderSellerAmpSummary === "function") renderSellerAmpSummary();
  }

  // ── What-if Amazon price simulator ─────────────────────────────────
  function renderSimulator(unitCost, unitFees) {
    const slider = $("apx-sim-slider");
    const offers = state.history?.offers?.list || [];
    const bb = offers.find(o => o.isBuyBox)?.landed ?? null;
    const series = state.history?.series?.buybox || state.history?.series?.newPrice || [];
    const ys = series.map(p => p.v).filter(v => Number.isFinite(v) && v > 0);
    const lo = ys.length ? Math.min(...ys) : (bb ? bb * 0.5 : 1);
    const hi = ys.length ? Math.max(...ys) : (bb ? bb * 1.5 : 100);
    const min = Math.max(0.5, lo * 0.8);
    const max = Math.max(min + 1, hi * 1.2);
    const pct = parseInt(slider.value || "50", 10);
    const simSale = +(min + (max - min) * (pct / 100)).toFixed(2);
    // Stashed so the "Send Notification" button can use the slider's
    // current simulated price as the alert's target without re-deriving it.
    state.simCurrentSale = simSale;
    $("apx-sim-val").textContent = fmtMoney(simSale, state.currency);
    $("apx-sim-sale").textContent = fmtMoney(simSale, state.currency);
    if (unitCost > 0 && unitFees != null) {
      const p = simSale - unitCost - unitFees;
      const r = (p / unitCost) * 100;
      $("apx-sim-profit").textContent = fmtMoney(p, state.currency);
      $("apx-sim-roi").textContent = r.toFixed(0) + "%";
    } else {
      $("apx-sim-profit").textContent = "—";
      $("apx-sim-roi").textContent = "—";
    }
  }

  // ── Sellers list ───────────────────────────────────────────────────
  // Competitors list pagination — 20 at a time. Reset only when a genuinely
  // NEW offers list has landed (new asin/marketplace/range, or a fresh
  // fetch replaced the data), not on every re-render triggered by e.g.
  // typing a cost — otherwise "More" would keep getting wiped out.
  const SELLERS_PAGE_SIZE = 20;
  function renderSellers() {
    const list = $("apx-sellers-list");
    const offers = state.history?.offers?.list || [];
    const rState = state.historyRetrievalState || (offers.length ? "live" : "no_offers");
    const fetchedAt = state.history?.fetched_at || state.historyLastSuccessAt;
    const sellersKey = `${state.asin}|${state.marketplace}|${state.range}|${fetchedAt || ""}`;
    if (state.sellersVisibleKey !== sellersKey) {
      state.sellersVisibleKey = sellersKey;
      state.sellersVisibleCount = SELLERS_PAGE_SIZE;
    }
    const ageMin = fetchedAt ? Math.max(0, Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60000)) : null;
    const ageLabel = ageMin == null ? "" : ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin}m old` : `${Math.round(ageMin / 60)}h old`;

    // Header count + degraded-state badge
    let countLabel = "—";
    if (offers.length) {
      if (rState === "live") countLabel = `${offers.length} live`;
      else if (rState === "stale_empty") countLabel = `${offers.length} • cached (${ageLabel}) — live returned 0`;
      else if (rState === "stale_failed") countLabel = `${offers.length} • cached (${ageLabel}) — retry failed`;
      else countLabel = `${offers.length} live`;
    } else if (rState === "failed") {
      countLabel = "retrieval failed";
    } else if (rState === "no_offers") {
      countLabel = "0 offers";
    }
    // Amazon's own offers API caps at 20 sellers with no pagination — when
    // that ceiling is hit, Summary.TotalOfferCount (surfaced as totalCount)
    // reports the real number so this doesn't silently look like "that's all
    // of them" when there are actually more.
    const totalCount = state.history?.offers?.totalCount;
    if (offers.length && typeof totalCount === "number" && totalCount > offers.length) {
      countLabel += ` of ${totalCount} (Amazon API limit)`;
    }
    // Why the data is incomplete, when the server said so.
    //
    // mobile-scan-price-history returns { degraded, degraded_reason } whenever
    // it fell back to SP-API or stale cache -- Keepa quota exhausted, timeout,
    // 5xx. Until now the panel dropped both fields on the floor, so an
    // exhausted Keepa bucket looked identical to a product that genuinely has
    // no history: thin price series, no graph, "Not enough data" for PL risk,
    // and nothing anywhere saying why. That is a temporary failure rendered as
    // a permanent verdict, and it sent a real debugging session chasing the
    // wrong cause.
    //
    // Appended to the existing count badge rather than given its own element:
    // it belongs beside the number it is qualifying, and it must not shift the
    // layout when absent (which is the normal case).
    const degradedReason = state.history?.degraded ? state.history?.degraded_reason : null;
    if (degradedReason) countLabel += ` — ${degradedReason}`;
    $("apx-sellers-count").textContent = countLabel;
    $("apx-sellers-count").title = degradedReason || "";

    list.innerHTML = "";
    if (!offers.length) {
      let emptyMsg;
      const showRetry = rState === "failed";
      switch (rState) {
        case "failed":
          emptyMsg = `Live retrieval failed (timeout or SP-API throttled).`;
          break;
        case "no_offers":
          emptyMsg = `No active marketplace offers detected for this ASIN.`;
          break;
        default:
          emptyMsg = `No live offers`;
      }
      list.innerHTML = `<div class="apx-sellers-empty apx-k">${emptyMsg}${
        showRetry ? ` <button id="apx-sellers-retry" type="button" class="apx-inline-retry">Retry</button>` : ""
      }</div>`;
      if (showRetry) {
        const retryBtn = $("apx-sellers-retry");
        if (retryBtn) retryBtn.addEventListener("click", () => loadData(true));
      }
      return;
    }

    // Per-seller ROI inputs
    const totalCost = parseFloat(($("apx-cost") || {}).value) || 0;
    const units = Math.max(1, parseInt(($("apx-units") || {}).value) || 1);
    const unitCostUsd = totalCost > 0 ? totalCost / units : 0;
    // Convert USD source cost to marketplace currency so ROI compares like-for-like
    // with CAD/MXN/BRL seller prices and fees.
    const unitCost = convertUsdToMarket(unitCostUsd);
    const f = state.fees || null;
    const totalFees = getActualFeeTotal(f);
    const refFee = totalFees == null ? 0 : (Number(f?.referralFee) || 0);
    const fbaFee = totalFees == null ? 0 : (Number(f?.fbaFee) || 0);
    const closing = totalFees == null ? 0 : (Number(f?.variableClosingFee) || 0) + (Number(f?.otherFees) || 0);
    // Reference price the SP-API fees were estimated against. Prefer the
    // price returned by `fetch-listing-snapshot` (same SP-API snapshot as
    // the fees) so the derived referral RATE matches what Amazon actually
    // billed for those fees. Fall back to the panel's BB only if missing
    // (legacy cached snapshots).
    const refPrice = (Number.isFinite(state.feesRefPrice) && state.feesRefPrice > 0)
      ? state.feesRefPrice
      : ((offers.find(o => o.isBuyBox)?.landed) ?? offers.find(o => Number.isFinite(o.landed))?.landed ?? 0);
    // Derive referral % from the estimate; fall back to 15% so per-seller ROI
    // still renders when refPrice is unknown (column showed "—" before).
    const referralRate = (refPrice > 0 && refFee > 0) ? Math.min(0.45, refFee / refPrice) : 0.15;


    const roiClass = (r) => r == null ? "na" : r >= 30 ? "good" : r >= 15 ? "warn" : "bad";
    const ratingClass = (r) => r >= 95 ? "good" : r >= 85 ? "warn" : "bad";
    const visibleCount = Math.min(offers.length, state.sellersVisibleCount || SELLERS_PAGE_SIZE);

    offers.slice(0, visibleCount).forEach(o => {
      const row = document.createElement("div");
      row.className = "apx-seller-row" + (o.isBuyBox ? " bb" : "");
      const tags = [];
      if (o.isAmazon) tags.push(`<span class="apx-seller-tag amz">AMZ</span>`);
      if (o.isSelf) tags.push(`<span class="apx-seller-tag self">YOU</span>`);
      tags.push(`<span class="apx-seller-tag ${o.isFBA ? "fba" : "fbm"}">${o.isFBA ? "FBA" : "FBM"}</span>`);
      if (o.isBuyBox) tags.push(`<span class="apx-seller-tag">BB</span>`);

      let roi = null;
      const price = Number(o.landed);
      if (unitCost > 0 && Number.isFinite(price) && price > 0 && referralRate != null) {
        // Treat every seller as FBA for ROI (always include FBA fee), so FBM
        // sellers don't get an artificially inflated ROI vs an FBA business model.
        const sellerFees = price * referralRate + fbaFee + closing;
        const profit = price - sellerFees - unitCost;
        roi = (profit / unitCost) * 100;
      }
      const roiText = roi == null ? "—" : `${roi.toFixed(0)}%`;
      const displayName = o.sellerName || o.sellerId;
      const storeUrl = sellerStorefrontUrl(o.sellerId, state.marketplace);
      const nameHtml = storeUrl
        ? `<a class="apx-seller-name" href="${esc(storeUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(displayName)}'s storefront on Amazon">${esc(displayName)}</a>`
        : `<span class="apx-seller-name" title="${esc(displayName)}">${esc(displayName)}</span>`;
      // Seller feedback rating — from Keepa's /seller lookup (already fetched
      // for the name/isAmazon check above, so this is zero extra Keepa cost).
      // null for Amazon retail and sellers Keepa has no rating data for.
      const ratingHtml = o.rating != null
        ? `<span class="apx-seller-rating ${ratingClass(o.rating)}" title="${o.ratingCount != null ? o.ratingCount.toLocaleString() + " ratings" : "Seller feedback rating"}">★ ${o.rating}%</span>`
        : "";

      row.innerHTML = `
        <span class="apx-seller-name-wrap">${nameHtml}${ratingHtml}</span>
        <span>${tags.join("")}</span>
        <span class="apx-seller-price">${fmtMoney(o.landed, state.currency)}</span>
        <span class="apx-seller-roi ${roiClass(roi)}" title="ROI at this seller's price (uses your cost + estimated fees)">${roiText}</span>
      `;
      list.appendChild(row);
    });

    if (offers.length > visibleCount) {
      const remaining = offers.length - visibleCount;
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "apx-sellers-more";
      moreBtn.textContent = `Show 20 more (${remaining} left)`;
      moreBtn.addEventListener("click", () => {
        state.sellersVisibleCount = (state.sellersVisibleCount || SELLERS_PAGE_SIZE) + SELLERS_PAGE_SIZE;
        renderSellers();
      });
      list.appendChild(moreBtn);
    }
  }

  // ── Data load ──────────────────────────────────────────────────────
  let loadingFor = null;
  async function loadData(force = false) {
    if (!state.asin || !state.signedIn) {
      // ⚠️ MUST clear summaryLoading, not just return.
      //
      // state.summaryLoading is initialised to TRUE (see the state literal at
      // the top of this file) so the very first paint shows a skeleton rather
      // than a flash of empty rows. Returning here without clearing it leaves
      // that skeleton up permanently: the panel sits on "Analyzing…" with
      // Decision Confidence, Eligible to list and Private-label risk blank,
      // and nothing on screen says why.
      //
      // Reached whenever the panel renders before the session resolves or
      // before an ASIN is detected -- which is timing-dependent, and is why
      // this looked intermittent and unreproducible.
      state.summaryLoading = false;
      renderSellerAmpSummary();
      return;
    }
    const a = state.asin, m = state.marketplace;
    loadingFor = `${a}|${m}|${state.range}`;
    // Until this scan's data is fully consistent, renderSellerAmpSummary()
    // paints a skeleton instead of computing from state — otherwise fields
    // that resolve at different times (fba-eligibility is fast, gating/PL
    // history are slower) would briefly mix stale-previous-product data
    // with new-product data and flash false "red alert" rows.
    state.summaryLoading = true;
    renderSellerAmpSummary();

    // Safety net. Every task settles on its own (withTimeout resolves rather
    // than rejecting, so Promise.allSettled below cannot hang), but the clear
    // is still skipped on two paths: the `if (!stillCurrent()) return` after
    // allSettled, and any throw between here and there -- readCache() on the
    // next lines is not wrapped, for one.
    //
    // The slowest call is 30s, so anything past 35s means the flag was
    // stranded, not slow. Clearing it degrades the panel to its real
    // "unknown" states ("—", "Not enough data"), which tell the user something
    // is missing. An eternal skeleton tells them nothing and looks like a hang.
    //
    // The warn is deliberate: if this ever fires, the console names the stuck
    // scan so the underlying path can be found rather than guessed at.
    const watchdogFor = loadingFor;
    setTimeout(() => {
      if (state.summaryLoading && loadingFor === watchdogFor) {
        console.warn(`[InvSPRNT] summary watchdog fired for ${watchdogFor} — summaryLoading was stranded, clearing`);
        state.summaryLoading = false;
        renderSellerAmpSummary();
      }
    }, 35000);

    const r = state.range;
    let servedFromCache = false;
    if (!force) {
      const cached = await readCache(a, m, r);
      if (cached) {
        // Strip any legacy cached gating — gating must always come from a
        // fresh fetch-listing-snapshot call so an APPROVED flip on
        // Amazon's side is reflected immediately (matches Create extension).
        if (cached.product) {
          delete cached.product.marketplaceGating;
          delete cached.product.gatingStatus;
        }
        Object.assign(state, cached, { cached: true });
        // Seed retrieval state from cache so the sellers panel shows the
        // correct badge (live/stale) until the next live fetch resolves.
        const cachedOffers = cached.history?.offers?.list?.length || 0;
        state.historyRetrievalState = cachedOffers ? "live" : "no_offers";
        state.historyLastSuccessAt = cached.fetched_at || null;
        // Also clear any stale gating that survived in current memory state.
        if (state.product) {
          delete state.product.marketplaceGating;
          delete state.product.gatingStatus;
        }
        servedFromCache = true;
        // Cached data is complete and consistent for THIS asin — safe to
        // show immediately instead of a skeleton (still refreshed live below).
        state.summaryLoading = false;
        renderAll();
        autoRecordHistory().catch((e) => console.debug("[InvSPRNT] auto-record skipped:", e?.message || e));
        // Fall through: still issue the live fetches below so gating refreshes.
      }
    }


    // Capture the real reason a background invoke failed so callers can
    // surface a meaningful banner instead of a generic "did not return a
    // result." Keyed by edge-function name.
    const lastInvokeError = {};
    const withTimeout = (p, ms, label) => new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          lastInvokeError[label] = `timed out after ${ms}ms`;
          console.debug(`[InvSPRNT] ${label} timed out after ${ms}ms`);
          resolve(null);
        }
      }, ms);
      p.then((v) => { done = true; clearTimeout(t); resolve(v); })
       .catch((e) => {
         done = true;
         clearTimeout(t);
         const msg = e?.message ? String(e.message) : String(e);
         lastInvokeError[label] = msg;
         console.debug(`[InvSPRNT] ${label} failed:`, msg, e);
         resolve(null);
       });
    });

    const safeInvoke = (fn, body, ms = 25000) => {
      delete lastInvokeError[fn];
      return withTimeout(
        bg("ARBIPRO_INVOKE", { fn, body }).then(r => r?.data ?? null),
        ms,
        fn,
      );
    };

    const stillCurrent = () => loadingFor === `${a}|${m}|${r}`;
    state.fbaComplianceLoading = true;
    state.fbaComplianceError = null;
    renderFbaCompliance();
    const tasks = [
      safeInvoke("fetch-listing-snapshot", { asin: a, marketplaceId: marketplaceIdFor(m) }, 20000).then((prod) => {
        if (!stillCurrent()) return;
        if (prod) {
          const hasFees = getActualFeeTotal(prod.fees) != null;
          state.fees = hasFees ? prod.fees : null;
          // Reference price the SP-API fees were estimated against. Used to
          // derive a referral RATE so we can re-price referral per-seller.
          // CRITICAL: must come from `prod.price` (same call that produced the
          // fee estimate) — using the panel's own BB can desync and silently
          // inflate/deflate per-seller ROI when the two SP-API snapshots
          // disagree on Buy Box price.
          state.feesRefPrice = hasFees && Number.isFinite(Number(prod.price)) && Number(prod.price) > 0
            ? Number(prod.price)
            : null;
          if (!hasFees && (prod.feesUnavailableReason === "THROTTLED" || prod.feesUnavailable)) {
            scheduleFeeRetry(a, m);
          }
        }

        if (prod?.currency) state.currency = prod.currency;
        state.product = state.product || {};
        // Always clear stale gating before applying fresh response — if the
        // new response doesn't carry gating (timeout/partial), surface
        // "unknown" rather than replaying an old APPROVAL_REQUIRED.
        delete state.product.marketplaceGating;
        delete state.product.gatingStatus;
        if (prod?.gatingStatus) state.product.gatingStatus = prod.gatingStatus;
        if (Array.isArray(prod?.marketplaceGating)) state.product.marketplaceGating = prod.marketplaceGating;
        if (prod?.title && prod.title !== "Product not found on Amazon") state.product.title = prod.title;
        if (prod?.imageUrl) state.product.image = prod.imageUrl;
        renderMeta(); renderEligibility(); renderFbaEligibility(); renderFbaCompliance(); renderRoiAndSignal();
        // Not approved yet on this first check? Amazon's restrictions API and
        // our own seller-account override (see fetch-listing-snapshot)
        // both have a brief eventual-consistency window right after a real
        // approval — auto-retry instead of leaving the user stuck showing a
        // stale gate until they notice and press Recheck themselves.
        if (selectedMarketplaceGatingStatus() !== "approved") scheduleGatingRetry(a, m);
      }),
      safeInvoke("mobile-scan-price-history", { asin: a, marketplace: m, range: r }, 25000).then((hist) => {
        if (!stillCurrent()) return;
        // Soft-degrade: distinguish fetch-failed vs no-offers vs live.
        // NEVER wipe a previously-good offers snapshot just because one
        // refresh timed out / SP-API throttled / Keepa failed.
        const prevList = state.history?.offers?.list || [];
        const newList = hist?.offers?.list || [];
        const now = new Date().toISOString();
        if (!hist) {
          // Edge function returned null (timeout or non-2xx) — keep last good.
          state.historyRetrievalState = prevList.length ? "stale_failed" : "failed";
          state.historyLastAttemptAt = now;
          // Don't touch state.history — last-good remains visible.
        } else if (newList.length === 0 && prevList.length > 0) {
          // Live retrieval returned an empty list but we still have a prior
          // good snapshot. Likely SP-API 0-offers / Keepa 7-day freshness
          // dropped everything. Preserve the prior list, refresh the rest.
          state.historyRetrievalState = "stale_empty";
          state.historyLastAttemptAt = now;
          state.history = {
            ...hist,
            offers: state.history?.offers || { count: 0, list: [] },
          };
        } else {
          state.historyRetrievalState = newList.length ? "live" : "no_offers";
          state.historyLastAttemptAt = now;
          state.historyLastSuccessAt = newList.length ? now : (state.historyLastSuccessAt || null);
          state.history = hist;
        }
        if (!state.currency || state.currency === "USD") {
          state.currency = state.history?.offers?.list?.[0]?.currency || state.currency || "USD";
        }
        renderHistory(); renderHistoryChart(); renderSellers();
      }),
      safeInvoke("mobile-scan-price-stability", { asin: a, marketplace: m, range: r }, 30000).then((stab) => {
        if (!stillCurrent()) return;
        state.stability = stab || null;
        renderStability(); renderRoiAndSignal();
      }),
      safeInvoke("asin-dimensions", { asin: a, marketplace: m }, 25000).then((dims) => {
        if (!stillCurrent()) return;
        state.dims = (dims && (dims.found || dims.cached || dims.source)) ? dims : null;
        renderDims();
      }),
      safeInvoke("check-fba-listing-eligibility", { asin: a, marketplace: m, marketplaceId: MARKETPLACES[m]?.id, condition: "new_new", force }, 15000).then((res) => {
        if (!stillCurrent()) return;
        state.fbaElig = res && typeof res === "object" ? normalizeFbaEligibility(res) : null;
        state.fbaComplianceLoading = false;
        state.fbaComplianceError = state.fbaElig
          ? null
          : (lastInvokeError["check-fba-listing-eligibility"]
              ? `Amazon SP-API check failed: ${lastInvokeError["check-fba-listing-eligibility"]}`
              : "Amazon SP-API check did not return a result.");
        renderFbaEligibility();
        renderFbaCompliance();
        renderSellerAmpSummary();
      }),
    ];

    await Promise.allSettled(tasks);
    if (!stillCurrent()) return;
    state.summaryLoading = false;
    state.cached = false;
    state.fetched_at = new Date().toISOString();
    // Persist a sanitized product copy WITHOUT gating — gating must always
    // come from a live fetch-listing-snapshot fetch.
    const productForCache = state.product ? { ...state.product } : null;
    if (productForCache) {
      delete productForCache.marketplaceGating;
      delete productForCache.gatingStatus;
    }
    const approvalStatusForCache = currentApprovalStatusForStorage();
    await writeCache(a, m, r, {
      fees: state.fees, feesRefPrice: state.feesRefPrice, currency: state.currency, eligibility: approvalStatusForCache,
      stability: state.stability, history: state.history, dims: state.dims, fbaElig: state.fbaElig, product: productForCache, fetched_at: state.fetched_at,
    });

    renderAll();
    // Auto-record this view to scan history (deduped per ASIN+marketplace)
    autoRecordHistory().catch((e) => console.warn("[InvSPRNT] auto-record failed", e?.message));
  }

  // Build a mobile_scan_history row from current state
  function buildScanRow() {
    const offers = state.history?.offers?.list || [];
    const bb = offers.find(o => o.isBuyBox)?.landed ?? null;
    const intel = state.stability?.intel || {};
    const totalCost = parseFloat($("apx-cost")?.value) || null;
    const units = parseInt($("apx-units")?.value || "1", 10) || 1;
    const saleOverride = parseFloat($("apx-sale")?.value);
    const unitCost = totalCost ? totalCost / units : null;
    const fees = state.fees || null;
    const unitFees = getActualFeeTotal(fees);
    const fallbackPrice = pickAnchorPrice(offers, state.sellerMode);
    const salePrice = isFinite(saleOverride) && saleOverride > 0 ? saleOverride : fallbackPrice;
    const { profit, roi } = computeWebStyleRoi(salePrice, unitCost, fees);
    const bsr = intel.bsr_current ?? null;
    const estSales = estimateMonthlySales(intel);
    const approvalStatus = currentApprovalStatusForStorage();
    return {
      barcode: state.asin,
      barcode_format: "EXTENSION",
      asin: state.asin,
      title: state.history?.title || state.stability?.intel?.title || state.product?.title || null,
      image_url: state.history?.image || state.stability?.intel?.image || state.product?.image || null,
      price: salePrice,
      currency: state.currency || "USD",
      marketplace: state.marketplace,
      total_cost: totalCost,
      units,
      sale_price_override: isFinite(saleOverride) ? saleOverride : null,
      raw: {
        source: "chrome_extension",
        auto: undefined,
        url: state._url || null,
        fees,
        eligibility: approvalStatus,
        stability_verdict: state.stability?.verdict || null,
        swing_pct: state.stability?.swing_pct ?? null,
        buy_box_price: bb,
        sellers_fba: intel.sellers_fba ?? null,
        sellers_fbm: intel.sellers_fbm ?? null,
        amazon_presence_pct: intel.amazon_presence_pct ?? null,
        bsr_current: bsr,
        est_monthly_sales: estSales,
        unit_cost: unitCost,
        unit_fees: unitFees,
        profit,
        roi,
        saved_at: new Date().toISOString(),
      },
    };
  }

  // Auto-record (silent) — deduped per ASIN+marketplace for 6 hours
  const AUTO_RECORD_TTL_MS = 6 * 60 * 60 * 1000;
  async function autoRecordHistory() {
    if (!state.signedIn || !state.asin) return;
    const key = `autorec:${state.marketplace}:${state.asin}`;
    const o = await chrome.storage.local.get(key);
    const last = o[key];
    if (last && Date.now() - last < AUTO_RECORD_TTL_MS) return;
    const row = buildScanRow();
    row.raw.auto = true;
    // Skip recording until we have at least a title or image — prevents bare "(no Amazon match)" rows.
    if (!row.title && !row.image_url) return;
    await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "ARBIPRO_SAVE_SCAN", row }, (r) => {
        if (r?.ok) chrome.storage.local.set({ [key]: Date.now() });
        resolve(r);
      }),
    );
  }

  function renderAll() {
    // ⚠️ ISOLATED ON PURPOSE. These used to be eleven bare calls, so the first
    // one to throw silently skipped every renderer after it -- and, because
    // renderAll() runs before the Promise.allSettled in loadData(), also
    // rejected loadData and stranded state.summaryLoading at true, leaving the
    // panel on "Analyzing…" forever.
    //
    // That is one bug with two faces: partial UI (fields after the failure
    // blank while earlier ones have data) AND a permanent skeleton. Observed
    // 2026-08-23 via renderDims, which dereferenced five elements with no null
    // check and sits 7th in this list -- taking the four renderers after it,
    // including the entire seller-amp summary, down with it.
    //
    // A renderer failing should degrade its own section, not the panel. The
    // console.error names which one so the next occurrence is diagnosed rather
    // than guessed at.
    const steps = [
      ["meta", renderMeta],
      ["eligibility", renderEligibility],
      ["stability", renderStability],
      ["history", renderHistory],
      ["historyChart", renderHistoryChart],
      ["sellers", renderSellers],
      ["dims", renderDims],
      ["fbaEligibility", renderFbaEligibility],
      ["fbaCompliance", renderFbaCompliance],
      ["roiAndSignal", renderRoiAndSignal],
      ["sellerAmpSummary", renderSellerAmpSummary],
    ];
    for (const [name, fn] of steps) {
      try {
        fn();
      } catch (e) {
        console.error(`[InvSPRNT] renderAll: ${name} failed`, e);
      }
    }
  }

  // ───── SellerAmp-style summary, diagnostics, and weighted verdict ─────
  function setChip(el, level, text) {
    if (!el) return;
    el.className = "apx-sa-chip apx-sa-" + level;
    el.textContent = text;
  }
  function classifyEligibility() {
    // Drive from per-marketplace gating only (same source as web Create
    // Listing). Do NOT fall back to legacy state.eligibility.
    const e = (selectedMarketplaceGatingStatus() || "").toLowerCase();
    if (e === "approved" || e === "eligible") return { level: "good", text: "Yes" };
    if (e === "restricted" || e === "not_eligible" || e === "ineligible") return { level: "bad", text: "No" };
    if (e === "approval_required" || e === "needs_approval" || e === "gated") return { level: "caution", text: "Approval" };
    return { level: "unknown", text: "—" };
  }
  function currentApprovalStatusForStorage() {
    const e = (selectedMarketplaceGatingStatus() || "").toLowerCase();
    if (e === "approved" || e === "eligible") return "approved";
    if (e === "restricted" || e === "not_eligible" || e === "ineligible") return "restricted";
    if (e === "approval_required" || e === "needs_approval" || e === "gated") return "approval_required";
    return null;
  }
  // Maps plRisk.js's "Low"/"Medium"/"High"/"unknown" vocabulary onto this
  // file's existing "good"/"caution"/"bad"/"unknown" convention, used for
  // diag-row coloring/icons and by the older classifyCompetitionRisk() /
  // decision-engine scoring below. Kept as one small local adapter rather
  // than baking this codebase's convention into plRisk.js itself.
  function plRiskUiLevel(riskLevel) {
    if (riskLevel === "High") return "bad";
    if (riskLevel === "Medium") return "caution";
    if (riskLevel === "Low") return "good";
    return "unknown";
  }
  function classifyAmazonShare() {
    const p = state.stability?.intel?.amazon_presence_pct;
    if (p == null) return { level: "unknown", text: "Unknown" };
    if (p < 5)  return { level: "good", text: "Never on listing" };
    if (p < 30) return { level: "caution", text: `Occasionally (${Math.round(p)}%)` };
    if (p < 70) return { level: "caution", text: `Frequently (${Math.round(p)}%)` };
    return { level: "bad", text: `Dominant (${Math.round(p)}%)` };
  }
  function classifySizeTier() {
    const d = state.dims;
    if (!d) return { level: "unknown", text: "Unknown" };
    const u = String(d.package_dim_unit || "").toLowerCase();
    let L = d.package_length, W = d.package_width, H = d.package_height;
    if (u.startsWith("millim") || u === "mm") { L = L/25.4; W = W/25.4; H = H/25.4; }
    else if (u.startsWith("centim") || u === "cm") { L = L/2.54; W = W/2.54; H = H/2.54; }
    let wt = d.package_weight;
    const wu = String(d.package_weight_unit || "").toLowerCase();
    if (wu.startsWith("gram") || wu === "g") wt = wt / 453.592;
    else if (wu.startsWith("kilo")) wt = wt * 2.20462;
    else if (wu.startsWith("ounce") || wu === "oz") wt = wt / 16;
    const sides = [L, W, H].filter(Number.isFinite).sort((a,b) => b - a);
    if (sides.length < 3 || !Number.isFinite(wt)) return { level: "unknown", text: "Unknown" };
    const [longest, median, shortest] = sides;
    const girth = longest + 2 * (median + shortest);
    if (longest <= 15 && median <= 12 && shortest <= 0.75 && wt <= 1) return { level: "good",    text: "Small Standard" };
    if (longest <= 18 && median <= 14 && shortest <= 8    && wt <= 20) return { level: "good",    text: "Large Standard" };
    if (longest <= 60 && girth   <= 130 && wt <= 50)                  return { level: "caution", text: "Large Oversize" };
    if (longest <= 108 && girth  <= 165)                              return { level: "caution", text: "Oversize" };
    return { level: "bad", text: "Heavy/Bulky" };
  }
  function classifyVariations() {
    const v = state.stability?.intel?.variation_count;
    if (v == null) return { level: "unknown", text: "Unknown" };
    if (v <= 1) return { level: "good", text: "No" };
    return { level: "caution", text: `${v} variations` };
  }
  // Is this ASIN under Amazon's Dangerous Goods (hazmat) program? Reads the
  // same FBA stage matrix the "Why this decision" hazmat overlay uses, so
  // the two always agree — this just also surfaces it in Active alerts.
  function classifyHazmat() {
    const stages = Array.isArray(state.fbaElig?.stageStatuses) ? state.fbaElig.stageStatuses : [];
    const hazmatStatus = Object.fromEntries(stages.map(s => [s.stage, s.status]))["hazmat"];
    if (hazmatStatus === "blocked") return { level: "bad", text: "Yes" };
    if (hazmatStatus === "warn") return { level: "caution", text: "Possible" };
    if (hazmatStatus === "ok") return { level: "good", text: "No" };
    return { level: "unknown", text: "Unknown" };
  }
  function computeMaxCost() {
    const offers = state.history?.offers?.list || [];
    const sale = pickAnchorPrice(offers, state.sellerMode);
    if (sale == null) return null;
    const unitFees = getActualFeeTotal(state.fees);
    if (unitFees == null) return null;
    return Math.max(0, (sale - unitFees) / 1.30);
  }

  // Same k labels as the real diag grid (extension/panel.js renderSellerAmpSummary)
  // — kept as a small static list purely for the loading skeleton, since the
  // real labels are computed from live classify functions we don't want to
  // run yet.
  const DIAG_SKELETON_KEYS = [
    "Eligibility", "Amazon Competition Risk", "Private-Label Risk",
    "Current Active Offers", "Historical Active Offers",
    "Hazmat / Dangerous Goods", "IP Analysis", "Size Tier", "Variations",
  ];
  function renderSellerAmpSkeleton() {
    const elig = $("apx-sa-eligible");
    if (elig) { elig.className = "apx-sa-chip apx-skel-bar"; elig.textContent = ""; }
    const pl = $("apx-sa-pl");
    if (pl) { pl.className = "apx-sa-chip apx-skel-bar"; pl.textContent = ""; }
    const aBadge = $("apx-sa-alerts");
    if (aBadge) { aBadge.className = "apx-sa-badge apx-skel-bar"; aBadge.textContent = ""; aBadge.title = ""; }

    const grid = $("apx-diag-grid");
    if (grid) {
      grid.innerHTML = "";
      DIAG_SKELETON_KEYS.forEach(k => {
        const row = document.createElement("div");
        row.className = "apx-diag-row apx-skel-row";
        row.innerHTML = `<span class="apx-diag-k">${k}</span><span class="apx-diag-v"><span class="apx-skel-bar"></span></span>`;
        grid.appendChild(row);
      });
    }

    const act = $("apx-dm-action");
    if (act) { act.className = "apx-fd-action"; act.textContent = "Analyzing…"; }
    const emojiEl = $("apx-fd-emoji");
    if (emojiEl) emojiEl.textContent = "⏳";
    const conf = $("apx-fd-confidence");
    if (conf) { conf.className = "apx-skel-bar"; conf.textContent = ""; }
    const why = $("apx-dm-why");
    if (why) why.textContent = "";
    const scoreEl = $("apx-sa-verdict-score");
    if (scoreEl) scoreEl.textContent = "";
    // Don't let the previous product's brand-history summary linger while
    // the new scan is still loading.
    const bh = $("apx-brand-history");
    if (bh) { bh.hidden = true; bh.innerHTML = ""; bh.className = "apx-brand-history"; }
    brandHistoryState.key = null;
  }

  let __saMounted = false;
  function renderSellerAmpSummary() {
    // Data for this scan isn't fully consistent yet (see loadData()) — show
    // a skeleton instead of computing from a mix of stale-previous-product
    // and partial-new-product state, which used to flash false "red alert"
    // rows (e.g. a leftover gating/PL status from the last ASIN) until every
    // fetch settled.
    if (state.summaryLoading) { renderSellerAmpSkeleton(); return; }
    if (!__saMounted) { console.log("[InventorySprint] Analyzer summary mounted"); __saMounted = true; }
    console.log("[InventorySprint] Analyzer summary data loaded", { asin: state.asin, hasIntel: !!state.stability?.intel, hasOffers: !!state.history?.offers?.list?.length, hasDims: !!state.dims });
    const intel = state.stability?.intel || {};
    const totalCost = parseFloat($("apx-cost").value) || 0;
    const units = Math.max(1, parseInt($("apx-units").value || "1", 10));
    const saleOverride = parseFloat($("apx-sale").value);
    const unitCostUsd = totalCost > 0 ? totalCost / units : 0;
    // Convert USD source cost into marketplace currency for non-US so the
    // Smart Buy/Sell summary's Profit / ROI / Margin line up with local fees.
    const unitCost = convertUsdToMarket(unitCostUsd);
    const offers = state.history?.offers?.list || [];
    const bb = offers.find(o => o.isBuyBox)?.landed ?? null;
    const sale = (isFinite(saleOverride) && saleOverride > 0) ? saleOverride : pickAnchorPrice(offers, state.sellerMode);
    const f = state.fees || null;
    const { unitFees, profit, roi, margin } = computeWebStyleRoi(sale, unitCost, f);
    // Don't fake ROI when Amazon Fees API didn't return real fees.

    const elig = classifyEligibility();
    const eligInfo = elig.level === "good"
      ? "Amazon's SP-API restrictions check found no blocks for your seller account in this marketplace — you're clear to list."
      : elig.level === "bad"
      ? "Amazon's SP-API restrictions check found a hard block for your seller account in this marketplace — listing isn't currently possible."
      : elig.level === "caution"
      ? "Amazon requires brand/category approval before you can list this ASIN under your seller account. Apply for approval, or check an existing application, before sourcing this."
      : "Eligibility hasn't been checked yet for this marketplace.";
    { const _el = $("apx-sa-eligible-info"); if (_el) _el.title = eligInfo; }
    setChip($("apx-sa-eligible"), elig.level, elig.text);
    // Reconciled seller count from actual offer list (single source of truth
    // shared with the competitor table below).
    const _reconciledFba = offers.filter(o => o?.isFBA).length;
    const _reconciledFbm = offers.filter(o => o && o.isFBA === false).length;
    const _reconciledTotal = _reconciledFba + _reconciledFbm;
    // Private-Label Risk — scored from historical Buy Box ownership + active-offer
    // trend (self.computePrivateLabelRisk, extension/plRisk.js), NOT from today's
    // live seller-count snapshot. See extension/plRisk.js for the full model.
    const plResult = self.computePrivateLabelRisk({
      sellerHistory: state.history?.series?.sellerHistory || null,
      buyBoxOwnership: state.history?.series?.buyBoxOwnership || null,
      productAgeDays: intel.product_age_days ?? null,
    });
    // Show a plain 0-100% score instead of a bare Low/Medium/High word —
    // easier for a regular seller to calibrate ("18%" reads more concretely
    // than "Low"). plResult.state has three possible values:
    //   "scored"          — real Low/Medium/High percentage.
    //   "limited_history" — some real evidence exists (e.g. a single Buy Box
    //                       event only a few days old) but too thin to
    //                       reliably classify. Never shown as Low/Med/High.
    //   "insufficient"    — no usable evidence at all.
    // Both non-"scored" states are flag-worthy everywhere plRowLevel feeds
    // into (chip color, diag alert, weighted verdict, competition-risk
    // overlay) — "insufficient" as a hard "bad" (we know nothing), "limited
    // history" as a softer "caution" (we know a little). The old separate
    // "PL History Coverage" row is retired — its meaning is now folded
    // directly into plResult.text below, since a standalone "Coverage"
    // label didn't mean anything to users on its own.
    const plRowLevel = plResult.state === "insufficient" ? "bad"
      : plResult.state === "limited_history" ? "caution"
      : plRiskUiLevel(plResult.level);
    const plDisplayText = plResult.state === "insufficient" ? "Not enough data"
      : plResult.state === "limited_history" ? "Limited History"
      : `${plResult.normalizedScore}% — ${plResult.level} Risk`;
    const plCaption = plResult.state === "insufficient"
      ? "Not enough historical data yet to determine Private-Label Risk reliably."
      : plResult.text;
    setChip($("apx-sa-pl"), plRowLevel, plDisplayText);
    // Human-readable "why" for every possible state (High/Medium/Low risk,
    // limited history, or insufficient data) — plCaption/plResult.text is
    // always populated by computePrivateLabelRisk(), never blank.
    { const _el = $("apx-sa-pl-info"); if (_el) _el.title = plCaption; }

    const bsr = intel.bsr_current;
    $("apx-sa-bsr").textContent = bsr ? "#" + bsr.toLocaleString() : "—";
    const sales = estimateMonthlySales(intel);
    $("apx-sa-sales").textContent = sales ? sales.toLocaleString() + "/mo" : "—";
    { const _b = $("apx-sa-sales-bar"); if (_b) _b.textContent = sales ? sales.toLocaleString() + "/mo" : "—"; }
    const maxCost = computeMaxCost();
    $("apx-sa-maxcost").textContent = maxCost != null ? fmtMoney(maxCost, state.currency) : "—";
    $("apx-sa-sale").textContent = sale != null ? fmtMoney(sale, state.currency) : "—";
    $("apx-sa-cost").textContent = unitCost > 0 ? fmtMoney(unitCost, state.currency) : fmtMoney(0, state.currency);
    $("apx-sa-profit").textContent = profit != null ? fmtMoney(profit, state.currency) : "—";
    const roiEl = $("apx-sa-roi");
    roiEl.textContent = roi != null ? roi.toFixed(0) + "%" : ((unitCost === 0 && sale) ? "∞%" : "—");
    roiEl.className = "apx-sa-v " + (roi == null ? "" : roi >= 30 ? "apx-good" : roi >= 15 ? "apx-warn" : "apx-bad");
    const marginEl = $("apx-sa-margin");
    marginEl.textContent = margin != null ? margin.toFixed(0) + "%" : "—";
    marginEl.className = "apx-sa-v " + (margin == null ? "" : margin >= 20 ? "apx-good" : margin >= 10 ? "apx-warn" : "apx-bad");

    const amz = classifyAmazonShare();
    const amzRisk = self.computeAmazonCompetitionRisk(intel.amazon_presence_pct);
    const sz = classifySizeTier();
    const vars = classifyVariations();
    const haz = classifyHazmat();

    const sellerHist = state.history?.series?.sellerHistory || null;
    const currentActiveOffers = sellerHist?.currentCount ?? (_reconciledTotal || null);
    const historicalText = sellerHist?.sufficient
      ? `${sellerHist.avg.toFixed(1)} avg over ${sellerHist.windowDays}d (${sellerHist.trend})`
      : "Not enough history";
    const diag = [
      { k: "Eligibility", ...elig, tip: "From SP-API restrictions check for your seller account." },
      // Amazon presence is an important sourcing warning on its own, but it is
      // NOT evidence of private-label status — kept as its own separate risk,
      // never added into the Private-Label Risk score below.
      { k: "Amazon Competition Risk", level: amzRisk.level, text: amzRisk.text, tip: amzRisk.detail },
      { k: "Private-Label Risk", level: plRowLevel, text: plDisplayText, tip: plCaption, caption: plCaption },
      { k: "Current Active Offers", level: "unknown", text: currentActiveOffers != null ? String(currentActiveOffers) : "—", tip: "Live count right now — can dip temporarily from restocking/out-of-stock lag, so it only slightly influences Private-Label Risk." },
      { k: "Historical Active Offers", level: sellerHist?.sufficient ? "good" : "unknown", text: historicalText, tip: "Active new-condition offers approximate seller participation — one seller can occasionally hold multiple offers. Trend is informational only in this phase." },
      { k: "Hazmat / Dangerous Goods", ...haz, tip: "Is this ASIN under Amazon's Dangerous Goods program? From the FBA compliance stage check." },
      { k: "IP Analysis", level: "good", text: "No known issues", tip: "No internal IP risk database matches." },
      { k: "Size Tier", ...sz, tip: "Estimated from package dimensions/weight." },
      { k: "Variations", ...vars, tip: "Number of child ASINs from Keepa." },
    ];
    const grid = $("apx-diag-grid");
    grid.innerHTML = "";
    diag.forEach(d => {
      const row = document.createElement("div");
      row.className = "apx-diag-row " + d.level;
      row.title = d.tip || "";
      const icon = d.level === "good" ? "✓" : d.level === "caution" ? "⚠" : d.level === "bad" ? "✗" : "?";
      row.innerHTML = `<span class="apx-diag-k">${d.k}</span><span class="apx-diag-v">${icon} ${d.text}</span>`;
      grid.appendChild(row);
      // Rows like Private-Label Risk use terms a seller can't be expected to
      // know at a glance — show the plain-English explanation directly
      // instead of burying it in a hover-only tooltip.
      if (d.caption) {
        const cap = document.createElement("div");
        cap.className = "apx-diag-caption";
        cap.textContent = d.caption;
        grid.appendChild(cap);
      }
    });

    const flagged = diag.filter(d => d.level === "caution" || d.level === "bad");
    const aBadge = $("apx-sa-alerts");
    aBadge.textContent = flagged.length ? flagged.map(d => d.k).join(", ") : "None";
    // "each alert: its own plain-English reason" (same tip text the
    // detailed diagnostics grid shows) — including the "no alerts" case,
    // which used to leave the tooltip empty.
    const alertsInfo = flagged.length
      ? flagged.map(d => `${d.k}: ${d.tip || d.text}`).join(" • ")
      : "No risk factors flagged — Eligibility, Private-Label Risk, and every other check below came back clean.";
    aBadge.title = alertsInfo;
    { const _el = $("apx-sa-alerts-info"); if (_el) _el.title = alertsInfo; }
    // Red should mean "real problem" (at least one "bad" item, e.g. Hazmat
    // blocked, Ineligible, Insufficient PL data). A caution-only mix (e.g.
    // just a Medium Private-Label Risk) is a milder heads-up, not an
    // emergency — showing it in the same red as a hard block was confusing
    // users into thinking something was actually wrong.
    const hasBad = flagged.some(d => d.level === "bad");
    aBadge.className = "apx-sa-badge" + (flagged.length === 0 ? " zero" : hasBad ? "" : " caution");

    // Weighted verdict
    let score = 0, max = 0;
    const w = (weight, level) => {
      max += weight;
      if (level === "good") score += weight;
      else if (level === "caution") score += weight * 0.5;
    };
    max += 25;
    if (roi != null) {
      if (roi >= 50) score += 25;
      else if (roi >= 30) score += 20;
      else if (roi >= 15) score += 10;
      else if (roi >= 0) score += 3;
    }
    w(20, elig.level);
    w(15, amz.level);
    w(10, plRowLevel);
    max += 10;
    if (bsr != null) {
      if (bsr <= 10000) score += 10;
      else if (bsr <= 100000) score += 7;
      else if (bsr <= 500000) score += 3;
    }
    max += 10;
    if (sales != null) {
      if (sales >= 100) score += 10;
      else if (sales >= 30) score += 7;
      else if (sales >= 5) score += 3;
    }
    // Seller-count reconciliation: prefer the actual offer list (same source
    // as the competitor table). Fall back to Keepa intel only when the list
    // is empty. See src/lib/finalDecision.ts for the mirror.
    const offerList = state.history?.offers?.list || [];
    const offerCountFba = offerList.filter(o => o?.isFBA).length;
    const offerCountFbm = offerList.filter(o => o && o.isFBA === false).length;
    const useOfferList = offerCountFba + offerCountFbm > 0;
    const totalSellers = useOfferList
      ? (offerCountFba + offerCountFbm)
      : ((intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0));
    const sellerCountSource = useOfferList ? "offers_list" : (totalSellers > 0 ? "keepa_intel" : "none");
    max += 5;
    if (totalSellers > 0) {
      if (totalSellers <= 5) score += 5;
      else if (totalSellers <= 15) score += 3;
    }
    const pct = max > 0 ? (score / max) * 100 : 0;

    // Compliance signals — read from the FBA stage matrix so they never get
    // silently dropped from the verdict sentence. FIX (2026-07-14): this
    // used to read the never-populated legacy `state.eligibility` field,
    // so hazmat/prep here always silently evaluated to "unknown" and the
    // downgrade/warning in applyComplianceOverlay() below could never
    // actually fire. The real data lives on `state.fbaElig` (see
    // deriveFbaStages(state.fbaElig) above).
    const stages = Array.isArray(state.fbaElig?.stageStatuses) ? state.fbaElig.stageStatuses : [];
    const stageBy = Object.fromEntries(stages.map(s => [s.stage, s.status]));
    const hazmatStatus = stageBy["hazmat"];
    const prepStatus = stageBy["prep"];
    // NOTE: `ipRisk` removed 2026-07-06. No live data source was wired —
    // was hardcoded to "unknown". See .lovable/architecture-audit.md →
    // "IP risk overlay". Revisit if a real brand/PL classifier ships.
    const compliance = {
      hazmat: hazmatStatus === "blocked" ? "yes" : hazmatStatus === "warn" ? "caution" : hazmatStatus === "ok" ? "no" : "unknown",
      prep:   prepStatus   === "blocked" ? "required" : prepStatus === "warn" ? "caution" : prepStatus === "ok" ? "none" : "unknown",
    };


    // Sim override — active when user typed a sale price above 0.
    const saleOverrideRaw = parseFloat($("apx-sale")?.value);
    const bbOffer = offerList.find(o => o?.isBuyBox);
    const buyBoxPrice = bbOffer?.landed ?? null;
    const simActive = Number.isFinite(saleOverrideRaw) && saleOverrideRaw > 0 && buyBoxPrice != null && Math.abs(saleOverrideRaw - buyBoxPrice) > 0.01;

    // ───── Unified Final Decision (single human-readable verdict) ─────
    // Compat shape for classifyCompetitionRisk() / the debug-JSON export,
    // which still speak this file's "good"/"caution"/"bad" vocabulary.
    const plCompat = { level: plRowLevel, text: plDisplayText };
    // Clean categorical label for analyzer_decision_log.pl_risk — a short,
    // groupable value (unlike plDisplayText's "45% — Medium Risk", which is
    // fine for the UI but awkward to aggregate in SQL for brand history).
    const plRiskLabel = plResult.state === "insufficient" ? "Insufficient Data"
      : plResult.state === "limited_history" ? "Limited History"
      : plResult.level; // "Low" | "Medium" | "High"
    renderDecisionMatrix({
      roi, profit, elig, amz, pl: plCompat, intel,
      totalSellers, bsr, sales, scorePct: pct,
      sellerCountSource, offerCountFba, offerCountFbm,
      compliance, buyBoxPrice, simActive,
      costMissing: totalCost <= 0,
      plCaption, plRiskLabel,
      plRiskPct: plResult.state === "scored" ? plResult.normalizedScore : null,
    });
  }

  // Compute price slope (% change between first and last halves of series)
  function computePriceSlope(series) {
    const ys = (series || []).map(p => p.v).filter(v => Number.isFinite(v) && v > 0);
    if (ys.length < 6) return null;
    const half = Math.floor(ys.length / 2);
    const firstAvg = ys.slice(0, half).reduce((a,b)=>a+b,0) / half;
    const lastAvg  = ys.slice(half).reduce((a,b)=>a+b,0) / (ys.length - half);
    if (firstAvg <= 0) return null;
    return ((lastAvg - firstAvg) / firstAvg) * 100;
  }

  function classifyProfitToday(roi, profit, eligLevel) {
    if (eligLevel === "bad") return { level: "bad", text: "Blocked", reason: "Not eligible to sell" };
    if (roi == null || profit == null) return { level: "unknown", text: "Enter cost", reason: null };
    if (profit < 1 || roi < 0)         return { level: "bad",     text: "Bad",   reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
    if (profit < 3 || roi < 20)        return { level: "caution", text: "Weak",  reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
    if (roi >= 30 && profit >= 3)      return { level: "good",    text: "Good",  reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
    return { level: "caution", text: "Okay", reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
  }

  function classifyMarketTrend() {
    const series = state.history?.series?.buybox || state.history?.series?.newPrice || [];
    const swing  = computeSwingFromHistory();
    const slope  = computePriceSlope(series);
    const rangeLbl = RANGE_LABELS[state.range] || "Range";
    if (swing == null && slope == null) return { level: "unknown", text: "No history", reason: null };
    // Falling = sustained drop (slope <= -8%) regardless of swing
    if (slope != null && slope <= -8) {
      return { level: "bad", text: "Falling", reason: `${rangeLbl} BB price down ${Math.abs(slope).toFixed(0)}%` };
    }
    // Volatile = high swing, no clear direction
    if (swing != null && swing > 25) {
      return { level: "caution", text: "Volatile", reason: `${rangeLbl} swing ${swing.toFixed(0)}%` };
    }
    // Rising
    if (slope != null && slope >= 8) {
      return { level: "good", text: "Rising", reason: `${rangeLbl} BB price up ${slope.toFixed(0)}%` };
    }
    if (swing != null && swing <= 10) {
      return { level: "good", text: "Stable", reason: `${rangeLbl} swing ${swing.toFixed(0)}%` };
    }
    return { level: "caution", text: "Mixed", reason: `${rangeLbl} swing ${swing != null ? swing.toFixed(0)+"%" : "?"}${slope != null ? ` · slope ${slope.toFixed(0)}%` : ""}` };
  }

  function classifyCompetitionRisk({ amz, pl, totalSellers, intel, sellerCountSource }) {
    const reasons = [];
    let score = 0; // 0 = low risk, higher = more risk
    if (amz.level === "bad")     { score += 3; reasons.push("Amazon dominates listing"); }
    else if (amz.level === "caution") { score += 1; reasons.push("Amazon present"); }
    if (pl.level === "bad")      { score += 2; reasons.push("Private-label risk"); }
    else if (pl.level === "caution") { score += 1; reasons.push("Possible PL"); }
    const sellerSuffix = sellerCountSource === "offers_list" ? " sellers from offer list" : " sellers";
    if (totalSellers >= 15)      { score += 2; reasons.push(`${totalSellers}${sellerSuffix}`); }
    else if (totalSellers >= 8)  { score += 1; reasons.push(`${totalSellers}${sellerSuffix}`); }
    const bsr = intel?.bsr_current;
    if (bsr != null && bsr > 500000) { score += 1; reasons.push(`Slow BSR #${bsr.toLocaleString()}`); }
    let level, text;
    if (score >= 4) { level = "bad";     text = "High"; }
    else if (score >= 2) { level = "caution"; text = "Medium"; }
    else { level = "good"; text = "Low"; }
    // Keep all contributing reasons (not just the top 2) — a Medium/High
    // score driven partly by Private-Label Risk must say so; silently
    // dropping it here was the actual bug (see buildHumanExplanation()
    // below, which used to reconstruct its own seller-count-only summary
    // instead of reading this field at all).
    return { level, text, reason: reasons.join(" · ") || "Clean competitive landscape" };
  }

  // Final action combines all signals into one of:
  // STRONG BUY · BUY · BUY (Cautious) · TEST ONLY · WATCH · AVOID
  function deriveFinalAction(profit, trend, comp, scorePct, ctx) {
    if (profit.level === "unknown") {
      return { action: "Enter cost", cls: "", level: "unknown", emoji: "💲",
        why: "Add your unit cost so we can evaluate the deal end-to-end." };
    }
    if (profit.level === "bad") {
      return { action: "AVOID", cls: "avoid", level: "bad", emoji: "❌",
        why: "Profit is too low to justify the buy at the current price." };
    }
    const bad = [trend.level, comp.level].filter(l => l === "bad").length;
    const caution = [trend.level, comp.level].filter(l => l === "caution").length;
    const strong = profit.level === "good" && trend.level === "good" && comp.level === "good"
      && (scorePct == null || scorePct >= 80);

    // ROI cushion: strong ROI + healthy profit + decent velocity + clean competition + FBA eligibility
    // should not be downgraded to TEST ONLY purely because the 3M trend is falling.
    const roi = ctx?.roi ?? 0;
    const prof = ctx?.profit ?? 0;
    const sales = ctx?.sales ?? 0;
    const eligOk = ctx?.elig?.level !== "bad"; // allow good or caution (Approval)
    const strongCushion = roi >= 50 && prof >= 5 && sales >= 50 && comp.level !== "bad" && eligOk;

    if (bad >= 1) {
      // Only the trend is bad and ROI cushion is strong → BUY CAUTIOUSLY instead of TEST ONLY.
      if (strongCushion && comp.level !== "bad" && trend.level === "bad") {
        const approvalNote = ctx?.elig?.level === "caution" ? " Confirm approval before scaling." : "";
        return { action: "BUY CAUTIOUSLY", cls: "buy", level: "good", emoji: "🟢",
          why: `ROI ${roi.toFixed(0)}% on $${prof.toFixed(2)} profit with ~${sales}/mo velocity gives enough cushion to absorb the falling trend — buy a small-to-medium lot and monitor.${approvalNote}` };
      }
      if (profit.level === "good") {
        return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨",
          why: "Strong current profit, but the market or competition is risky enough that deep inventory exposure is unsafe — buy shallow and monitor." };
      }
      return { action: "AVOID", cls: "avoid", level: "bad", emoji: "❌",
        why: "Thin profit combined with a risky market or heavy competition — skip this one." };
    }
    if (caution >= 2) {
      if (strongCushion) {
        return { action: "BUY CAUTIOUSLY", cls: "buy", level: "good", emoji: "🟢",
          why: `ROI ${roi.toFixed(0)}% and ~${sales}/mo velocity outweigh the mixed market/competition signals — buy a measured lot.` };
      }
      return { action: "WATCH", cls: "watch", level: "caution", emoji: "👀",
        why: "Mixed signals across market and competition — re-check before committing units." };
    }
    if (caution === 1) {
      if (profit.level === "good") {
        return { action: "BUY (Cautious)", cls: "buy", level: "good", emoji: "🟢",
          why: "Profit is solid and most signals are clean — one risk is worth monitoring before scaling." };
      }
      return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨",
        why: "Margin is thin and there is one risk flag — small lot only." };
    }
    if (strong) {
      return { action: "STRONG BUY", cls: "buy", level: "good", emoji: "🔥",
        why: "Profitable today with a stable market, low competition, and high overall confidence — a clean opportunity to scale." };
    }
    if (profit.level === "good") {
      return { action: "BUY", cls: "buy", level: "good", emoji: "✅",
        why: "Profitable today with a stable market and manageable competition." };
    }
    return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨",
      why: "Margins are thin even though market and competition are fine — start with a small test." };
  }

  // Compliance overlay — hazmat/prep never join the caution/bad counter.
  // Prepend a fixed clause and (only when signal is "yes") downgrade tier.
  // NOTE: the ipRisk branch was removed 2026-07-06 (no live signal was
  // ever wired). See .lovable/architecture-audit.md → "IP risk overlay".
  function applyComplianceOverlay(base, compliance) {
    if (!compliance) return { final: base, flags: [] };
    const flags = [];
    let action = base.action, cls = base.cls, level = base.level, emoji = base.emoji, why = base.why;
    const downgradeStrongToCautious = () => {
      if (action === "STRONG BUY" || action === "BUY") { action = "BUY (Cautious)"; cls = "buy"; level = "good"; emoji = "🟢"; }
    };
    const prefixes = [];

    if (compliance.hazmat === "yes") { flags.push("hazmat"); downgradeStrongToCautious(); prefixes.push("Hazmat flagged (verify DG classification before shipping)"); }
    else if (compliance.hazmat === "caution") { flags.push("hazmat_caution"); prefixes.push("Possible hazmat/meltable — confirm before shipping"); }
    if (prefixes.length) why = prefixes.join(" · ") + " — " + why;
    if (compliance.prep === "required") { flags.push("prep"); why = why + " Prep required (factor prep cost into ROI)."; }
    else if (compliance.prep === "caution") { flags.push("prep_caution"); why = why + " Confirm prep requirements at shipment-plan time."; }
    return { final: { action, cls, level, emoji, why }, flags };
  }

  function buildHumanExplanation(final, ctx, profit, trend, comp) {
    const parts = [final.why];
    // Cost-missing is a specific, fixable gap (ROI/Profit can't be computed
    // without it) — call it out plainly rather than letting the reader
    // assume the whole product's data is generally low-confidence.
    if (ctx.costMissing) {
      parts.push("Enter cost to calculate ROI, profit, and improve Decision Confidence.");
    }
    const detail = [];
    const basisLabel = ctx.simActive
      ? "Based on your Sim inputs"
      : (ctx.buyBoxPrice != null && ctx.buyBoxPrice > 0
          ? `Based on Buy Box $${ctx.buyBoxPrice.toFixed(2)}`
          : "Based on Buy Box price");
    detail.push(basisLabel);
    if (ctx.roi != null && ctx.profit != null) {
      detail.push(`ROI ${ctx.roi.toFixed(0)}% on $${ctx.profit.toFixed(2)} profit`);
    }
    if (ctx.sales) detail.push(`~${ctx.sales.toLocaleString()} sales/mo`);
    if (trend.reason) detail.push(trend.text + " market (" + trend.reason + ")");
    if (comp.text && comp.text !== "Low") {
      // comp.reason lists every factor that actually drove the score
      // (Amazon presence, Private-Label Risk, seller count, slow BSR) —
      // showing it here, instead of a seller-count-only summary, is what
      // makes "Medium/High competition" traceable back to Private-Label
      // Risk when that's part of why.
      detail.push(comp.text + " competition (" + comp.reason + ")");
    }
    if (ctx.elig?.text && ctx.elig.level !== "good") detail.push(ctx.elig.text);
    if (detail.length) parts.push(detail.join(" · "));
    return parts.join(" ");
  }

  function renderDecisionMatrix(ctx) {
    const profit = classifyProfitToday(ctx.roi, ctx.profit, ctx.elig.level);
    const trend  = classifyMarketTrend();
    const comp   = classifyCompetitionRisk(ctx);
    const baseFinal = deriveFinalAction(profit, trend, comp, ctx.scorePct, ctx);
    const overlaid = applyComplianceOverlay(baseFinal, ctx.compliance);
    const basisPrefix = ctx.simActive ? "(Sim — your inputs) " : "(Buy Box price) ";
    const final = { ...overlaid.final, why: basisPrefix + overlaid.final.why };

    const setPill = (id, cls, txt) => {
      const el = $(id); if (!el) return;
      el.className = "apx-dm-pill " + (cls || "");
      el.textContent = txt;
    };
    setPill("apx-dm-profit", profit.level, profit.text);
    setPill("apx-dm-trend",  trend.level,  trend.text);
    setPill("apx-dm-comp",   comp.level,   comp.text);
    setPill("apx-dm-elig",   ctx.elig.level, ctx.elig.text);

    let salesLevel = "unknown", salesText = "—";
    if (ctx.sales != null) {
      if (ctx.sales >= 100)      { salesLevel = "good";    salesText = `${ctx.sales}/mo`; }
      else if (ctx.sales >= 30)  { salesLevel = "good";    salesText = `${ctx.sales}/mo`; }
      else if (ctx.sales >= 5)   { salesLevel = "caution"; salesText = `${ctx.sales}/mo`; }
      else                       { salesLevel = "bad";     salesText = `${ctx.sales}/mo`; }
    }
    setPill("apx-dm-sales", salesLevel, salesText);

    // Final Decision block
    const wrap = $("apx-final-decision");
    if (wrap) wrap.className = "apx-final-decision " + final.level;
    const emojiEl = $("apx-fd-emoji");
    if (emojiEl) emojiEl.textContent = final.emoji;
    const act = $("apx-dm-action");
    if (act) {
      act.className = "apx-fd-action " + (final.cls || "");
      act.textContent = final.action;
    }
    // Decision Confidence reflects the overall BUY/SKIP verdict (ROI, eligibility,
    // Amazon share, PL risk, BSR, sales, seller count) — NOT the same thing as
    // the Private-Label Risk % above, which only reflects Keepa's historical
    // data and never changes based on cost. When cost hasn't been entered,
    // ROI/Profit can't be computed at all, so we say so plainly instead of
    // showing a bare "Low" that reads like a general data problem.
    const conf = $("apx-fd-confidence");
    if (conf) {
      if (ctx.costMissing) {
        conf.textContent = "Low — cost required";
      } else {
        const p = ctx.scorePct;
        conf.textContent = p == null ? "—" : p >= 75 ? "High" : p >= 55 ? "Medium" : "Low";
      }
    }
    const scoreEl = $("apx-sa-verdict-score");
    if (scoreEl) scoreEl.textContent = ctx.scorePct != null ? `${Math.round(ctx.scorePct)}/100` : "";

    const why = $("apx-dm-why");
    if (why) {
      why.textContent = buildHumanExplanation(final, ctx, profit, trend, comp);
      // "Possible PL" / "Private-label risk" in the competition breakdown
      // is a compact label, not an explanation — hover the whole sentence
      // to see the same Private-Label Risk reasoning shown on the summary
      // row above (ctx.plCaption, from computePrivateLabelRisk()).
      const plMentioned = /Possible PL|Private-label risk/.test(comp.reason || "");
      why.title = plMentioned && ctx.plCaption ? `"Possible PL" means: ${ctx.plCaption}` : "";
      why.classList.toggle("apx-help-cursor", !!why.title);
    }

    console.log("[InventorySprint] Final Decision", {
      action: final.action, confidence: conf?.textContent,
      profit: profit.text, trend: trend.text, comp: comp.text,
    });

    // Stash the last decision payload so the debug button can copy it.
    try {
      window.__apxLastDecision = {
        asin: state.asin || null,
        marketplace: state.marketplace || "US",
        range: state.range || null,
        capturedAt: new Date().toISOString(),
        inputs: {
          roi: ctx.roi, profit: ctx.profit, sales: ctx.sales, bsr: ctx.bsr,
          elig: ctx.elig, amz: ctx.amz, pl: ctx.pl, intel: ctx.intel,
          totalSellers: ctx.totalSellers, scorePct: ctx.scorePct,
          sellerCountSource: ctx.sellerCountSource,
          offerCountFba: ctx.offerCountFba, offerCountFbm: ctx.offerCountFbm,
          buyBoxPrice: ctx.buyBoxPrice, simActive: ctx.simActive,
          compliance: ctx.compliance,
        },
        classifiers: { profit, trend, comp },
        baseFinal, overlaid, final,
      };
    } catch (e) { console.debug("[apx] stash decision failed", e?.message || e); }

    // Fire-and-forget: persist this scan into analyzer_decision_log.
    try { logAnalyzerDecisionFromCtx(ctx, final, profit, trend, comp); } catch (e) { console.warn("[DM] log failed", e); }

    // Brand History card disabled 2026-08-07 — too technical for regular
    // users (raw Unknown/Low/Medium counts, no plain-language takeaway).
    // fetchBrandHistory()/renderBrandHistory() and the backend
    // brand-history-lookup function are left in place, unused, in case an
    // admin-facing view wants this data later.
  }

  // ── Brand History: "other ASINs from this brand" pooled across every
  // extension user's scans (analyzer_decision_log), not just this one ASIN.
  function renderBrandHistory(data) {
    const el = $("apx-brand-history");
    if (!el) return;
    if (!data) { el.hidden = true; el.innerHTML = ""; el.className = "apx-brand-history"; return; }
    el.hidden = false;
    if (data.loading) {
      el.className = "apx-brand-history";
      el.innerHTML = `<div class="apx-brand-history-head">🏷 Brand History</div>Checking other scans for this brand…`;
      return;
    }
    if (!data.hasEnoughData) {
      el.className = "apx-brand-history";
      el.innerHTML = `<div class="apx-brand-history-head">🏷 Brand History</div>Not enough shared data yet for this brand — you're one of the first to scan it here.`;
      return;
    }
    const plCounts = data.plRiskCounts || {};
    const riskyCount = (plCounts["Medium"] || 0) + (plCounts["High"] || 0);
    const avoidCount = (data.decisionCounts || {})["AVOID"] || 0;
    const plParts = Object.entries(plCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([level, n]) => `${n} ${level}`)
      .join(" · ");
    const isRisky = (riskyCount / data.distinctAsins) >= 0.4 || (avoidCount / data.distinctAsins) >= 0.3;
    el.className = "apx-brand-history" + (isRisky ? " caution" : "");
    const n = data.distinctAsins;
    el.innerHTML = `<div class="apx-brand-history-head">🏷 Brand History (${n} other ASIN${n === 1 ? "" : "s"} scanned)</div>`
      + `Private-Label Risk: ${plParts || "—"}${avoidCount ? ` · ${avoidCount} previously marked AVOID` : ""}`;
  }

  function fetchBrandHistory(brand, asin) {
    const b = String(brand || "").trim();
    const a = String(asin || "").trim().toUpperCase();
    if (!b) { brandHistoryState.key = null; renderBrandHistory(null); return; }
    const key = `${b}::${a}`;
    if (brandHistoryState.key === key) return; // already fetched/fetching for this exact scan
    brandHistoryState.key = key;
    renderBrandHistory({ loading: true });
    chrome.runtime.sendMessage({ type: "ARBIPRO_INVOKE", fn: "brand-history-lookup", body: { brand: b, asin: a } }, (r) => {
      if (brandHistoryState.key !== key) return; // stale response — ASIN changed since this fired
      if (r?.ok && r.data && !r.data.error) {
        renderBrandHistory(r.data);
      } else {
        console.warn("[BrandHistory] lookup failed", r?.error || r?.data?.error);
        renderBrandHistory(null);
      }
    });
  }

  // ── Decision Memory: capture every analyzer scan + Buy/Skip/Watch ──
  function logAnalyzerDecisionFromCtx(ctx, final, profit, trend, comp) {
    if (!state.signedIn || !state.asin) return;
    const asin = String(state.asin).toUpperCase();
    const marketplace = String(state.marketplace || "US").toUpperCase();
    const key = `${marketplace}:${asin}`;
    const now = Date.now();
    if (dmState.key === key && (now - dmState.lastLogAt) < DM_DEDUP_MS) return;

    const offers = state.history?.offers?.list || [];
    const bbOffer = offers.find(o => o.isBuyBox);
    const bb = bbOffer?.landed ?? null;
    const fbaPrices = offers.filter(o => o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const fbmPrices = offers.filter(o => !o.isFBA).map(o => o.landed).filter(Number.isFinite);
    const lowestFba = fbaPrices.length ? Math.min(...fbaPrices) : null;
    const lowestFbm = fbmPrices.length ? Math.min(...fbmPrices) : null;
    const intel = state.stability?.intel || {};
    const totalCost = parseFloat($("apx-cost")?.value) || null;
    const units = parseInt($("apx-units")?.value || "1", 10) || 1;
    const saleOverride = parseFloat($("apx-sale")?.value);
    const unitCost = totalCost ? totalCost / units : null;
    const fees = state.fees || null;
    const unitFees = getActualFeeTotal(fees);
    const salePrice = isFinite(saleOverride) && saleOverride > 0 ? saleOverride : pickAnchorPrice(offers, state.sellerMode);
    const margin = (salePrice && ctx.profit != null && salePrice > 0) ? (ctx.profit / salePrice) * 100 : null;
    const confidence = ctx.scorePct == null ? null : ctx.scorePct >= 75 ? "High" : ctx.scorePct >= 55 ? "Medium" : "Low";
    const approvalStatus = currentApprovalStatusForStorage();

    const row = {
      asin,
      marketplace,
      // source injected by background.js
      cost: unitCost,
      fees: unitFees,
      sale_price: salePrice,
      roi: ctx.roi,
      profit: ctx.profit,
      margin,
      bsr: intel.bsr_current ?? null,
      est_sales_month: ctx.sales ?? null,
      buy_box: bb,
      lowest_fba: lowestFba,
      lowest_fbm: lowestFbm,
      seller_count: (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0) || null,
      swing_3m: state.range === "90" ? (state.stability?.swing_pct ?? null) : null,
      swing_6m: state.range === "180" ? (state.stability?.swing_pct ?? null) : null,
      swing_1y: state.range === "365" ? (state.stability?.swing_pct ?? null) : null,
      eligibility: ctx.elig?.text || null,
      competition_level: comp?.text || null,
      // Was defined in the schema but never actually populated — this is
      // the data collection this row now exists to feed: brand-level
      // history aggregated across every user's scans (see
      // brand-history-lookup edge function).
      pl_risk: ctx.plRiskLabel || null,
      final_decision: final?.action || null,
      confidence,
      ai_reasoning: ($("apx-dm-why")?.textContent || "").slice(0, 1000) || null,
      raw_snapshot: {
        url: state._url || null,
        scorePct: ctx.scorePct,
        intel,
        fees,
        eligibility: approvalStatus,
        stability_verdict: state.stability?.verdict || null,
        range: state.range,
        plRiskPct: ctx.plRiskPct ?? null,
      },
      // Lightweight metadata for future pattern mining.
      category: state.stability?.intel?.category || state.product?.category || null,
      brand: state.stability?.intel?.brand || state.product?.brand || null,
      amazon_presence: offers.some(o => o.isAmazon) ? "present" : (offers.length ? "absent" : "unknown"),
      source_surface: "extension",
      active_range_viewed: RANGE_LABELS[state.range] || null,
      data_freshness: state.cached ? "cached" : "live",
      retrieval_state: offers.length ? "ok" : "partial",
    };


    // Mark as in-flight before the round trip so re-renders don't double-fire.
    dmState.key = key;
    dmState.lastLogAt = now;
    dmState.decisionId = null;
    dmState.recorded = null;
    updateDmUi("saving");

    chrome.runtime.sendMessage({ type: "ARBIPRO_LOG_DECISION", row }, (r) => {
      if (r?.ok && r.data?.id) {
        dmState.decisionId = r.data.id;
        updateDmUi("ready");
      } else {
        console.warn("[DM] log error", r?.error);
        updateDmUi("error");
      }
    });
  }

  function updateDmUi(stateName) {
    const wrap = $("apx-dm-memory"); if (!wrap) return;
    const status = $("apx-dm-memory-status");
    const buttons = ["apx-dm-buy", "apx-dm-skip", "apx-dm-watch"].map((id) => $(id));
    if (stateName === "saving") {
      if (status) status.textContent = "Saving scan…";
      buttons.forEach((b) => { if (b) { b.disabled = true; b.classList.remove("active"); } });
    } else if (stateName === "ready") {
      if (status) status.textContent = dmState.recorded ? `Recorded: ${dmState.recorded.toUpperCase()}` : "Ready — tell us what you decided";
      buttons.forEach((b) => {
        if (!b) return;
        b.disabled = false;
        b.classList.toggle("active", b.dataset.action === dmState.recorded);
      });
    } else if (stateName === "error") {
      if (status) status.textContent = "Save failed — retry on next scan";
      buttons.forEach((b) => { if (b) b.disabled = true; });
    }
  }

  function wireDecisionMemoryButtons() {
    ["apx-dm-buy", "apx-dm-skip", "apx-dm-watch"].forEach((id) => {
      const btn = $(id); if (!btn) return;
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (!dmState.decisionId) return;
        if (dmState.pending) return;
        dmState.pending = true;
        const status = $("apx-dm-memory-status");
        if (status) status.textContent = `Saving ${action}…`;
        chrome.runtime.sendMessage({
          type: "ARBIPRO_RECORD_DECISION_ACTION",
          row: {
            decision_id: dmState.decisionId,
            asin: String(state.asin || "").toUpperCase(),
            marketplace: String(state.marketplace || "US").toUpperCase(),
            action,
          },
        }, (r) => {
          dmState.pending = false;
          if (r?.ok) {
            dmState.recorded = action;
            updateDmUi("ready");
          } else {
            console.warn("[DM] action error", r?.error);
            if (status) status.textContent = `Failed: ${r?.error || "unknown"}`;
          }
        });
      });
    });
  }
  wireDecisionMemoryButtons();


  // ── Price History chart (Buy Box / Amazon / FBA / FBM) ─────────────
  // Same data source and series as the UPC scanner's Price History &
  // Live Offers chart (mobile-scan-price-history), redrawn on <canvas>
  // since the extension has no chart library available.
  const HISTORY_SERIES = [
    { key: "buybox", color: "#34d399" },
    { key: "amazon", color: "#f97316" },
    { key: "newFba", color: "#60a5fa" },
    { key: "newFbm", color: "#a78bfa" },
  ];

  // Mirrors classifyMarketTrend()'s own series preference, so the min/max
  // shown next to the verdict matches whatever the verdict was computed from.
  function pickStabilitySeries() {
    const s = state.history?.series || {};
    const pick = (arr) => (arr || []).filter(p => Number.isFinite(p.v) && p.v > 0);
    const bb = pick(s.buybox);
    if (bb.length >= 5) return bb;
    const fba = pick(s.newFba);
    if (fba.length >= 5) return fba;
    const amz = pick(s.amazon);
    if (amz.length >= 5) return amz;
    return pick(s.newFbm);
  }

  // Geometry from the last successful draw, reused by the hover handler so
  // it doesn't need to recompute scales on every mousemove.
  let historyGeom = null;
  // Includes the year — ranges now go back up to 5Y / Since Listed, so
  // "Aug 15" alone (no year) is ambiguous across a multi-year chart.
  const fmtHistDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // Pure drawing pass — gridlines, axis labels, and the 4 series lines.
  // Returns the chart geometry (or null if there's no data) so callers can
  // reuse xScale/yScale/seriesData for hover interaction.
  function drawHistoryChart() {
    const cv = $("apx-history-chart");
    if (!cv) return null;
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 320, cssH = cv.clientHeight || 180;
    if (cv.width !== cssW * dpr || cv.height !== cssH * dpr) { cv.width = cssW * dpr; cv.height = cssH * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const seriesData = HISTORY_SERIES.map(s => ({
      ...s,
      pts: (state.history?.series?.[s.key] || []).filter(p => Number.isFinite(p.v) && p.v > 0),
    }));
    const allPts = seriesData.flatMap(s => s.pts);

    if (allPts.length < 2) {
      ctx.fillStyle = "#a4b0d4";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillText("No price history yet", 8, cssH / 2 + 4);
      return null;
    }

    const xs = allPts.map(p => +new Date(p.t));
    const ys = allPts.map(p => p.v);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const padL = 34, padR = 6, padT = 8, padB = 16;
    const w = cssW - padL - padR, h = cssH - padT - padB;
    const xScale = (x) => padL + ((x - xMin) / Math.max(1, xMax - xMin)) * w;
    const yScale = (y) => padT + (1 - (y - yMin) / Math.max(0.0001, yMax - yMin)) * h;

    // Gridlines + $ labels
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "#a4b0d4";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.lineWidth = 1;
    const GRID_LINES = 4;
    for (let i = 0; i <= GRID_LINES; i++) {
      const y = padT + (h / GRID_LINES) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      const val = yMax - ((yMax - yMin) / GRID_LINES) * i;
      ctx.fillText(`$${val.toFixed(0)}`, 2, y + 3);
    }

    // X-axis date labels (start / end)
    ctx.textAlign = "left";
    ctx.fillText(fmtHistDate(xMin), padL, cssH - 4);
    ctx.textAlign = "right";
    ctx.fillText(fmtHistDate(xMax), cssW - padR, cssH - 4);
    ctx.textAlign = "left";

    // Each series drawn as its own line, Buy Box slightly thicker (primary)
    seriesData.forEach(s => {
      if (s.pts.length < 2) return;
      ctx.beginPath();
      s.pts.forEach((p, i) => {
        const X = xScale(+new Date(p.t)), Y = yScale(p.v);
        i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.key === "buybox" ? 2 : 1.5;
      ctx.stroke();
    });

    // Last-point dot on Buy Box, if present
    const bbPts = seriesData.find(s => s.key === "buybox")?.pts || [];
    if (bbPts.length) {
      const last = bbPts[bbPts.length - 1];
      const lx = xScale(+new Date(last.t)), ly = yScale(last.v);
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    return { cssW, cssH, xMin, xMax, yMin, yMax, padL, padR, padT, padB, xScale, yScale, seriesData };
  }

  function renderHistoryChart() {
    historyGeom = drawHistoryChart();
    const verdictEl = $("apx-history-verdict");
    if (!verdictEl) return;
    if (!historyGeom) {
      verdictEl.textContent = "—";
      verdictEl.className = "apx-history-verdict apx-sa-unknown";
      return;
    }
    // Stability verdict — same classifier that drives the decision engine's
    // "Mixed market (3M swing 24% · slope -6%)" text, so the two never disagree.
    const trend = classifyMarketTrend();
    const stabVals = pickStabilitySeries().map(p => p.v);
    const rangeText = stabVals.length
      ? ` (${fmtMoney(Math.min(...stabVals), state.currency)}–${fmtMoney(Math.max(...stabVals), state.currency)})`
      : "";
    verdictEl.className = "apx-history-verdict apx-sa-" + trend.level;
    verdictEl.textContent = (trend.reason ? `${trend.text} — ${trend.reason}` : trend.text) + rangeText;
  }

  // ── Hover interactivity: crosshair + tooltip showing every line's value ──
  function findNearestPoint(pts, targetMs) {
    if (!pts.length) return null;
    let best = pts[0], bestDiff = Math.abs(+new Date(pts[0].t) - targetMs);
    for (const p of pts) {
      const diff = Math.abs(+new Date(p.t) - targetMs);
      if (diff < bestDiff) { best = p; bestDiff = diff; }
    }
    return best;
  }

  const SERIES_LABELS = { buybox: "Buy Box", amazon: "Amazon", newFba: "FBA", newFbm: "FBM" };

  function handleHistoryHover(evt) {
    if (!historyGeom) return;
    const cv = $("apx-history-chart");
    const tip = $("apx-history-tooltip");
    if (!cv || !tip) return;
    const rect = cv.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    const { xMin, xMax, padL, xScale, yScale, seriesData, cssW } = historyGeom;

    // Invert xScale to find the date under the cursor
    const clampedX = Math.max(padL, Math.min(mouseX, cssW - historyGeom.padR));
    const targetMs = xMin + ((clampedX - padL) / Math.max(1, (cssW - historyGeom.padR - padL))) * (xMax - xMin);

    // Redraw the clean chart, then overlay a crosshair + per-series dots
    drawHistoryChart();
    const cv2 = cv.getContext("2d");
    cv2.strokeStyle = "rgba(255,255,255,0.35)";
    cv2.lineWidth = 1;
    cv2.beginPath();
    cv2.moveTo(clampedX, historyGeom.padT);
    cv2.lineTo(clampedX, historyGeom.cssH - historyGeom.padB);
    cv2.stroke();

    const rows = [];
    let nearestDate = null;
    seriesData.forEach(s => {
      const near = findNearestPoint(s.pts, targetMs);
      if (!near) return;
      if (nearestDate == null || Math.abs(+new Date(near.t) - targetMs) < Math.abs(nearestDate - targetMs)) {
        nearestDate = +new Date(near.t);
      }
      const X = xScale(+new Date(near.t)), Y = yScale(near.v);
      cv2.fillStyle = s.color;
      cv2.beginPath();
      cv2.arc(X, Y, 3, 0, Math.PI * 2);
      cv2.fill();
      rows.push(`<div class="apx-ht-row"><span class="apx-ht-dot" style="background:${s.color}"></span>${SERIES_LABELS[s.key]}: <strong>${fmtMoney(near.v, state.currency)}</strong></div>`);
    });

    if (!rows.length) { tip.hidden = true; return; }
    tip.innerHTML = `<span class="apx-ht-date">${fmtHistDate(nearestDate ?? targetMs)}</span>${rows.join("")}`;
    tip.hidden = false;
    // Keep the tooltip inside the chart bounds — flip to the left of the
    // cursor once it would otherwise overflow the right edge.
    const tipWidth = tip.offsetWidth || 120;
    const left = (mouseX + tipWidth + 12 > cssW) ? Math.max(4, mouseX - tipWidth - 8) : mouseX + 8;
    tip.style.left = `${left}px`;
  }

  (function wireHistoryHover() {
    const cv = $("apx-history-chart");
    if (!cv) return;
    cv.addEventListener("mousemove", handleHistoryHover);
    cv.addEventListener("mouseleave", () => {
      const tip = $("apx-history-tooltip");
      if (tip) tip.hidden = true;
      drawHistoryChart();
    });
  })();

  // ── Wire up UI ─────────────────────────────────────────────────────
  // Sale (apx-sale) is read-only — it always reflects the freshly-retrieved
  // Buy Box price (set in renderRoiAndSignal) and isn't user-editable, so it
  // has no input listener here.
  ["apx-cost", "apx-units"].forEach((id) => {
    $(id).addEventListener("input", async () => {
      renderRoiAndSignal();
      renderSellers();
      if (state.asin) {
        await saveCost(state.asin, {
          totalCost: $("apx-cost").value, units: $("apx-units").value,
        });
      }
    });
  });

  $("apx-refresh").addEventListener("click", () => loadData(true));
  const metaRecheckBtn = $("apx-meta-recheck");
  if (metaRecheckBtn) metaRecheckBtn.addEventListener("click", () => loadData(true));

  // What-if simulator → price alert. Uses the slider's current simulated
  // Amazon price (state.simCurrentSale, set in renderSimulator()) as the
  // alert target — no separate "min price" field, since the slider IS that
  // number. Any email the user types is accepted; create-price-alert sends
  // a confirm-first email rather than activating immediately.
  const simAlertBtn = $("apx-sim-alert-btn");
  if (simAlertBtn) {
    simAlertBtn.addEventListener("click", async () => {
      const statusEl = $("apx-sim-alert-status");
      const emailInput = $("apx-sim-alert-email");
      const email = (emailInput?.value || "").trim();
      const targetPrice = state.simCurrentSale;
      const showStatus = (msg, ok) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.className = "apx-sim-alert-status " + (ok ? "ok" : "err");
        statusEl.classList.remove("hidden");
      };
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showStatus("Enter a valid email address.", false);
        return;
      }
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
        showStatus("Move the slider to set a target price first.", false);
        return;
      }
      if (!state.asin) {
        showStatus("No ASIN loaded.", false);
        return;
      }
      simAlertBtn.disabled = true;
      const prevText = simAlertBtn.textContent;
      simAlertBtn.textContent = "Sending…";
      try {
        const resp = await bg("ARBIPRO_INVOKE", {
          fn: "create-price-alert",
          body: { asin: state.asin, marketplace: state.marketplace, targetPrice, notifyEmail: email },
        });
        showStatus(resp?.data?.message || `Confirmation email sent to ${email} — click the link in that email to activate the alert.`, true);
      } catch (e) {
        showStatus(`Could not set alert: ${e?.message || e}`, false);
      } finally {
        simAlertBtn.disabled = false;
        simAlertBtn.textContent = prevText;
      }
    });
  }
  const retryEl = $("apx-signal-retry");
  if (retryEl) {
    retryEl.addEventListener("click", async () => {
      retryEl.disabled = true;
      const prev = retryEl.textContent;
      retryEl.textContent = "Fetching…";
      try { await loadData(true); } finally {
        retryEl.disabled = false;
        retryEl.textContent = prev;
      }
    });
  }

  // Range tabs (3M / 6M / 1Y) — refetch history+stability and persist choice
  function applyRangeTabs() {
    document.querySelectorAll(".apx-range-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.range === state.range);
    });
    const lbl = RANGE_LABELS[state.range] ? `${RANGE_LABELS[state.range]} swing` : "Swing";
    const el = $("apx-swing-label"); if (el) el.textContent = lbl;
  }
  document.querySelectorAll(".apx-range-tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = btn.dataset.range;
      if (!r || r === state.range) return;
      state.range = r;
      await chrome.storage.local.set({ "arbipro_range": r });
      applyRangeTabs();
      loadData(false);
    });
  });
  $("apx-sim-slider").addEventListener("input", () => renderRoiAndSignal());

  let collapsed = false;
  function applyCollapsed(next) {
    collapsed = !!next;
    $("apx-body").classList.toggle("hidden", collapsed);
    $("apx-collapse").textContent = collapsed ? "+" : "–";
    postHost({ type: "COLLAPSE_TOGGLE", collapsed });
  }
  $("apx-collapse").addEventListener("click", () => applyCollapsed(!collapsed));
  $("apx-close").addEventListener("click", () => postHost({ type: "CLOSE" }));
  $("apx-reset").addEventListener("click", () => postHost({ type: "RESET_POS" }));

  // Alt+A inside iframe → bubble to host
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      postHost({ type: "TOGGLE_VISIBILITY" });
    }
  });

  // Drag disabled — analyzer is fixed in place (per user request).
  (() => {
    const handle = $("apx-drag");
    if (handle) handle.style.cursor = "default";
  })();
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
      await bg("ARBIPRO_SIGN_IN_PASSWORD", { email, password }, { timeoutMs: 12000 });
      $("apx-signin-password").value = "";
      // No explicit refresh here — the chrome.storage.onChanged listener
      // below already calls checkSession() the moment setSession() writes
      // the new session, so an explicit call here was just a redundant
      // second refresh racing the same one.
    } catch (err) {
      errEl.textContent = String(err?.message || err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  // ── Debug: copy the raw final-decision payload (inputs + verdict + compliance) ──
  (function wireDecisionDebugCopy() {
    const btn = $("apx-fd-copy-debug");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const payload = window.__apxLastDecision || { error: "No decision computed yet — open the panel on an ASIN first." };
      const json = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard.writeText(json);
        const prev = btn.textContent;
        btn.textContent = "✅ Copied — paste into chat";
        setTimeout(() => { btn.textContent = prev; }, 1800);
      } catch (e) {
        console.log("[apx][decision-debug]", payload);
        const prev = btn.textContent;
        btn.textContent = "⚠ Clipboard blocked — logged to console";
        setTimeout(() => { btn.textContent = prev; }, 2400);
      }
    });
  })();



  // ── Decision Memory export (feeds Lovable/AI for pattern analysis) ──
  (function wireDecisionMemoryExport() {
    const jsonBtn = $("apx-dm-export-json");
    const csvBtn  = $("apx-dm-export-csv");
    const statusEl = $("apx-dm-export-status");
    if (!jsonBtn || !csvBtn) return;

    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.className = "apx-dm-export-status" + (kind ? " " + kind : "");
      statusEl.textContent = msg || "";
    }
    function download(filename, content, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    }
    function toCsv(rows) {
      if (!rows || !rows.length) return "";
      const cols = Array.from(rows.reduce((s, r) => { Object.keys(r || {}).forEach(k => s.add(k)); return s; }, new Set()));
      const esc = (v) => {
        if (v == null) return "";
        if (typeof v === "object") v = JSON.stringify(v);
        const str = String(v);
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const header = cols.join(",");
      const body = rows.map(r => cols.map(c => esc(r?.[c])).join(",")).join("\n");
      return header + "\n" + body;
    }
    function tsStamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    }

    async function fetchMemory() {
      setStatus("Exporting your decision memory…");
      jsonBtn.disabled = true; csvBtn.disabled = true;
      try {
        const resp = await bg("ARBIPRO_EXPORT_DECISION_MEMORY");
        return resp?.data || { logs: [], actions: [] };
      } finally {
        jsonBtn.disabled = false; csvBtn.disabled = false;
      }
    }

    jsonBtn.addEventListener("click", async () => {
      try {
        const data = await fetchMemory();
        const payload = {
          schema_version: 1,
          exported_at: data.exported_at || new Date().toISOString(),
          source: "extension",
          counts: { logs: data.logs?.length || 0, actions: data.actions?.length || 0 },
          analyzer_decision_log: data.logs || [],
          analyzer_decision_action: data.actions || [],
        };
        download(`arbipro-decision-memory-${tsStamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
        setStatus(`Exported ${payload.counts.logs} scans + ${payload.counts.actions} actions (JSON).`, "ok");
      } catch (e) {
        setStatus("Export failed: " + (e?.message || e), "err");
      }
    });

    csvBtn.addEventListener("click", async () => {
      try {
        const data = await fetchMemory();
        const logsCsv = toCsv(data.logs || []);
        const actionsCsv = toCsv(data.actions || []);
        const stamp = tsStamp();
        download(`arbipro-decision-log-${stamp}.csv`, logsCsv, "text/csv");
        // Small delay so browsers don't merge the two downloads.
        setTimeout(() => download(`arbipro-decision-actions-${stamp}.csv`, actionsCsv, "text/csv"), 400);
        setStatus(`Exported ${data.logs?.length || 0} scans + ${data.actions?.length || 0} actions (CSV).`, "ok");
      } catch (e) {
        setStatus("Export failed: " + (e?.message || e), "err");
      }
    });
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.arbipro_session) checkSession();
  });

  // ── Receive ASIN updates from content script ───────────────────────
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.source !== "arbipro-host") return;
    if (d.type === "RESTORE_STATE") {
      applyCollapsed(!!d.collapsed);
      return;
    }
    if (d.type === "ASIN_CHANGED") {
      const changed = d.asin !== state.asin || d.marketplace !== state.marketplace;
      state.asin = d.asin;
      state.marketplace = d.marketplace || "US";
      // Set currency from marketplace IMMEDIATELY so USD→local cost conversion
      // works even before fetch-listing-snapshot returns. product-data may
      // override later if it returns a more specific `currency` field.
      state.currency = currencyForMarketplace(state.marketplace);
      state._url = d.url || null;
      // Make sure FX is loaded so non-US ROI is correct immediately.
      ensureFxRates().then(() => renderRoiAndSignal());
      if (changed) {
        state.fees = null;
        state.feesRefPrice = null;

        state.history = null;
        state.stability = null;
        state.dims = null;
        state.product = null;
        state.cached = false;
        state.fetched_at = null;
      }
      renderMeta();
      if (state.asin) {
        const c = await loadCost(state.asin);
        // Sale is read-only and always reflects the live Buy Box price —
        // never restore a persisted value here; renderRoiAndSignal() sets it
        // once fresh offers load below.
        $("apx-cost").value = c.totalCost; $("apx-units").value = c.units;
      }
      if (changed && state.asin) loadData(false);
    }
  });

  // Seller mode (FBA vs FBM) — global preference, persisted
  const sellerModeEl = $("apx-seller-mode");
  if (sellerModeEl) {
    sellerModeEl.addEventListener("change", async () => {
      state.sellerMode = sellerModeEl.value === "FBM" ? "FBM" : "FBA";
      await chrome.storage.local.set({ arbipro_seller_mode: state.sellerMode });
      renderHistory();
      renderRoiAndSignal();
      renderSellers();
    });
  }

  // Init
  (async () => {
    const o = await chrome.storage.local.get(["arbipro_range", "arbipro_seller_mode"]);
    if (o.arbipro_range && Object.prototype.hasOwnProperty.call(RANGE_LABELS, o.arbipro_range)) {
      state.range = o.arbipro_range;
    }
    if (o.arbipro_seller_mode === "FBA" || o.arbipro_seller_mode === "FBM") {
      state.sellerMode = o.arbipro_seller_mode;
    }
    if (sellerModeEl) sellerModeEl.value = state.sellerMode;
    applyRangeTabs();
    await checkSession();
    ensureFxRates();
    postHost({ type: "READY" });
    // Re-check session every 10s in case user just signed in
    setInterval(checkSession, 10_000);
  })();
})();
