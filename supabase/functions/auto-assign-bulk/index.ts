import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkModuleAccess } from "../_shared/module-access-guard.ts";
import { getListingUnitCost } from "../_shared/cost-contract.ts";
import { exchangeLwaToken } from "../_shared/lwa-token.ts";
import { getSpApiEndpoint, signRequest } from "../_shared/sp-api-sigv4.ts";
import { resolveMinRoiEnabled } from "../_shared/min-roi-enabled.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { detectIsFba } from "../_shared/fulfillment-channel.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// PostgREST caps unpaginated selects at ~1000 rows by default, silently
// dropping the rest. Page through with .range() so every row is actually
// considered (same pattern as cleanup-dead-assignments/index.ts).
async function fetchAllRows(
  supabase: any,
  table: string,
  select: string,
  applyFilters: (q: any) => any,
  pageSize = 1000,
): Promise<any[]> {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await applyFilters(
      supabase.from(table).select(select).order("id", { ascending: true }),
    ).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const MARKETPLACE_ID_MAP: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

const pickPositive = (...values: Array<number | null | undefined>) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function calcRoiAtPrice(unitCostLocal: number, price: number, referralRate: number, fixedFeesLocal: number): number | null {
  if (!unitCostLocal || unitCostLocal <= 0 || !price || price <= 0) return null;
  const totalFees = (price * referralRate) + fixedFeesLocal;
  const profit = price - totalFees - unitCostLocal;
  return Math.round((profit / unitCostLocal) * 1000) / 10;
}

function extractOwnListingPrice(listingData: any): number | null {
  const offers = Array.isArray(listingData?.offers) ? listingData.offers : [];
  for (const offer of offers) {
    const raw = offer.price?.amount ??
      offer.price?.listingPrice?.amount ??
      offer.listingPrice?.amount ??
      offer.ourPrice?.amount ??
      offer.regularPrice?.amount ??
      offer.offerPrice?.amount ??
      offer.purchasableOffer?.price?.amount;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const summaries = Array.isArray(listingData?.summaries) ? listingData.summaries : [];
  for (const summary of summaries) {
    const n = Number(summary.price?.listingPrice?.amount ?? summary.price?.amount);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const purchasableOffer = Array.isArray(listingData?.attributes?.purchasable_offer)
    ? listingData.attributes.purchasable_offer
    : [];
  for (const po of purchasableOffer) {
    const n = Number(po.our_price?.[0]?.schedule?.[0]?.value_with_tax);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

async function fetchLiveOwnPrice(params: {
  supabase: any;
  userId: string;
  sellerAuth: any;
  sku: string;
  marketplaceId: string;
}): Promise<number | null> {
  const { supabase, userId, sellerAuth, sku, marketplaceId } = params;
  await waitForApiToken(supabase, "listings_api");
  const accessToken = await exchangeLwaToken(sellerAuth.refresh_token, supabase, userId);
  const endpoint = getSpApiEndpoint(marketplaceId);
  const path = `/listings/2021-08-01/items/${sellerAuth.seller_id}/${encodeURIComponent(sku)}`;
  const url = `${endpoint}${path}?marketplaceIds=${marketplaceId}&includedData=offers,summaries,attributes&issueLocale=en_US`;
  const headers = await signRequest("GET", url, "", accessToken);
  const response = await fetch(url, { method: "GET", headers: { ...headers, "Content-Type": "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`[auto-assign-bulk] Live price fetch failed SKU=${sku} marketplaceId=${marketplaceId}: ${response.status} ${text.slice(0, 300)}`);
    return null;
  }
  return extractOwnListingPrice(JSON.parse(text));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth — supports both user token and service role
    const authHeader = req.headers.get("Authorization");
    let userId: string;
    let isInternalCall = false;

    const body = await req.json();
    if (body.user_id && authHeader?.includes(supabaseKey)) {
      userId = body.user_id;
      isInternalCall = true;
    } else {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Missing auth" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    // MODULE ACCESS GUARD: bulk-assigning rules to ASINs modifies repricer config = repricer:edit
    if (!isInternalCall) {
      const access = await checkModuleAccess(supabase, userId, "repricer", "edit");
      if (!access.allowed) {
        console.warn(`[auto-assign-bulk] MODULE BLOCKED user=${userId} reason=${access.reason}`);
        return new Response(
          JSON.stringify({ success: false, error: access.reason }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const marketplace = body.marketplace || "US";
    console.log(`[auto-assign-bulk] Starting for user=${userId} marketplace=${marketplace}`);

    // 1. Fetch user's auto-onboarding settings (rule comes from repricer_rules.is_default)
    let { data: settings } = await supabase
      .from("user_settings")
      .select("auto_assign_enabled, auto_assign_rule_id, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_skip_manual_minmax, auto_raise_roi_floor_us, auto_raise_roi_floor_ca, auto_raise_roi_floor_mx, auto_raise_roi_floor_br")
      .eq("user_id", userId)
      .maybeSingle();

    // Resolve the default rule:
    // 1) repricer_rules.is_default = true  (UNIFIED source of truth — set from Rules tab)
    // 2) legacy user_settings.auto_assign_rule_id (back-compat)
    // 3) safe fallback: Momentum Builder → Balanced Pro → any non-aggressive rule
    let resolvedRuleId: string | null = null;

    const { data: flaggedDefault } = await supabase
      .from("repricer_rules")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .maybeSingle();

    if (flaggedDefault?.id) {
      resolvedRuleId = flaggedDefault.id;
    } else if (settings?.auto_assign_rule_id) {
      resolvedRuleId = settings.auto_assign_rule_id;
    } else {
      const { data: userRules } = await supabase
        .from("repricer_rules")
        .select("id, smart_profile, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      const preferred =
        userRules?.find((r: any) => r.smart_profile === "MOMENTUM_BUILDER") ||
        userRules?.find((r: any) => r.smart_profile !== "VELOCITY_DOMINATOR") ||
        null;

      if (!preferred) {
        console.log(`[auto-assign-bulk] No safe default rule for user ${userId} — refusing to auto-pick aggressive preset`);
        return new Response(JSON.stringify({
          success: true, created: 0, skipped: 0,
          message: "No default rule set. Mark a rule as Default in the Repricer → Rules tab (Momentum Builder recommended).",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      resolvedRuleId = preferred.id;
    }

    if (!settings) {
      settings = {
        auto_assign_enabled: true,
        auto_assign_rule_id: resolvedRuleId,
        auto_minmax_enabled: true,
        auto_min_strategy: "price_buffer",
        auto_max_strategy: "price_buffer",
        auto_min_buffer_pct: 15,
        auto_max_buffer_pct: 30,
        auto_require_cost: true,
        auto_skip_manual_minmax: true,
        auto_raise_roi_floor_us: false,
        auto_raise_roi_floor_ca: false,
        auto_raise_roi_floor_mx: false,
        auto_raise_roi_floor_br: false,
      } as any;
    } else {
      settings.auto_assign_rule_id = resolvedRuleId;
    }


    // 1b. Fetch the assigned rule's Min ROI settings
    let ruleMinRoi: number | null = null;
    let ruleMinRoiEnabled = false;
    let ruleMinRoiOverrides: Record<string, number> = {};
    if (settings!.auto_assign_rule_id) {
      const { data: ruleData } = await supabase
        .from("repricer_rules")
        .select("min_roi_enabled, min_roi_enabled_marketplace_overrides, min_roi, min_roi_percent, min_roi_marketplace_overrides")
        .eq("id", settings!.auto_assign_rule_id)
        .maybeSingle();
      if (ruleData) {
        ruleMinRoiEnabled = resolveMinRoiEnabled(ruleData, marketplace);
        ruleMinRoi = ruleData.min_roi_percent || ruleData.min_roi || null;
        if (ruleData.min_roi_marketplace_overrides && typeof ruleData.min_roi_marketplace_overrides === 'object') {
          ruleMinRoiOverrides = ruleData.min_roi_marketplace_overrides as Record<string, number>;
        }
      }
    }
    console.log(`[auto-assign-bulk] Rule ROI: enabled=${ruleMinRoiEnabled} default=${ruleMinRoi}% overrides=${JSON.stringify(ruleMinRoiOverrides)}`);

    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    const { convertCurrency, getSellerHomeCurrency } = await import('../_shared/fx-utils.ts');
    const homeCurrency = await getSellerHomeCurrency(supabase, userId);
    const currencyMap: Record<string, string> = { US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL' };
    const targetCurrency = currencyMap[marketplace] || 'USD';
    let fxRate = 1;
    if (homeCurrency !== targetCurrency) {
      const fxResult = await convertCurrency(1, homeCurrency, targetCurrency, supabase);
      fxRate = fxResult.fxRate;
      console.log(`[auto-assign-bulk] FX rate for ${marketplace}: ${homeCurrency} → ${targetCurrency} rate=${fxRate.toFixed(4)}`);
    }

    // 2. Fetch all eligible inventory items — marketplace-isolated via user_id + listing filters
    // PAGINATED: Supabase silently caps at 1000 rows per query. Users with >1000
    // inventory rows would have ASINs past row 1000 invisible to assignment backfill,
    // causing CA/MX/BR rows to never be created for those SKUs.
    const inventoryRows: any[] = [];
    const INV_PAGE_SIZE = 1000;
    let invPageStart = 0;
    while (true) {
      const { data: page, error: invErr } = await supabase
        .from("inventory")
        // fnsku is here for detectIsFba() in the dedup pass below. Without it
        // every SKU falls back to "assume FBA" and an FBA/FBM pair on one ASIN
        // reads as one channel, which is the duplicate the dedup then collapses.
        .select("asin, sku, price, my_price, amazon_price, cost, listing_status, source, available, reserved, inbound, fnsku")
        .eq("user_id", userId)
        .not("asin", "is", null)
        .not("sku", "is", null)
        .range(invPageStart, invPageStart + INV_PAGE_SIZE - 1);
      if (invErr) {
        console.error("[auto-assign-bulk] Inventory fetch error:", invErr);
        throw invErr;
      }
      if (!page || page.length === 0) break;
      inventoryRows.push(...page);
      if (page.length < INV_PAGE_SIZE) break;
      invPageStart += INV_PAGE_SIZE;
    }
    console.log(`[auto-assign-bulk] Fetched ${inventoryRows.length} inventory rows (paginated)`);

    const inventory = (inventoryRows || []).filter((item: any) => {
      const available = item.available || 0;
      const reserved = item.reserved || 0;
      const inbound = item.inbound || 0;
      return (available + reserved + inbound) > 0;
    });

    const zeroStockExcludedCount = Math.max((inventoryRows || []).length - inventory.length, 0);
    if (zeroStockExcludedCount > 0) {
      console.log(`[auto-assign-bulk] Ignoring ${zeroStockExcludedCount} zero-stock inventory rows for assignment backfill`);
    }

    // ── FBM DISCOVERY (option 3) ──
    // Listings created through the in-app tool live ONLY in `created_listings` and never
    // enter `inventory` (inventory = Summaries API / FBA truth, guarded by freshness trigger).
    // Without this merge, FBM listings can never reach repricer_assignments.
    // We synthesize virtual inventory rows for FBM listings that:
    //   - have asin + sku + price + units > 0
    //   - have NO existing inventory row for the same (asin, sku)
    //   - target US marketplace (created_listings tool produces US-only listings)
    if (marketplace === 'US') {
      // Track inventory rows that ACTUALLY have stock — zero-stock shells (often
      // stale FBA rows for listings the user later relisted as FBM) should NOT
      // block created_listings discovery.
      const invStockKeys = new Set(
        (inventoryRows || [])
          .filter((r: any) => (Number(r.available) || 0) + (Number(r.reserved) || 0) + (Number(r.inbound) || 0) > 0)
          .map((r: any) => `${r.asin}:${r.sku}`),
      );
      // PAGINATED for the same reason as the costListings query below — an
      // unpaginated select() silently caps at Supabase's default 1000 rows,
      // which would silently drop FBM listings from discovery for any user
      // whose active_created_listings exceeds that.
      const fbmListingsAll: any[] = [];
      {
        const FBM_PAGE = 1000;
        let fbmStart = 0;
        while (true) {
          const { data: page } = await supabase
            // Phase 2: shared source-of-truth view (validation gate + ghost filter)
            .from('active_created_listings')
            .select('asin, sku, price, cost, units, amount')
            .eq('user_id', userId)
            .not('asin', 'is', null)
            .not('sku', 'is', null)
            .range(fbmStart, fbmStart + FBM_PAGE - 1);
          if (!page || page.length === 0) break;
          fbmListingsAll.push(...page);
          if (page.length < FBM_PAGE) break;
          fbmStart += FBM_PAGE;
        }
      }
      const fbmListings = fbmListingsAll;

      // Dedup by (asin,sku) keeping the row with the most info (units, then price)
      const fbmBest = new Map<string, any>();
      for (const cl of (fbmListings || [])) {
        const key = `${cl.asin}:${cl.sku}`;
        if (invStockKeys.has(key)) continue; // covered by real FBA stock
        const price = Number(cl.price) || 0;
        if (price <= 0) continue; // need price to compute bounds
        const existing = fbmBest.get(key);
        const units = Number(cl.units) || 0;
        if (!existing || units > (Number(existing.units) || 0)) fbmBest.set(key, cl);
      }

      let fbmAdded = 0;
      for (const [, cl] of fbmBest) {
        const unitCost = getListingUnitCost({ cost: cl.cost, amount: cl.amount, units: cl.units }) || 0;
        // Treat null/0 units as 1 so the assignment is created (user explicitly
        // listed this ASIN — they want it managed even before stock arrives).
        const synthAvailable = Number(cl.units) > 0 ? Number(cl.units) : 1;
        inventory.push({
          asin: cl.asin,
          sku: cl.sku,
          price: cl.price,
          my_price: cl.price,
          amazon_price: cl.price,
          cost: unitCost,
          listing_status: 'ACTIVE',
          source: 'created_listings_fbm',
          available: synthAvailable,
          reserved: 0,
          inbound: 0,
        });
        fbmAdded++;
      }
      if (fbmAdded > 0) {
        console.log(`[auto-assign-bulk] FBM_DISCOVERY: added ${fbmAdded} FBM listings from created_listings (not in inventory or zero-stock shell)`);
      }
    }

    if (inventory.length === 0) {
      console.log("[auto-assign-bulk] No eligible inventory found");
      // Check if user already has assignments — handle returning user case
      const { count: existingCount } = await supabase
        .from("repricer_assignments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("is_enabled", true);

      if ((existingCount || 0) > 0) {
        await supabase.from("user_sync_status").upsert({
          user_id: userId,
          repricer_assignments_created: true,
          repricer_ready: true,
        }, { onConflict: "user_id" });
      }

      return new Response(JSON.stringify({
        success: true, created: 0, skipped: 0,
        existing_assignments: existingCount || 0,
        message: (existingCount || 0) > 0
          ? `No new stock-backed items to assign. ${existingCount} existing assignments found.`
          : "No stock-backed inventory items found.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[auto-assign-bulk] Found ${inventory.length} eligible inventory items`);

    // 3. Fetch existing assignments to avoid duplicates — strictly marketplace-isolated
    // PAGINATED: users with >1000 assignments in this marketplace would otherwise
    // see stale existing-key sets (the upsert still dedupes, but logging would lie).
    const existingAssignmentsAll: any[] = [];
    {
      const EA_PAGE = 1000;
      let start = 0;
      while (true) {
        const { data: page } = await supabase
          .from("repricer_assignments")
          .select("id, asin, sku, marketplace, rule_id, is_enabled, min_price_override, max_price_override, roi_at_min_percent, roi_at_max_percent, last_applied_price, manual_paused, last_disabled_by, intl_listing_status, marketplace_sellable, is_listing_inactive_not_buyable")
          .eq("user_id", userId)
          .eq("marketplace", marketplace)
          .range(start, start + EA_PAGE - 1);
        if (!page || page.length === 0) break;
        existingAssignmentsAll.push(...page);
        if (page.length < EA_PAGE) break;
        start += EA_PAGE;
      }
    }
    const existingAssignments = existingAssignmentsAll;

    const existingKeys = new Set(
      (existingAssignments || []).map(a => `${a.asin}:${a.sku}:${a.marketplace}`)
    );
    const existingByKey = new Map(
      (existingAssignments || []).map(a => [`${a.asin}:${a.sku}:${a.marketplace}`, a])
    );
    const preExistingCount = existingKeys.size;

    // 4. Fetch cost data from created_listings (Contract A)
    //    cost = TOTAL batch cost, amount = UNIT cost, units = purchase qty.
    //    The shared helper refuses to leak `cost` (TOTAL) as a unit value.
    //    PAGINATED: an unpaginated select() silently caps at Supabase's
    //    default 1000-row limit. Verified live: a user with 8,418
    //    created_listings rows had ASINs entirely missing from costMap
    //    purely because they fell outside the first page — those rows got
    //    permanently stamped activation_needs_cost even with valid cost on
    //    file, no matter how many times or which marketplace re-ran this.
    const costListingsAll: any[] = [];
    {
      const CL_PAGE = 1000;
      let start = 0;
      while (true) {
        const { data: page } = await supabase
          .from("created_listings")
          .select("asin, sku, price, cost, units, amount")
          .eq("user_id", userId)
          .not("asin", "is", null)
          .range(start, start + CL_PAGE - 1);
        if (!page || page.length === 0) break;
        costListingsAll.push(...page);
        if (page.length < CL_PAGE) break;
        start += CL_PAGE;
      }
    }
    const costListings = costListingsAll;

    const costMap = new Map<string, number>();
    const createdPriceByKey = new Map<string, number>();
    const createdPriceByAsin = new Map<string, number>();
    for (const cl of (costListings || [])) {
      if (!cl.asin) continue;
      const uc = getListingUnitCost({ cost: cl.cost, amount: cl.amount, units: cl.units });
      if (uc !== null && uc > 0) {
        costMap.set(cl.asin, uc);
      }
      const createdPrice = Number(cl.price) || 0;
      if (createdPrice > 0) {
        if (cl.sku) createdPriceByKey.set(`${cl.asin}:${cl.sku}`, createdPrice);
        if (!createdPriceByAsin.has(cl.asin)) createdPriceByAsin.set(cl.asin, createdPrice);
      }
    }

    // 5. Fetch fee cache for cost-aware floor calculation
    const { data: feeCache } = await supabase
      .from("asin_fee_cache")
      .select("asin, referral_rate, fba_fee_fixed")
      .eq("user_id", userId)
      .eq("marketplace", marketplace);

    const feeMap = new Map<string, { referralRate: number; fbaFee: number }>();
    for (const fc of (feeCache || [])) {
      feeMap.set(fc.asin, { referralRate: fc.referral_rate || 0.15, fbaFee: fc.fba_fee_fixed || 0 });
    }

    const { data: sellerAuthRows } = await supabase
      .from("seller_authorizations")
      .select("seller_id, marketplace_id, refresh_token")
      .eq("user_id", userId);

    const getSellerAuthForMarketplace = (marketplaceId: string) => {
      const direct = (sellerAuthRows || []).find((a: any) => a.marketplace_id === marketplaceId);
      if (direct) return direct;
      const sellerId = (sellerAuthRows || [])[0]?.seller_id;
      return (sellerAuthRows || []).find((a: any) => a.seller_id === sellerId) || null;
    };

    // 5b. For non-US marketplaces, pre-fetch marketplace-specific my_price + competitor BB
    // so currentPrice is in LOCAL currency, not the home-currency inventory.my_price.
    const targetMarketplaceId = MARKETPLACE_ID_MAP[marketplace] || MARKETPLACE_ID_MAP.US;
    const localPriceBySku = new Map<string, number>();
    const localBBByAsin = new Map<string, number>();
    const asinList = [...new Set(inventory.map((i: any) => i.asin).filter(Boolean))];
    if (marketplace !== 'US') {
      const skuList = inventory.map((i: any) => i.sku).filter(Boolean);

      if (skuList.length > 0) {
        const { data: priceCacheRows } = await supabase
          .from("asin_my_price_cache")
          .select("asin, seller_sku, my_price, fetched_at")
          .eq("user_id", userId)
          .eq("marketplace_id", targetMarketplaceId)
          .in("seller_sku", skuList)
          .order("fetched_at", { ascending: false });
        for (const r of (priceCacheRows || [])) {
          if (!localPriceBySku.has(r.seller_sku) && r.my_price > 0) {
            localPriceBySku.set(r.seller_sku, r.my_price);
          }
        }
      }

      console.log(`[auto-assign-bulk] Pre-fetched ${marketplace} local prices: ${localPriceBySku.size} sku-prices, ${localBBByAsin.size} BB snapshots`);
    }
    if (asinList.length > 0) {
      const { data: snapRows } = await supabase
        .from("repricer_competitor_snapshots")
        .select("asin, buybox_price, lowest_fba_price, lowest_overall_price, fetched_at")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .in("asin", asinList)
        .order("fetched_at", { ascending: false });
      for (const r of (snapRows || [])) {
        if (!localBBByAsin.has(r.asin)) {
          const p = r.buybox_price || r.lowest_fba_price || r.lowest_overall_price || 0;
          if (p > 0) localBBByAsin.set(r.asin, p);
        }
      }
    }
    // 6. Process each item
    const results = {
      created: 0,
        backfilled: 0,
      skipped: 0,
      skipReasons: {} as Record<string, number>,
      errors: 0,
      auditLog: [] as Array<{
        asin: string;
        sku: string;
        action: "created" | "skipped";
        reason?: string;
        min_price?: number | null;
        max_price?: number | null;
      }>,
    };

    const skip = (asin: string, sku: string, reason: string) => {
      results.skipped++;
      results.skipReasons[reason] = (results.skipReasons[reason] || 0) + 1;
      results.auditLog.push({ asin, sku, action: "skipped", reason });
    };

    const assignmentsToInsert: any[] = [];
    const assignmentsToBackfill: any[] = [];

    for (const item of inventory) {
      const { asin, sku } = item;
      if (!asin || !sku) { skip(asin || "", sku || "", "missing_asin_or_sku"); continue; }

      // Existing rows that are already fully configured can be skipped.
      // Existing inbound rows missing rule/min/max must be backfilled instead
      // of staying visible as "No rule" forever.
      const key = `${asin}:${sku}:${marketplace}`;
      const existingAssignment = existingByKey.get(key);
      const existingManualPause = existingAssignment?.manual_paused === true || ['user', 'manual', 'seller', 'owner'].includes(String(existingAssignment?.last_disabled_by || '').toLowerCase());
      if (existingAssignment && existingManualPause) { skip(asin, sku, "manually_paused"); continue; }
      // A listing already confirmed dead in this marketplace (existence check
      // or pricing-suppression detector) must stay untouched here — this
      // backfill/upsert path runs BEFORE step 7b's re-enable guard and was
      // silently overwriting is_enabled=true for known-dead intl listings
      // via finalIsEnabled, which never checks these signals at all.
      const existingConfirmedDead = !!existingAssignment && marketplace !== "US" && (
        existingAssignment.intl_listing_status === "NOT_FOUND" ||
        existingAssignment.marketplace_sellable === false ||
        existingAssignment.is_listing_inactive_not_buyable === true
      );
      if (existingConfirmedDead) { skip(asin, sku, "confirmed_dead_listing"); continue; }
      const inboundQtyForActivation = Number((item as any)?.inbound) || 0;
      const needsExistingBackfill = existingAssignment && (
        !existingAssignment.rule_id ||
        (existingAssignment.is_enabled === false && !existingManualPause) ||
        existingAssignment.min_price_override == null ||
        existingAssignment.max_price_override == null ||
        (inboundQtyForActivation > 0 && (existingAssignment.last_applied_price == null || existingAssignment.roi_at_min_percent == null || existingAssignment.roi_at_max_percent == null))
      );
      if (existingAssignment && !needsExistingBackfill) { skip(asin, sku, "already_assigned"); continue; }

      // Resolve unit cost
      let unitCost = item.cost || 0;
      if (unitCost <= 0) unitCost = costMap.get(asin) || 0;

      // Convert USD cost to local currency for non-US marketplaces
      const unitCostLocal = unitCost > 0 ? unitCost * fxRate : 0;

      // If cost is missing, still create the assignment but skip min/max calculation
      const hasCost = unitCostLocal > 0;

      // Resolve current price IN MARKETPLACE LOCAL CURRENCY.
      // For non-US: prefer marketplace-specific owned-price cache, then FX-convert
      // a home owned-price only as a temporary source before the mandatory live fetch.
      const createdListingPrice = createdPriceByKey.get(`${asin}:${sku}`) || createdPriceByAsin.get(asin) || 0;
      const ownInventoryPrice = pickPositive(item.my_price, item.price, item.amazon_price, existingAssignment?.last_applied_price);
      const homeInventoryPrice = ownInventoryPrice || createdListingPrice || 0;
      let currentPrice = 0;
      let currentPriceSource: string = 'none';
      if (marketplace === 'US') {
        currentPrice = homeInventoryPrice;
        currentPriceSource = ownInventoryPrice > 0 ? 'inventory' : (createdListingPrice > 0 ? 'created_listings' : 'none');
      } else {
        if (localPriceBySku.has(sku)) {
          currentPrice = localPriceBySku.get(sku)!;
          currentPriceSource = 'mkt_cache';
        } else if (homeInventoryPrice > 0) {
          // Last-resort FX conversion of home-currency price
          currentPrice = homeInventoryPrice * fxRate;
          currentPriceSource = ownInventoryPrice > 0 ? 'fx_converted_inventory' : 'fx_converted_created_listings';
        }
      }

      // Inbound activation must use YOUR live listing price, not a Buy Box/competitor proxy.
      // If Summaries/cache have not populated price yet, fetch Listings Items now and persist it
      // before min/max/ROI are calculated so activation is not half-finished.
      if (inboundQtyForActivation > 0) {
        const priorPriceSource = currentPriceSource;
        const sellerAuth = getSellerAuthForMarketplace(targetMarketplaceId);
        let liveOwnPrice: number | null = null;
        if (sellerAuth) {
          try {
            liveOwnPrice = await fetchLiveOwnPrice({ supabase, userId, sellerAuth, sku, marketplaceId: targetMarketplaceId });
          } catch (priceFetchErr: any) {
            console.warn(`[auto-assign-bulk] Live own price fetch exception for inbound ${asin}/${sku}/${marketplace}: ${priceFetchErr?.message || priceFetchErr}`);
          }
          if (liveOwnPrice && liveOwnPrice > 0) {
            currentPrice = liveOwnPrice;
            currentPriceSource = 'spapi_listings';
            if (marketplace === 'US') {
              await supabase.from('inventory').update({
                my_price: liveOwnPrice,
                price: liveOwnPrice,
                amazon_price: liveOwnPrice,
                last_price_confirmed_at: new Date().toISOString(),
              }).eq('user_id', userId).eq('asin', asin).eq('sku', sku);
            } else {
              await supabase.from('asin_my_price_cache').upsert({
                user_id: userId,
                asin,
                seller_sku: sku,
                marketplace_id: targetMarketplaceId,
                my_price: liveOwnPrice,
                fetched_at: new Date().toISOString(),
                source: 'auto_activation',
              }, { onConflict: 'user_id,asin,marketplace_id,seller_sku' });
            }
            console.log(`[auto-assign-bulk] ✅ Live own price captured for inbound ${asin}/${sku}/${marketplace}: ${liveOwnPrice}`);
          }
        } else {
          console.warn(`[auto-assign-bulk] No seller authorization available to fetch live price for inbound ${asin}/${sku}/${marketplace}`);
        }
        if (!liveOwnPrice) {
          currentPrice = 0;
          currentPriceSource = `spapi_price_unavailable:${priorPriceSource}`;
        }
      }

      // If inputs are missing, keep processing so we create/backfill a diagnostic
      // assignment instead of silently leaving inbound rows without min/max context.

      // Calculate min/max with COST-AWARE safety (all in local currency)
      // ── MANUAL-MIN-ONLY CONTRACT ──
      // Per platform contract: the user's manual min_price_override is the SOLE
      // authoritative floor. If an existing assignment already has bounds set,
      // auto-assign-bulk must NEVER overwrite them during backfill/inbound
      // activation — even if `auto_minmax_enabled` is true. Only truly-null
      // bounds may be computed here.
      let minPrice: number | null = existingAssignment?.min_price_override != null ? Number(existingAssignment.min_price_override) : null;
      let maxPrice: number | null = existingAssignment?.max_price_override != null ? Number(existingAssignment.max_price_override) : null;
      const hasExistingMin = minPrice != null;
      const hasExistingMax = maxPrice != null;
      let roiSafeMin: number | null = null;
      let usedRoiFloor = false;

      if (settings!.auto_minmax_enabled && currentPrice > 0 && (hasCost || !settings!.auto_require_cost)) {
        // --- Cost-aware floor: cost + fees + 5% margin (local currency) ---
        let costFloor: number | null = null;
        if (unitCostLocal > 0) {
          const fees = feeMap.get(asin);
          const referralRate = fees?.referralRate || 0.15;
          const fbaFeeLocal = (fees?.fbaFee || 3.50) * fxRate; // Convert default FBA fee to local currency
          const breakEven = (unitCostLocal + fbaFeeLocal) / (1 - referralRate);
          costFloor = Math.round(breakEven * 1.05 * 100) / 100;
        }

        // Min price: only compute when the row has NO existing manual/prior min.
        if (!hasExistingMin) {
          if (settings!.auto_min_strategy === "cost_buffer" && unitCostLocal > 0) {
            minPrice = Math.round(unitCostLocal * (1 + settings!.auto_min_buffer_pct / 100) * 100) / 100;
          } else if (settings!.auto_min_strategy === "price_buffer" && currentPrice > 0) {
            minPrice = Math.round(currentPrice * (1 - settings!.auto_min_buffer_pct / 100) * 100) / 100;
          }

          // Enforce cost floor as absolute minimum
          if (costFloor !== null && minPrice !== null && minPrice < costFloor) {
            minPrice = costFloor;
          }
          if (costFloor !== null && minPrice === null) {
            minPrice = costFloor;
          }
          if (minPrice === null && currentPrice > 0) {
            minPrice = Math.round(currentPrice * (1 - (settings!.auto_min_buffer_pct || 15) / 100) * 100) / 100;
          }

          // ── ROI-SAFE MIN: use rule's Min ROI to compute a profitability floor (local currency) ──
          if (ruleMinRoiEnabled && unitCostLocal > 0) {
            const effectiveRoi = ruleMinRoiOverrides[marketplace] ?? ruleMinRoi;
            if (effectiveRoi && effectiveRoi > 0) {
              const fees = feeMap.get(asin);
              const referralRate = fees?.referralRate || 0.15;
              const fbaFeeLocal = (fees?.fbaFee || 3.50) * fxRate;
              const cushionedRoi = effectiveRoi + 10;
              const roiFloorPrice = (unitCostLocal * (1 + cushionedRoi / 100) + fbaFeeLocal) / (1 - referralRate);
              roiSafeMin = Math.ceil(roiFloorPrice * 100) / 100;
              console.log(`[auto-assign-bulk] ROI floor for ${asin} (${marketplace}): costUSD=$${unitCost} × FX ${fxRate} = local ${unitCostLocal.toFixed(2)}, target=${effectiveRoi}% +10pt → ${roiSafeMin} (buffer min=${minPrice})`);
              if (roiSafeMin > 0 && (minPrice === null || roiSafeMin > minPrice)) {
                minPrice = roiSafeMin;
                usedRoiFloor = true;
              }
            }
          }
        } else {
          console.log(`[auto-assign-bulk] 🔒 Preserving existing min $${minPrice} for ${asin}/${marketplace} (manual-min-only contract)`);
        }

        // Max price: only compute when no existing value.
        if (!hasExistingMax) {
          if (settings!.auto_max_strategy === "price_buffer" && currentPrice > 0) {
            maxPrice = Math.round(currentPrice * (1 + settings!.auto_max_buffer_pct / 100) * 100) / 100;
          } else if (settings!.auto_max_strategy === "buybox_buffer" && currentPrice > 0) {
            maxPrice = Math.round(currentPrice * (1 + settings!.auto_max_buffer_pct / 100) * 100) / 100;
          }
        }
      }

      // ── ATOMIC ACTIVATION FALLBACK ──
      // If min/max are still null but we DO have cost + currentPrice, never leave
      // them null. Compute a safe default so inbound auto-activation cannot finish
      // half-done. Uses the same cost-aware floor + price-buffer max math as above
      // but is independent of `auto_minmax_enabled` / strategy settings.
      if ((minPrice === null || maxPrice === null) && currentPrice > 0 && unitCostLocal > 0) {
        const fees = feeMap.get(asin);
        const referralRate = fees?.referralRate || 0.15;
        const fbaFeeLocal = (fees?.fbaFee || 3.50) * fxRate;
        const breakEven = (unitCostLocal + fbaFeeLocal) / (1 - referralRate);
        const safeCostFloor = Math.round(breakEven * 1.05 * 100) / 100;

        if (minPrice === null) {
          // Prefer ROI-safe floor if rule has Min ROI; else cost floor; else 15% below current.
          if (ruleMinRoiEnabled) {
            const effectiveRoi = ruleMinRoiOverrides[marketplace] ?? ruleMinRoi;
            if (effectiveRoi && effectiveRoi > 0) {
              const cushionedRoi = effectiveRoi + 10;
              const roiFloorPrice = (unitCostLocal * (1 + cushionedRoi / 100) + fbaFeeLocal) / (1 - referralRate);
              minPrice = Math.ceil(roiFloorPrice * 100) / 100;
              usedRoiFloor = true;
              roiSafeMin = minPrice;
            }
          }
          if (minPrice === null) minPrice = safeCostFloor;
          const bufferMin = Math.round(currentPrice * 0.85 * 100) / 100;
          if (bufferMin > 0 && bufferMin > minPrice) minPrice = bufferMin;
          console.log(`[auto-assign-bulk] 🛟 Atomic min fallback for ${asin}/${marketplace}: $${minPrice}`);
        }
        if (maxPrice === null) {
          maxPrice = Math.round(currentPrice * 1.30 * 100) / 100;
          console.log(`[auto-assign-bulk] 🛟 Atomic max fallback for ${asin}/${marketplace}: $${maxPrice}`);
        }
      }


      // Safety: min must be >= $5 equivalent (global floor, FX-adjusted).
      // Do NOT apply to an existing manual min — manual-min-only contract wins.
      const globalFloor = 5 * fxRate;
      if (!hasExistingMin && minPrice !== null && minPrice < globalFloor) minPrice = Math.round(globalFloor * 100) / 100;

      // Known-real price we can trust — the last price we ourselves actually
      // applied — as opposed to `currentPrice`, which for CA/MX/BR comes from
      // asin_my_price_cache with no freshness check and can drift either
      // direction from reality (see the max-price safety check below for the
      // "too low" case; this is the "too high" mirror case).
      const knownLivePrice = Number(existingAssignment?.last_applied_price) || 0;

      // Safety: if min > current price — handle based on ROI protection.
      // Skip entirely for existing manual mins so we never silently lower them.
      if (!hasExistingMin && minPrice !== null && currentPrice > 0 && minPrice > currentPrice) {
        if (usedRoiFloor) {
          // ROI protection justifies min above current price — keep it, adjust max
          console.log(`[auto-assign-bulk] 🛡️ ROI floor $${minPrice} > current $${currentPrice} for ${asin} — ROI protection active`);
          if (maxPrice === null || maxPrice <= minPrice) {
            maxPrice = Math.round(minPrice * 1.35 * 100) / 100;
          }
        } else {
          // Cap using the KNOWN real price when we have one, not currentPrice —
          // if currentPrice is a stale-HIGH cache entry, capping against it
          // would still leave min above the actual current price (this was
          // the reported bug: min ends up above "my price" in BR/CA/MX).
          const referencePrice = knownLivePrice > 0 ? knownLivePrice : currentPrice;
          console.log(`[auto-assign-bulk] ⚠️ min_price $${minPrice} > current $${currentPrice} for ${asin} — capping to buffer below ${knownLivePrice > 0 ? 'known live price $' + knownLivePrice : 'current $' + currentPrice}`);
          minPrice = Math.round(referencePrice * (1 - (settings!.auto_min_buffer_pct || 15) / 100) * 100) / 100;
          if (minPrice < 5) minPrice = 5;
        }
      }

      // Safety: min must never end up above the KNOWN real current price
      // without ROI justification. The check above only fires when minPrice
      // exceeds `currentPrice` itself — but minPrice is usually computed AS
      // A FRACTION of currentPrice (e.g. 0.85x for price_buffer), so it can
      // land above the REAL price without ever exceeding the (possibly
      // stale-HIGH) currentPrice it was derived from. This is the actual
      // shape of the reported bug: a fresh min computed from a stale cache
      // entry ends up above "my price" even though it never exceeded that
      // same stale reference. Only applies to freshly-computed, non-ROI-floor
      // mins — existing/manual mins and legitimate ROI floors are untouched.
      if (!hasExistingMin && !usedRoiFloor && minPrice !== null && knownLivePrice > 0 && minPrice > knownLivePrice) {
        const cappedMin = Math.round(knownLivePrice * (1 - (settings!.auto_min_buffer_pct || 15) / 100) * 100) / 100;
        console.log(`[auto-assign-bulk] ⚠️ min $${minPrice} > known live price $${knownLivePrice} for ${asin}/${marketplace} (currentPrice=$${currentPrice} may be stale) — capping to $${cappedMin}`);
        minPrice = Math.max(cappedMin, 5);
      }

      // Safety: max must be > min
      if (minPrice !== null && maxPrice !== null && maxPrice <= minPrice) {
        maxPrice = Math.round(minPrice * 1.5 * 100) / 100;
      }

      // Safety: for very high-priced items, cap max at 2x current price (but not below min)
      if (maxPrice !== null && currentPrice > 0 && maxPrice > currentPrice * 2) {
        const cappedMax = Math.round(currentPrice * 2 * 100) / 100;
        if (minPrice === null || cappedMax > minPrice) {
          maxPrice = cappedMax;
        }
      }

      // Safety: max must never end up below a price we KNOW is real and was
      // already successfully applied. For US, currentPrice comes from the
      // continuously-synced `inventory` table, so this rarely triggers. For
      // CA/MX/BR, currentPrice comes from asin_my_price_cache — populated by
      // several different, inconsistently-triggered writers with no
      // freshness check — so a stale cache entry (predating a real price
      // increase) can make a freshly-computed max come out below the actual
      // current price. If our own last_applied_price is already higher than
      // the computed max, that's not a legitimate bound — raise max to cover
      // it, same buffer the max strategy already uses. (knownLivePrice
      // declared above, reused here.)
      if (maxPrice !== null && knownLivePrice > maxPrice) {
        const bufferedMax = Math.round(knownLivePrice * (1 + (settings!.auto_max_buffer_pct || 15) / 100) * 100) / 100;
        console.log(`[auto-assign-bulk] 🛡️ max $${maxPrice} < known live price $${knownLivePrice} for ${asin}/${marketplace} — raising max to $${bufferedMax}`);
        maxPrice = bufferedMax;
      }

      // Final sanity: if min STILL > max after all guards, skip this item
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        skip(asin, sku, "inverted_min_max"); continue;
      }

      // ── CURRENCY-SANITY GUARD ──
      // For non-US, if computed max is wildly below the marketplace BB (< 30%),
      // the price source was almost certainly USD-mislabeled. Drop bounds rather
      // than write USD-style numbers (e.g., min=$38, max=$54 against a MX$678 BB).
      if (marketplace !== 'US' && maxPrice !== null) {
        const mktBB = localBBByAsin.get(asin) || 0;
        if (mktBB > 0 && maxPrice < mktBB * 0.3) {
          console.warn(
            `[auto-assign-bulk] 🚨 CURRENCY GUARD: ${asin}/${marketplace} max=${maxPrice} ${targetCurrency} < 30% of BB ${mktBB} ${targetCurrency} (priceSource=${currentPriceSource}). Dropping bounds.`
          );
          skip(asin, sku, "currency_mismatch_blocked");
          continue;
        }
      }

      // ── AUTO RAISE: check if we should flag for immediate price raise ──
      let shouldAutoRaise = false;
      const raiseToggleKey = `auto_raise_roi_floor_${marketplace.toLowerCase()}` as keyof typeof settings;
      if (usedRoiFloor && currentPrice > 0 && roiSafeMin && currentPrice < roiSafeMin) {
        const raiseEnabled = (settings as any)[raiseToggleKey] === true;
        const gap = roiSafeMin - currentPrice;
        // Only raise if gap is meaningful (> $0.25 or > 2%)
        if (raiseEnabled && (gap > 0.25 || (gap / currentPrice) > 0.02)) {
          shouldAutoRaise = true;
          console.log(`[auto-assign-bulk] 🚀 Auto-raise flagged for ${asin} ${marketplace}: current=$${currentPrice} → ROI floor=$${roiSafeMin} (gap=$${gap.toFixed(2)})`);
        }
      }

      // Determine if assignment should be enabled.
      // Inbound counts here: we want repricer protection before units become sellable.
      const hasSellableStock = (item.available || 0) + (item.reserved || 0) + (item.inbound || 0) > 0;
      const isEnabled = hasSellableStock;

      // ── TRACE LOG (contamination audit) — B01JIA5DOK only ──
      if (asin === 'B01JIA5DOK') {
        console.log('[TRACE auto-assign-bulk B01JIA5DOK]', JSON.stringify({
          marketplace_requested: marketplace,
          sku,
          source_inv_cost: item.cost,
          source_costMap: costMap.get(asin),
          unitCost_USD: unitCost,
          fxRate,
          unitCostLocal,
          homeInventoryPrice,
          currentPrice,
          currentPriceSource,
          localPriceBySku_value: localPriceBySku.get(sku) ?? null,
          localBBByAsin_value: localBBByAsin.get(asin) ?? null,
          inv_my_price: item.my_price,
          inv_price: item.price,
          inv_amazon_price: item.amazon_price,
          roiSafeMin,
          usedRoiFloor,
          final_minPrice: minPrice,
          final_maxPrice: maxPrice,
          min_gt_price: (minPrice != null && currentPrice > 0 && minPrice > currentPrice),
          min_to_price_pct: (minPrice != null && currentPrice > 0) ? ((minPrice / currentPrice) * 100).toFixed(2) + '%' : null,
          max_to_price_pct: (maxPrice != null && currentPrice > 0) ? ((maxPrice / currentPrice) * 100).toFixed(2) + '%' : null,
        }));
      }

      // Detect inbound-driven activation so we can pin the row to the top of
      // the AssignmentsTable and surface a "New inbound" badge. We tag every
      // newly-inserted assignment with auto_activated_* audit fields.
      const inboundQty = Number((item as any)?.inbound) || 0;
      const availableQty = Number((item as any)?.available) || 0;
      const reservedQty = Number((item as any)?.reserved) || 0;
      const isInboundOnly = inboundQty > 0 && availableQty === 0 && reservedQty === 0;
      const activationReason = isInboundOnly
        ? 'inbound_detected'
        : inboundQty > 0
          ? 'inbound_plus_stock'
          : 'stock_detected';

      // ── ATOMIC ACTIVATION GATE ──
      // Activation is "complete" ONLY when rule + min + max are all set.
      // If any piece is missing we mark the row disabled with a clear diagnostic
      // reason so the UI can surface "Needs cost" / "Price unavailable" instead
      // of leaving it silently half-enabled with NULL bounds.
      const ruleAttached = !!settings!.auto_assign_rule_id;
      const boundsComplete = minPrice != null && maxPrice != null;
      const activationInputsComplete = inboundQtyForActivation <= 0 || (hasCost && currentPrice > 0);
      const activationComplete = ruleAttached && boundsComplete && activationInputsComplete;
      const feesForRoi = feeMap.get(asin);
      const referralRateForRoi = feesForRoi?.referralRate || 0.15;
      const fixedFeesLocalForRoi = (feesForRoi?.fbaFee || 3.50) * fxRate;
      const roiAtMin = minPrice != null && unitCostLocal > 0
        ? calcRoiAtPrice(unitCostLocal, minPrice, referralRateForRoi, fixedFeesLocalForRoi)
        : null;
      const roiAtMax = maxPrice != null && unitCostLocal > 0
        ? calcRoiAtPrice(unitCostLocal, maxPrice, referralRateForRoi, fixedFeesLocalForRoi)
        : null;

      let finalIsEnabled = isEnabled && activationComplete;
      let activationDiagReason: string | null = null;
      let activationErrorType: string | null = null;
      let activationErrorMessage: string | null = null;
      if (!activationComplete) {
        if (!ruleAttached) {
          activationDiagReason = 'activation_pending:no_default_rule';
          activationErrorType = 'activation_no_default_rule';
          activationErrorMessage = 'Inbound activation needs a default repricer rule.';
        } else if (!hasCost) {
          activationDiagReason = 'activation_pending:needs_cost';
          activationErrorType = 'activation_needs_cost';
          activationErrorMessage = 'Inbound activation needs unit cost before ROI min/max can be calculated.';
        } else if (currentPrice <= 0) {
          activationDiagReason = 'activation_pending:price_unavailable';
          activationErrorType = 'activation_price_unavailable';
          activationErrorMessage = 'Inbound activation could not fetch your live Amazon listing price.';
        } else {
          activationDiagReason = 'activation_pending:bounds_unavailable';
          activationErrorType = 'activation_bounds_unavailable';
          activationErrorMessage = 'Inbound activation could not calculate min/max bounds from the available data.';
        }
        finalIsEnabled = false;
        console.log(`[auto-assign-bulk] ⛔ Activation incomplete for ${asin}/${marketplace}: ${activationDiagReason} (rule=${ruleAttached} min=${minPrice} max=${maxPrice} cost=${unitCost} price=${currentPrice})`);
      }
      if (existingManualPause) {
        finalIsEnabled = false;
      }

      const assignmentPayload: any = {
        user_id: userId,
        asin,
        sku,
        marketplace,
        rule_id: settings!.auto_assign_rule_id,
        is_enabled: finalIsEnabled,
        status: activationDiagReason ? 'needs_attention' : 'active',
        min_price_override: minPrice,
        max_price_override: maxPrice,
        roi_at_min_percent: roiAtMin,
        roi_at_max_percent: roiAtMax,
        roi_range_updated_at: roiAtMin != null || roiAtMax != null ? new Date().toISOString() : null,
        // NEVER `undefined` here — this field gets batched into a single
        // multi-row upsert with rows from OTHER items in the same pass.
        // Supabase/PostgREST treats a missing key as NULL for that row in
        // the shared column list, not "leave unchanged" — so `undefined`
        // either silently nulls a value that should have been preserved,
        // or (for NOT NULL columns) crashes the WHOLE batch, rolling back
        // every other row's legitimate fix along with it. Preserve the
        // existing value instead of stripping the key.
        last_applied_price: currentPrice > 0 ? roundMoney(currentPrice) : (existingAssignment?.last_applied_price ?? null),
        last_price_change_at: new Date().toISOString(),
        // Auto-activation audit fields (used by AssignmentsTable to pin
        // newly-activated rows to the top + show "New inbound" pill).
        auto_activated_at: new Date().toISOString(),
        auto_activated_by: 'auto_assign_bulk',
        auto_activated_reason: activationReason,
        last_enabled_by: finalIsEnabled ? 'auto_assign_bulk' : (existingManualPause ? undefined : null),
        last_enabled_at: finalIsEnabled ? new Date().toISOString() : (existingManualPause ? undefined : null),
        // Atomic-activation diagnostics surfaced in the Repricer UI when
        // we have to leave a row disabled because of missing inputs.
        last_disabled_by: activationDiagReason ? 'auto_assign_bulk' : (existingManualPause ? undefined : null),
        last_disabled_reason: activationDiagReason ? activationDiagReason : (existingManualPause ? undefined : null),
        last_disabled_at: activationDiagReason ? new Date().toISOString() : (existingManualPause ? undefined : null),
        last_error_type: activationDiagReason ? activationErrorType : (existingManualPause ? undefined : null),
        last_error_message: activationDiagReason ? activationErrorMessage : (existingManualPause ? undefined : null),
        consecutive_failures: activationDiagReason ? 1 : (existingManualPause ? undefined : 0),
        // manual_paused is NOT NULL with no default — the `undefined` this
        // used to produce here (when activation succeeded and the row
        // wasn't manually paused) got silently coerced to NULL by the
        // batched upsert below, violating the constraint and rolling back
        // the entire ~100-row batch, not just this one row. existingManualPause
        // is already a plain boolean (never undefined), so this is always
        // a valid explicit value.
        manual_paused: activationDiagReason ? false : existingManualPause,
        _shouldAutoRaise: shouldAutoRaise && finalIsEnabled, // internal flag, stripped before insert
        _roiSafeMin: roiSafeMin,
        _currentPrice: currentPrice,
        _minPrice: minPrice,
        _maxPrice: maxPrice,
        _inboundQty: inboundQty,
      };


      if (existingAssignment) {
        assignmentsToBackfill.push({ id: existingAssignment.id, ...assignmentPayload });
        results.backfilled++;
      } else {
        assignmentsToInsert.push(assignmentPayload);
        results.created++;
      }

      results.auditLog.push({
        asin, sku, action: existingAssignment ? "backfilled" as any : "created",
        min_price: minPrice, max_price: maxPrice,
      });

      existingKeys.add(key);
    }

    // Collect auto-raise candidates before stripping internal flags
    const autoRaiseCandidates = [...assignmentsToInsert, ...assignmentsToBackfill]
      .filter((a: any) => a._shouldAutoRaise)
      .map((a: any) => ({ asin: a.asin, sku: a.sku, roiSafeMin: a._roiSafeMin, currentPrice: a._currentPrice, minPrice: a._minPrice, maxPrice: a._maxPrice }));
    const autoRaiseKeys = new Set(autoRaiseCandidates.map((a: any) => `${a.asin}:${a.sku}`));
    const inboundBoundsCandidates = [...assignmentsToInsert, ...assignmentsToBackfill]
      .filter((a: any) => a._inboundQty > 0 && a.is_enabled && a._minPrice != null && a._maxPrice != null && !autoRaiseKeys.has(`${a.asin}:${a.sku}`))
      .map((a: any) => ({ asin: a.asin, sku: a.sku, minPrice: a._minPrice, maxPrice: a._maxPrice }));

    // 7. Bulk insert in batches of 100 (strip internal flags)
    if (assignmentsToInsert.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < assignmentsToInsert.length; i += batchSize) {
        const batch = assignmentsToInsert.slice(i, i + batchSize).map((a: any) => {
          const { _shouldAutoRaise, _roiSafeMin, _currentPrice, _minPrice, _maxPrice, _inboundQty, ...clean } = a;
          // Drop any keys we left as undefined (e.g. manual_paused when no diag).
          for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
          return clean;
        });
        const { error: insertErr } = await supabase
          .from("repricer_assignments")
          .upsert(batch, { onConflict: "user_id,sku,marketplace", ignoreDuplicates: true });

        if (insertErr) {
          console.error(`[auto-assign-bulk] Batch insert error at offset ${i}:`, insertErr);
          results.errors++;
        }
      }
    }

    // 7a. Backfill existing inbound rows that were previously "No rule" / missing bounds.
    if (assignmentsToBackfill.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < assignmentsToBackfill.length; i += batchSize) {
        const batch = assignmentsToBackfill.slice(i, i + batchSize).map((a: any) => {
          const { _shouldAutoRaise, _roiSafeMin, _currentPrice, _minPrice, _maxPrice, _inboundQty, ...clean } = a;
          for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
          return clean;
        });
        const { error: updateErr } = await supabase
          .from("repricer_assignments")
          .upsert(batch, { onConflict: "id" });

        if (updateErr) {
          console.error(`[auto-assign-bulk] Backfill error at offset ${i}:`, updateErr);
          results.errors++;
        }
      }
    }

    // 7b. Auto-raise: IMMEDIATELY submit price updates for items flagged for ROI protection
    let autoRaisedCount = 0;
    let autoRaiseFailedCount = 0;
    if (autoRaiseCandidates.length > 0) {
      console.log(`[auto-assign-bulk] 🚀 Auto-raise: ${autoRaiseCandidates.length} items need IMMEDIATE price raise in ${marketplace}`);
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      for (const candidate of autoRaiseCandidates) {
        try {
          console.log(`[auto-assign-bulk] 🚀 Auto-raise: submitting ${candidate.asin} current=$${candidate.currentPrice} → $${candidate.roiSafeMin}`);
          const submitResp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({
              user_id: userId,
              asin: candidate.asin,
              sku: candidate.sku,
              marketplace,
              newPrice: candidate.roiSafeMin,
              newMinPrice: candidate.minPrice,
              newMaxPrice: candidate.maxPrice,
              updateMinMaxOnly: false,
              internal: true,
              fromScheduler: true,
            }),
          });
          const submitResult = await submitResp.json().catch(() => null);
          if (submitResp.ok && submitResult?.success) {
            autoRaisedCount++;
            console.log(`[auto-assign-bulk] ✅ Auto-raise succeeded: ${candidate.asin} → $${candidate.roiSafeMin}`);
          } else {
            autoRaiseFailedCount++;
            console.log(`[auto-assign-bulk] ⚠️ Auto-raise failed for ${candidate.asin}: ${submitResult?.error || submitResp.status} — HOT lane fallback active`);
          }
        } catch (raiseErr: any) {
          autoRaiseFailedCount++;
          console.log(`[auto-assign-bulk] ⚠️ Auto-raise exception for ${candidate.asin}: ${raiseErr.message} — HOT lane fallback active`);
        }
      }
      if (autoRaiseFailedCount > 0) {
        console.log(`[auto-assign-bulk] 🔄 ${autoRaiseFailedCount} auto-raise items will use HOT lane fallback (last_price_change_at already set)`);
      }
    }

    // Push freshly computed inbound min/max to Amazon even when no live price raise is needed.
    // This keeps Amazon bounds, local bounds, and ROI-at-min/max aligned immediately after activation.
    if (inboundBoundsCandidates.length > 0) {
      console.log(`[auto-assign-bulk] Syncing ${inboundBoundsCandidates.length} inbound min/max bounds to Amazon in ${marketplace}`);
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      for (const candidate of inboundBoundsCandidates) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({
              user_id: userId,
              asin: candidate.asin,
              sku: candidate.sku,
              marketplace,
              newMinPrice: candidate.minPrice,
              newMaxPrice: candidate.maxPrice,
              updateMinMaxOnly: true,
              internal: true,
              fromScheduler: true,
            }),
          });
        } catch (boundsErr: any) {
          console.log(`[auto-assign-bulk] ⚠️ Bounds push failed for ${candidate.asin}: ${boundsErr.message}`);
        }
      }
    }

    // 7b. Re-enable disabled assignments where inventory now has stock
    const disabledWithStock = await fetchAllRows(
      supabase,
      "repricer_assignments",
      "id, asin, sku, rule_id, min_price_override, max_price_override, manual_paused, last_disabled_by, intl_listing_status, marketplace_sellable, is_listing_inactive_not_buyable",
      (q) => q.eq("user_id", userId).eq("marketplace", marketplace).eq("is_enabled", false),
    );

    let reenabledCount = 0;
    if (disabledWithStock && disabledWithStock.length > 0) {
      // Build a map of inventory stock by asin:sku — INCLUDE inbound so
      // assignments that only have inbound (no available yet) are re-enabled
      // immediately. This is the "instant inbound auto-activation" path.
      const stockMap = new Map<string, 'inbound_only' | 'has_stock'>();
      for (const item of inventory) {
        if (item.asin && item.sku) {
          const avail = Number((item as any).available) || 0;
          const reserved = Number((item as any).reserved) || 0;
          const inbound = Number((item as any).inbound) || 0;
          if (avail + reserved > 0) {
            stockMap.set(`${item.asin}:${item.sku}`, 'has_stock');
          } else if (inbound > 0) {
            stockMap.set(`${item.asin}:${item.sku}`, 'inbound_only');
          }
        }
      }

      // Stock alone doesn't mean the listing is sellable in this marketplace —
      // a row already confirmed dead (NOT_FOUND / not marketplace_sellable /
      // flagged not-buyable) must stay disabled even if the shared US stock
      // pool has units, otherwise this reconciliation step silently reverses
      // the listing-existence sweep every 6h cron cycle.
      const confirmedDead = (da: any): boolean => {
        if (marketplace === "US") return false;
        if (da.intl_listing_status === "NOT_FOUND") return true;
        if (da.marketplace_sellable === false) return true;
        if (da.is_listing_inactive_not_buyable === true) return true;
        return false;
      };

      const toReenable: { id: string; reason: string }[] = [];
      for (const da of disabledWithStock) {
        const tag = stockMap.get(`${da.asin}:${da.sku}`);
        const configured = !!da.rule_id && da.min_price_override != null && da.max_price_override != null;
        const manuallyPaused = da.manual_paused === true || ['user', 'manual', 'seller', 'owner'].includes(String(da.last_disabled_by || '').toLowerCase());
        if (tag && configured && !manuallyPaused && !confirmedDead(da)) {
          toReenable.push({ id: da.id, reason: tag === 'inbound_only' ? 'inbound_detected' : 'stock_detected' });
        }
      }

      if (toReenable.length > 0) {
        const nowIso = new Date().toISOString();
        // Update in one shot — same audit fields for all (split if you need
        // per-row reason, but in practice the cron loop covers both cases).
        const { error: reEnableErr } = await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: true,
            manual_paused: false,
            last_enabled_by: 'auto_assign_bulk',
            last_enabled_at: nowIso,
            auto_activated_at: nowIso,
            auto_activated_by: 'auto_assign_bulk',
            auto_activated_reason: toReenable.some(r => r.reason === 'inbound_detected') ? 'inbound_detected' : 'stock_detected',
            last_disabled_by: null,
            last_disabled_reason: null,
            last_disabled_at: null,
          })
          .in("id", toReenable.map(r => r.id));

        if (reEnableErr) {
          console.error("[auto-assign-bulk] Re-enable error:", reEnableErr);
        } else {
          reenabledCount = toReenable.length;
          console.log(`[auto-assign-bulk] Re-enabled ${reenabledCount} assignments (incl. inbound-only)`);
        }
      }
    }

    // 7c. Cleanup: disable assignments with inverted min/max or deleted listings
    let cleanedUpCount = 0;
    let deduplicatedCount = 0;
    const allEnabled = await fetchAllRows(
      supabase,
      "repricer_assignments",
      "id, asin, sku, min_price_override, max_price_override, created_at",
      (q) => q.eq("user_id", userId).eq("marketplace", marketplace).eq("is_enabled", true),
    );

    if (allEnabled && allEnabled.length > 0) {
      const invStatusMap = new Map<string, { available: number; reserved: number; inbound: number; status: string | null; isFba: boolean }>();
      for (const item of (inventoryRows || [])) {
        if (item.asin && item.sku) {
          invStatusMap.set(`${item.asin}:${item.sku}`, {
            available: (item as any).available || 0,
            reserved: (item as any).reserved || 0,
            inbound: (item as any).inbound || 0,
            status: item.listing_status,
            isFba: detectIsFba(item as any),
          });
        }
      }

      const toDisable: string[] = [];
      for (const a of allEnabled) {
        if (a.min_price_override !== null && a.max_price_override !== null &&
            a.min_price_override > a.max_price_override) {
          console.log(`[auto-assign-bulk] ⚠️ Disabling ${a.asin}/${a.sku}: inverted min $${a.min_price_override} > max $${a.max_price_override}`);
          toDisable.push(a.id);
          continue;
        }

        const inv = invStatusMap.get(`${a.asin}:${a.sku}`);
        if (inv) {
          const badStatus = ["INACTIVE", "NOT_FOUND", "INCOMPLETE", "DELETED"].includes((inv.status || "").toUpperCase());
          const zeroStock = inv.available + inv.reserved + inv.inbound === 0;
          if (badStatus && zeroStock) {
            console.log(`[auto-assign-bulk] ⚠️ Disabling ${a.asin}/${a.sku}: status=${inv.status}, stock=0`);
            toDisable.push(a.id);
          }
        }
      }

      // 7d. Deduplicate: if same ASIN has multiple enabled rows (different SKUs),
      // keep the one backed by a REAL, active, in-stock listing — not just
      // whichever assignment row happens to have the newest created_at.
      // BUG this fixes: a ghost/NOT_IN_CATALOG SKU's assignment can easily
      // have a NEWER created_at than the real, currently-active SKU's
      // assignment (e.g. created during a later backfill pass), which made
      // the old "keep newest" rule disable the REAL listing and leave a
      // dead SKU actively repricing — confirmed live on B004IH1WSK/BR: the
      // NOT_IN_CATALOG/ghosted SKU was enabled and converging to its own
      // min floor, while the real, 91-unit-in-stock SKU sat disabled.
      deduplicatedCount = 0;
      const rankFor = (a: any): number => {
        const inv = invStatusMap.get(`${a.asin}:${a.sku}`);
        if (!inv) return 0; // no inventory match at all
        const status = (inv.status || '').toUpperCase();
        const isBadStatus = ['NOT_IN_CATALOG', 'DELETED', 'INACTIVE', 'NOT_FOUND', 'INCOMPLETE'].includes(status);
        const hasStock = (inv.available + inv.reserved + inv.inbound) > 0;
        if (!isBadStatus && hasStock) return 3; // best: real, active, in stock
        if (!isBadStatus) return 2; // active-status but currently no stock
        return 1; // ghost/bad status — worst, but still ranked above "no match"
      };

      // DEDUP KEY IS (asin, fulfilment channel), NOT asin.
      //
      // This pass exists for a real bug: a NOT_IN_CATALOG ghost SKU repricing
      // itself down to its own floor while the real listing sat disabled,
      // confirmed on B004IH1WSK/BR. Keying on ASIN alone fixed that and also
      // broke something legitimate -- selling the same ASIN both FBA and FBM is
      // ordinary practice, not an error state, and the two SKUs are two real
      // listings with two independent Buy Box competitions.
      //
      // Keyed on ASIN, the FBM SKU always loses: it ranks 2 (active, no stock)
      // against the FBA SKU's 3 (active, in stock), because FBM quantity lives
      // in the merchant listings report and is not in the FBA inventory feed
      // that usually creates the row first. Confirmed live on B0G2YNN87D --
      // D4M-1H7-45IW was created 17:07, assigned 18:45 and disabled 20:45 the
      // same day, and would have been disabled again after every later run.
      //
      // Ghost protection is unchanged WITHIN each channel: two FBA SKUs on one
      // ASIN still dedup against each other, and so do two FBM SKUs.
      const channelOf = (a: any): string => {
        const inv = invStatusMap.get(`${a.asin}:${a.sku}`);
        // No inventory row means no evidence of channel. Group those together
        // rather than spreading them across both lanes, so a pair of unmatched
        // SKUs on one ASIN still dedups the way it did before.
        if (!inv) return 'unknown';
        return inv.isFba ? 'FBA' : 'FBM';
      };
      const bestForAsin = new Map<string, { id: string; sku: string; rank: number; createdAt: string }>();
      for (const a of allEnabled) {
        if (toDisable.includes(a.id)) continue; // already marked for disable
        const rank = rankFor(a);
        const key = `${a.asin}:${channelOf(a)}`;
        const existing = bestForAsin.get(key);
        if (!existing) {
          bestForAsin.set(key, { id: a.id, sku: a.sku, rank, createdAt: a.created_at });
          continue;
        }
        const thisIsBetter = rank > existing.rank || (rank === existing.rank && a.created_at > existing.createdAt);
        const loserId = thisIsBetter ? existing.id : a.id;
        const loserSku = thisIsBetter ? existing.sku : a.sku;
        console.log(`[auto-assign-bulk] ⚠️ Dedup: disabling duplicate ${key}/${loserSku} (id=${loserId}, rank=${thisIsBetter ? existing.rank : rank}) in favor of ${thisIsBetter ? a.sku : existing.sku} (rank=${thisIsBetter ? rank : existing.rank})`);
        toDisable.push(loserId);
        deduplicatedCount++;
        if (thisIsBetter) {
          bestForAsin.set(key, { id: a.id, sku: a.sku, rank, createdAt: a.created_at });
        }
      }

      if (toDisable.length > 0) {
        const { error: cleanupErr } = await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: "cleanup",
            last_disabled_reason: "auto-assign-bulk: broken/deleted assignment",
            last_disabled_at: new Date().toISOString(),
          })
          .in("id", toDisable);

        if (!cleanupErr) {
          cleanedUpCount = toDisable.length;
          console.log(`[auto-assign-bulk] Cleaned up ${cleanedUpCount} broken/deleted assignments`);
        } else {
          console.error("[auto-assign-bulk] Cleanup error:", cleanupErr);
        }
      }
    }

    // 8. Update sync status — separate assignments_created from repricer_ready
    const totalUsable = results.created + preExistingCount;
    const hasUsableAssignments = totalUsable > 0;
    // repricer_ready = assignments exist AND at least some have valid cost/bounds
    const enabledCount = assignmentsToInsert.filter(a => a.is_enabled).length;
    const repricerReady = hasUsableAssignments && (enabledCount > 0 || preExistingCount > 0);

    await supabase.from("user_sync_status").upsert({
      user_id: userId,
      repricer_assignments_created: hasUsableAssignments,
      repricer_ready: repricerReady,
    }, { onConflict: "user_id" });

    const enabledMsg = enabledCount < results.created
      ? ` (${enabledCount} enabled, ${results.created - enabledCount} draft — missing cost data)`
      : "";

    console.log(`[auto-assign-bulk] ✅ Done: created=${results.created} skipped=${results.skipped} enabled=${enabledCount} reenabled=${reenabledCount} cleaned=${cleanedUpCount} deduplicated=${deduplicatedCount} autoRaised=${autoRaisedCount} errors=${results.errors}`);
    console.log(`[auto-assign-bulk] Skip reasons:`, results.skipReasons);

    const reenabledMsg = reenabledCount > 0 ? ` Re-enabled ${reenabledCount} with stock.` : "";
    const cleanedMsg = cleanedUpCount > 0 ? ` Disabled ${cleanedUpCount} broken/deleted/duplicate.` : "";
    const autoRaiseMsg = autoRaisedCount > 0 ? ` ${autoRaisedCount} flagged for ROI auto-raise.` : "";

    return new Response(JSON.stringify({
      success: true,
      created: results.created,
      enabled: enabledCount,
      reenabled: reenabledCount,
      deduplicated: deduplicatedCount,
      cleaned_up: cleanedUpCount,
      auto_raised: autoRaisedCount,
      skipped: results.skipped,
      errors: results.errors,
      existing_assignments: preExistingCount,
      skipReasons: results.skipReasons,
      repricer_ready: repricerReady,
      message: results.created > 0
        ? `Created ${results.created} assignments${enabledMsg}. ${results.skipped} skipped.${reenabledMsg}${cleanedMsg}${autoRaiseMsg}`
        : `No new assignments created. ${preExistingCount} existing.${reenabledMsg}${cleanedMsg}${autoRaiseMsg}`,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[auto-assign-bulk] Error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
