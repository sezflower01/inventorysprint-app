// Nightly learner for international fee multipliers (CA / MX / BR).
//
// For each user × marketplace × fee_component, compares a FRESH estimate —
// recomputed from asin_fee_cache (referral_rate × real settled price, cached
// FBA fee, media-closing constant), the exact same formula the live
// pending-order path uses — against the actual settled fee on
// `financial_events_cache`. The resulting ratio (actual / estimated) is
// stored in `learned_fee_multipliers` / `learned_fee_multipliers_asin`.
//
// IMPORTANT (2026-07-30 rework): this used to read the "estimate" side off
// `sales_orders.referral_fee/fba_fee/closing_fee/total_fees`. That became a
// tautology once a separate historical-settlement reconciliation started
// overwriting those exact columns with the FEC actual for settled orders —
// comparing a value to itself always yields multiplier≈1.0, silently
// masking any real correction. Recomputing the estimate independently from
// asin_fee_cache (never touched by that reconciliation) fixes this and
// matches what the read path is actually correcting for: "how far off is
// today's cache-based estimate formula from reality for this product."
//
// Safety rails:
//  - Per-user, per-marketplace. No global aggregation.
//  - Rolling 180-day window.
//  - Cron-locked + throttle-aware.
//  - Sanity clamp: ignores multipliers outside [0.5, 4.0].
//  - Sample size gates confidence; <10 samples => 'insufficient' and is
//    persisted but flagged as not-applicable.
//  - Settled fees are never written or modified.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchLiveFeesForAsin } from "../_shared/spapi-fees-live.ts";
import { getUsdToRate } from "../_shared/fx-utils.ts";

/** Marketplace -> the currency the Fees API answers in for it. */
const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const WINDOW_DAYS = 180;
const MARKETPLACES = ["CA", "MX", "BR"] as const;
const COMPONENTS = ["referral", "fba", "closing", "total"] as const;
const MIN_SALE_PRICE_USD = 5;
const CLAMP_MIN = 0.5;
const CLAMP_MAX = 4.0;
// Matches src/lib/sales/feeNormalization.ts getCachedFeesUsd's assumed
// per-unit media closing fee when only the cache (no live SP-API call) is
// available. Keep these in sync.
const MEDIA_CLOSING_FEE_USD = 1.8;
const DEFAULT_REFERRAL_RATE = 0.15;

// Targeted live-fee refresh for below-floor ASINs (see the "someone is
// waiting on this number today" scoping discussion): only ASINs that both
// (a) have fewer than MIN_ASIN_SAMPLE settled orders and (b) currently have
// a pending intl order get a live SP-API Fees lookup, instead of refreshing
// every below-floor ASIN in the account's whole history regardless of
// whether anything is actively pending. Bounded globally per invocation so
// a large backlog can't balloon run time or contend with the repricer's
// own live pricing calls; any overflow is simply picked up the next night.
const MAX_LIVE_FETCHES_PER_RUN = 100;
// Don't re-verify an ASIN that was already live-checked recently — pending
// orders can sit for weeks without their price/fees changing day to day.
const LIVE_FETCH_STALENESS_DAYS = 14;

type Component = (typeof COMPONENTS)[number];

interface SettledRow {
  amazon_order_id: string;
  referral_fees: number;
  fba_fees: number;
  variable_closing_fees: number;
  fixed_closing_fees: number;
  sales: number;
}

interface OrderMetaRow {
  order_id: string;
  asin: string | null;
  quantity: number | null;
  is_cancelled: boolean | null;
}

interface FeeCacheRow {
  asin: string;
  referral_rate: number | null;
  fba_fee_fixed: number | null;
  is_media: boolean | null;
}

function confidenceFor(n: number): "insufficient" | "low" | "medium" | "high" {
  if (n < 10) return "insufficient";
  if (n < 30) return "low";
  if (n < 100) return "medium";
  return "high";
}

// ASIN-level samples are inherently much smaller than the marketplace-wide
// blend (a handful of settled orders per product vs. hundreds account-wide),
// so the floor to even attempt a per-ASIN correction is lower. Below
// MIN_ASIN_SAMPLE the read path always falls back to the marketplace blend.
const MIN_ASIN_SAMPLE = 3;
function confidenceForAsin(n: number): "insufficient" | "low" | "medium" | "high" {
  if (n < MIN_ASIN_SAMPLE) return "insufficient";
  if (n < 10) return "low";
  if (n < 30) return "medium";
  return "high";
}

function clampMultiplier(actualSum: number, estSum: number): number | null {
  if (estSum <= 0 || !Number.isFinite(estSum) || !Number.isFinite(actualSum)) {
    return null;
  }
  const m = actualSum / estSum;
  if (!Number.isFinite(m) || m < CLAMP_MIN || m > CLAMP_MAX) return null;
  return Math.round(m * 10000) / 10000;
}

interface LiveFetchBudget {
  remaining: number;
}

/**
 * Targeted live-fee refresh: only ASINs that are both below the sample
 * floor AND have a currently-pending intl order get a live SP-API Fees
 * lookup (see the "someone is waiting on this number today" scoping
 * decision). Results are cached into asin_fee_cache tagged
 * fee_source='live_verified' so the normal read path stays DB-only and
 * fast — this never runs synchronously during a page render.
 */
async function liveRefreshBelowFloorPendingAsins(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  marketplace: "CA" | "MX" | "BR",
  budget: LiveFetchBudget,
): Promise<{ attempted: number; succeeded: number }> {
  if (budget.remaining <= 0) return { attempted: 0, succeeded: 0 };

  // Distinct real ASINs with a currently-pending order in this marketplace,
  // and the native-currency price to use for the Fees API call (estimated_price
  // is stored native for non-US marketplaces per the Sales Currency Contract).
  const { data: pendingRows, error: pendingErr } = await supabase
    .from("sales_orders")
    .select("asin, estimated_price")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("status", "pending")
    .not("order_id", "like", "%-REFUND")
    .not("asin", "is", null)
    .neq("asin", "PENDING")
    .neq("asin", "UNKNOWN")
    .gt("estimated_price", 0);
  if (pendingErr) {
    console.warn(`[learn-intl-fee-multipliers] LIVE_REFRESH pending pull error user=${userId} mp=${marketplace}:`, pendingErr.message);
    return { attempted: 0, succeeded: 0 };
  }
  if (!pendingRows || pendingRows.length === 0) return { attempted: 0, succeeded: 0 };

  const priceByAsin = new Map<string, number>();
  for (const r of pendingRows) {
    const asin = String((r as any).asin || "").trim();
    if (!asin || priceByAsin.has(asin)) continue;
    const p = Number((r as any).estimated_price || 0);
    if (p > 0) priceByAsin.set(asin, p);
  }
  if (priceByAsin.size === 0) return { attempted: 0, succeeded: 0 };

  const distinctAsins = Array.from(priceByAsin.keys());
  const CHUNK = 200;

  // Which of these are below the sample floor? (missing row counts as 0)
  const sampleCountByAsin = new Map<string, number>();
  for (let i = 0; i < distinctAsins.length; i += CHUNK) {
    const slice = distinctAsins.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("learned_fee_multipliers_asin")
      .select("asin, sample_count")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("fee_component", "total")
      .in("asin", slice);
    for (const r of data || []) sampleCountByAsin.set(String((r as any).asin), Number((r as any).sample_count || 0));
  }
  const belowFloor = distinctAsins.filter((a) => (sampleCountByAsin.get(a) ?? 0) < MIN_ASIN_SAMPLE);
  if (belowFloor.length === 0) return { attempted: 0, succeeded: 0 };

  // Skip ones already live-verified recently — pending orders can sit for
  // weeks without their price/fees changing day to day.
  const staleCutoff = new Date(Date.now() - LIVE_FETCH_STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: existingCache } = await supabase
    .from("asin_fee_cache")
    .select("asin, fee_source, last_verified_at")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .in("asin", belowFloor);
  const recentlyVerified = new Set(
    (existingCache || [])
      .filter((r: any) => r.fee_source === "live_verified" && r.last_verified_at && r.last_verified_at > staleCutoff)
      .map((r: any) => String(r.asin)),
  );
  const toRefresh = belowFloor.filter((a) => !recentlyVerified.has(a));
  if (toRefresh.length === 0) return { attempted: 0, succeeded: 0 };

  let attempted = 0;
  let succeeded = 0;
  for (const asin of toRefresh) {
    if (budget.remaining <= 0) break;
    const price = priceByAsin.get(asin);
    if (!price) continue;
    budget.remaining -= 1;
    attempted += 1;

    const result = await fetchLiveFeesForAsin(supabase, asin, marketplace, price);
    if (!result) continue;
    const feeFx = await getUsdToRate(supabase, MARKETPLACE_CURRENCY[marketplace] ?? "USD");

    const { error: upsertErr } = await supabase
      .from("asin_fee_cache")
      .upsert(
        {
          user_id: userId,
          asin,
          marketplace,
          // Same currency fault as calculate-roi-floor, same fix.
          // fetchLiveFeesForAsin asks the Fees API in config.currency, so
          // fbaFee returns in MXN/CAD/BRL while asin_fee_cache.fba_fee_fixed
          // is contracted as USD. backfill-fee-cache, the writer behind the
          // trusted fees_api rows, states the rule outright: "sends NATIVE
          // currency, converts response back to USD before returning".
          fba_fee_fixed: feeFx > 0 ? result.fbaFee / feeFx : result.fbaFee,
          // The rate is NOT converted -- it is a ratio of two native amounts
          // and is already dimensionless. But it is range-checked, because
          // this writer has produced impossible ones: 7 MX rows, 3 of them
          // above 25 pct and one at 69.14 pct, which Amazon charges on no
          // category. A rate that cannot be real is not written at all, so the
          // read path falls through to a source that can be trusted rather
          // than onto a confident wrong number.
          referral_rate: (result.referralRate > 0 && result.referralRate <= 0.30)
            ? result.referralRate
            : null,
          is_media: result.isMedia,
          fee_source: "live_verified",
          last_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          attempt_count: 0,
          last_error: null,
        },
        { onConflict: "user_id,asin,marketplace" },
      );
    if (upsertErr) {
      console.warn(`[learn-intl-fee-multipliers] LIVE_REFRESH cache upsert error ${asin}/${marketplace}:`, upsertErr.message);
    } else {
      succeeded += 1;
    }
  }

  console.log(
    `[learn-intl-fee-multipliers] LIVE_REFRESH ${marketplace} user=${userId}: pendingAsins=${distinctAsins.length} belowFloor=${belowFloor.length} toRefresh=${toRefresh.length} attempted=${attempted} succeeded=${succeeded} budgetLeft=${budget.remaining}`,
  );
  return { attempted, succeeded };
}

async function processUserMarketplace(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  marketplace: "CA" | "MX" | "BR",
  windowStart: string,
  windowEnd: string,
  liveFetchBudget: LiveFetchBudget,
): Promise<{ written: number; skipped: number; liveFetchAttempted: number; liveFetchSucceeded: number }> {
  // 1) Pull settled fees from FEC for this marketplace, this window.
  //    Aggregate per amazon_order_id (one order can have multiple shipment events).
  const settledByOrder = new Map<string, SettledRow>();
  const PAGE = 1000;
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await supabase
      .from("financial_events_cache")
      .select(
        "amazon_order_id, referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees, sales",
      )
      .eq("user_id", userId)
      .eq("event_type", "shipment")
      .eq("marketplace", marketplace)
      .gte("event_date", windowStart)
      .lte("event_date", windowEnd)
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] FEC pull error user=${userId} mp=${marketplace}:`,
        error.message,
      );
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const oid = String(r.amazon_order_id || "").trim();
      if (!oid) continue;
      const prev = settledByOrder.get(oid) || {
        amazon_order_id: oid,
        referral_fees: 0,
        fba_fees: 0,
        variable_closing_fees: 0,
        fixed_closing_fees: 0,
        sales: 0,
      };
      // Settled fees in FEC are negative; we want absolute values.
      prev.referral_fees += Math.abs(Number(r.referral_fees || 0));
      prev.fba_fees += Math.abs(Number(r.fba_fees || 0));
      prev.variable_closing_fees += Math.abs(
        Number(r.variable_closing_fees || 0),
      );
      prev.fixed_closing_fees += Math.abs(Number(r.fixed_closing_fees || 0));
      prev.sales += Math.abs(Number(r.sales || 0));
      settledByOrder.set(oid, prev);
    }
    if (data.length < PAGE) break;
  }

  if (settledByOrder.size === 0) {
    // Upsert insufficient rows so the table reflects "we tried but had no data".
    for (const component of COMPONENTS) {
      await supabase
        .from("learned_fee_multipliers")
        .upsert(
          {
            user_id: userId,
            marketplace,
            fee_component: component,
            sample_count: 0,
            multiplier: null,
            confidence: "insufficient",
            window_start: windowStart,
            window_end: windowEnd,
            sample_orders: [],
            raw_estimated_total: 0,
            raw_actual_total: 0,
            last_computed_at: new Date().toISOString(),
          },
          { onConflict: "user_id,marketplace,fee_component" },
        );
    }
    // No settled history at all yet — still worth a live-fee check for any
    // currently-pending order on a first-time-sale ASIN (see "first time
    // sales, no settled history at all" case).
    const liveResult = await liveRefreshBelowFloorPendingAsins(supabase, userId, marketplace, liveFetchBudget);
    return { written: 0, skipped: 0, liveFetchAttempted: liveResult.attempted, liveFetchSucceeded: liveResult.succeeded };
  }

  // 2) Pull matching sales_orders rows — metadata only (asin, quantity).
  // Deliberately does NOT read referral_fee/fba_fee/closing_fee/total_fees:
  // those columns get overwritten with the FEC actual by the historical-
  // settlement reconciliation step, so trusting them here would compare a
  // value to itself. See file header.
  const orderIds = Array.from(settledByOrder.keys());
  const metaByOrder = new Map<string, OrderMetaRow>();
  const CHUNK = 200;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const slice = orderIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("sales_orders")
      .select("order_id, asin, quantity, is_cancelled")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .in("order_id", slice);
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] sales_orders pull error user=${userId} mp=${marketplace}:`,
        error.message,
      );
      continue;
    }
    for (const r of data || []) {
      const oid = String(r.order_id || "").trim();
      if (!oid) continue;
      // Skip refund / cancelled rows.
      if (oid.endsWith("-REFUND")) continue;
      if (r.is_cancelled === true) continue;
      metaByOrder.set(oid, r as OrderMetaRow);
    }
  }

  // 2b) Pull asin_fee_cache for every distinct real ASIN among these orders —
  // this is the independent source of "what would the estimate formula
  // produce", never touched by sales_orders reconciliation.
  const isRealAsin = (val: string | null | undefined): val is string =>
    !!val && val !== "PENDING" && val !== "UNKNOWN";
  const distinctAsins = Array.from(
    new Set(
      Array.from(metaByOrder.values())
        .map((r) => (isRealAsin(r.asin) ? r.asin : null))
        .filter((a): a is string => !!a),
    ),
  );
  const feeCacheByAsin = new Map<string, FeeCacheRow>();
  for (let i = 0; i < distinctAsins.length; i += CHUNK) {
    const slice = distinctAsins.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("asin_fee_cache")
      .select("asin, referral_rate, fba_fee_fixed, is_media")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .in("asin", slice);
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] asin_fee_cache pull error user=${userId} mp=${marketplace}:`,
        error.message,
      );
      continue;
    }
    for (const r of data || []) {
      const asin = String(r.asin || "").trim();
      if (!asin) continue;
      feeCacheByAsin.set(asin, r as FeeCacheRow);
    }
  }

  // 3) Build per-component sums — both the marketplace-wide blend and, in
  // parallel, a per-ASIN breakdown. The blend stays account-wide (many
  // products' fee profiles averaged together); the per-ASIN sums let the
  // read path correct a specific product from its own settlement history
  // instead of a blended average that may not represent it well.
  type Sums = Record<Component, { actual: number; estimated: number; samples: string[]; count: number }>;
  const makeSums = (): Sums => ({
    referral: { actual: 0, estimated: 0, samples: [], count: 0 },
    fba: { actual: 0, estimated: 0, samples: [], count: 0 },
    closing: { actual: 0, estimated: 0, samples: [], count: 0 },
    total: { actual: 0, estimated: 0, samples: [], count: 0 },
  });
  const sums: Sums = makeSums();
  const asinSums = new Map<string, Sums>();

  for (const [oid, meta] of metaByOrder) {
    const settled = settledByOrder.get(oid);
    if (!settled) continue;
    if (!(settled.sales >= MIN_SALE_PRICE_USD)) continue;

    const asin = isRealAsin(meta.asin) ? meta.asin : null;
    const cache = asin ? feeCacheByAsin.get(asin) : undefined;
    if (!cache) continue; // no independent estimate source available — skip

    const qty = Math.max(1, Number(meta.quantity || 0));
    const referralRate = cache.referral_rate != null && cache.referral_rate > 0
      ? Number(cache.referral_rate)
      : DEFAULT_REFERRAL_RATE;
    const estReferral = settled.sales * referralRate;
    const estFba = Number(cache.fba_fee_fixed || 0) * qty;
    const estClosing = cache.is_media ? MEDIA_CLOSING_FEE_USD * qty : 0;
    const estTotal = estReferral + estFba + estClosing;

    const settledClosing = settled.variable_closing_fees + settled.fixed_closing_fees;
    const settledTotal = settled.referral_fees + settled.fba_fees + settledClosing;

    const components: Record<Component, { actual: number; estimated: number }> = {
      referral: { actual: settled.referral_fees, estimated: estReferral },
      fba: { actual: settled.fba_fees, estimated: estFba },
      closing: { actual: settledClosing, estimated: estClosing },
      total: { actual: settledTotal, estimated: estTotal },
    };

    if (asin && !asinSums.has(asin)) asinSums.set(asin, makeSums());
    const asinS = asin ? asinSums.get(asin)! : null;

    for (const c of COMPONENTS) {
      const { actual, estimated } = components[c];
      // Skip components where the fresh estimate is zero — they'd produce
      // div-by-zero or infinite ratios (e.g. non-media closing fee).
      if (!(estimated > 0)) continue;
      if (!(actual >= 0)) continue;
      sums[c].actual += actual;
      sums[c].estimated += estimated;
      sums[c].count += 1;
      if (sums[c].samples.length < 5) sums[c].samples.push(oid);

      if (asinS) {
        asinS[c].actual += actual;
        asinS[c].estimated += estimated;
        asinS[c].count += 1;
        if (asinS[c].samples.length < 5) asinS[c].samples.push(oid);
      }
    }
  }

  // 4) Upsert per component.
  let written = 0;
  let skipped = 0;
  for (const component of COMPONENTS) {
    const s = sums[component];
    const multiplier = clampMultiplier(s.actual, s.estimated);
    const confidence = multiplier === null ? "insufficient" : confidenceFor(s.count);

    const { error } = await supabase
      .from("learned_fee_multipliers")
      .upsert(
        {
          user_id: userId,
          marketplace,
          fee_component: component,
          sample_count: s.count,
          multiplier,
          confidence,
          window_start: windowStart,
          window_end: windowEnd,
          sample_orders: s.samples,
          raw_estimated_total: Math.round(s.estimated * 10000) / 10000,
          raw_actual_total: Math.round(s.actual * 10000) / 10000,
          last_computed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,marketplace,fee_component" },
      );
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] upsert error user=${userId} mp=${marketplace} c=${component}:`,
        error.message,
      );
      skipped += 1;
    } else {
      written += 1;
    }
  }

  // 5) Upsert per-ASIN breakdown, batched into one call per marketplace to
  // avoid one round trip per (asin, component) pair — a seller can easily
  // have hundreds of ASINs with intl settlement history.
  if (asinSums.size > 0) {
    const asinRows: Record<string, unknown>[] = [];
    for (const [asin, s] of asinSums) {
      for (const component of COMPONENTS) {
        const cs = s[component];
        const multiplier = clampMultiplier(cs.actual, cs.estimated);
        const confidence = multiplier === null ? "insufficient" : confidenceForAsin(cs.count);
        asinRows.push({
          user_id: userId,
          marketplace,
          asin,
          fee_component: component,
          sample_count: cs.count,
          multiplier,
          confidence,
          window_start: windowStart,
          window_end: windowEnd,
          sample_orders: cs.samples,
          raw_estimated_total: Math.round(cs.estimated * 10000) / 10000,
          raw_actual_total: Math.round(cs.actual * 10000) / 10000,
          last_computed_at: new Date().toISOString(),
        });
      }
    }

    // Batch in chunks of 500 to stay well under any request-size limits.
    const UPSERT_CHUNK = 500;
    for (let i = 0; i < asinRows.length; i += UPSERT_CHUNK) {
      const chunk = asinRows.slice(i, i + UPSERT_CHUNK);
      const { error } = await supabase
        .from("learned_fee_multipliers_asin")
        .upsert(chunk, { onConflict: "user_id,marketplace,asin,fee_component" });
      if (error) {
        console.warn(
          `[learn-intl-fee-multipliers] asin upsert error user=${userId} mp=${marketplace}:`,
          error.message,
        );
        skipped += chunk.length;
      } else {
        written += chunk.length;
      }
    }
  }

  // 6) Targeted live-fee refresh (see "someone is waiting on this number
  // today" scoping decision) — only for below-floor ASINs with a currently-
  // pending order, bounded by the shared per-invocation budget.
  const liveResult = await liveRefreshBelowFloorPendingAsins(supabase, userId, marketplace, liveFetchBudget);

  return { written, skipped, liveFetchAttempted: liveResult.attempted, liveFetchSucceeded: liveResult.succeeded };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Cron-lock so overlapping invocations don't double-write.
  let cronRunId: number | null = null;

  async function runJob(): Promise<Response> {
    // Optional throttle. should_throttle_now() returns text ('ok' | 'throttle'
    // | 'skip'), not a boolean -- a prior `=== true` check here never matched
    // and silently never throttled anything. Compare against the actual
    // string values instead (same pattern as prewarm-profit-loss-all).
    try {
      const { data: throttleState } = await supabase.rpc("should_throttle_now");
      if (throttleState === "skip" || throttleState === "throttle") {
        if (cronRunId) {
          await supabase.rpc("record_cron_run_finish", {
            p_id: cronRunId,
            p_status: "throttled",
          });
        }
        return new Response(
          JSON.stringify({ ok: false, reason: "throttled", throttled: throttleState }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    } catch (_) {
      // throttle helper optional
    }

    // Allow targeting a single user (manual debug) via body.
    let onlyUserId: string | null = null;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.user_id === "string") onlyUserId = body.user_id;
    } catch (_) {}

    // Window bounds.
    const today = new Date();
    const windowEnd = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - WINDOW_DAYS * 86400 * 1000);
    const windowStart = start.toISOString().slice(0, 10);

    // Get user set. Two sources, unioned:
    //  (a) users with any settled intl event in the window — the normal
    //      case, needed to compute/refresh the learned multipliers.
    //  (b) users with a currently-pending intl order, even with ZERO
    //      settled history — a first-time intl sale wouldn't appear in (a)
    //      at all, but still deserves the targeted live-fee-refresh check.
    let userIds: string[] = [];
    if (onlyUserId) {
      userIds = [onlyUserId];
    } else {
      const set = new Set<string>();

      const { data: settledUsers, error: settledErr } = await supabase
        .from("financial_events_cache")
        .select("user_id")
        .eq("event_type", "shipment")
        .in("marketplace", MARKETPLACES as unknown as string[])
        .gte("event_date", windowStart)
        .lte("event_date", windowEnd)
        .limit(50000);
      if (settledErr) {
        console.warn("[learn-intl-fee-multipliers] settled-user enumeration error:", settledErr.message);
      }
      for (const r of settledUsers || []) {
        const uid = String((r as { user_id?: string }).user_id || "").trim();
        if (uid) set.add(uid);
      }

      const { data: pendingUsers, error: pendingErr } = await supabase
        .from("sales_orders")
        .select("user_id")
        .eq("status", "pending")
        .in("marketplace", MARKETPLACES as unknown as string[])
        .not("order_id", "like", "%-REFUND")
        .limit(50000);
      if (pendingErr) {
        console.warn("[learn-intl-fee-multipliers] pending-user enumeration error:", pendingErr.message);
      }
      for (const r of pendingUsers || []) {
        const uid = String((r as { user_id?: string }).user_id || "").trim();
        if (uid) set.add(uid);
      }

      userIds = Array.from(set);
    }

    let totalWritten = 0;
    let totalSkipped = 0;
    let totalLiveFetchAttempted = 0;
    let totalLiveFetchSucceeded = 0;
    let userCount = 0;
    const liveFetchBudget: LiveFetchBudget = { remaining: MAX_LIVE_FETCHES_PER_RUN };
    for (const uid of userIds) {
      for (const mp of MARKETPLACES) {
        try {
          const r = await processUserMarketplace(
            supabase,
            uid,
            mp,
            windowStart,
            windowEnd,
            liveFetchBudget,
          );
          totalWritten += r.written;
          totalSkipped += r.skipped;
          totalLiveFetchAttempted += r.liveFetchAttempted;
          totalLiveFetchSucceeded += r.liveFetchSucceeded;
        } catch (e) {
          console.warn(
            `[learn-intl-fee-multipliers] user=${uid} mp=${mp} failed:`,
            (e as Error).message,
          );
        }
        // tiny pause to avoid bursting
        await new Promise((res) => setTimeout(res, 50));
      }
      userCount += 1;
    }

    if (cronRunId) {
      await supabase.rpc("record_cron_run_finish", {
        p_id: cronRunId,
        p_status: "done",
        p_rows: totalWritten,
        p_notes: `users=${userCount} written=${totalWritten} skipped=${totalSkipped} live_attempted=${totalLiveFetchAttempted} live_succeeded=${totalLiveFetchSucceeded}`,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        users: userCount,
        rows_written: totalWritten,
        rows_skipped: totalSkipped,
        live_fetch_attempted: totalLiveFetchAttempted,
        live_fetch_succeeded: totalLiveFetchSucceeded,
        live_fetch_budget_remaining: liveFetchBudget.remaining,
        window_start: windowStart,
        window_end: windowEnd,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const { data: lockOk } = await supabase.rpc("try_acquire_cron_lock", {
      p_job_name: "learn-intl-fee-multipliers",
      p_ttl_seconds: 1800,
    });
    if (!lockOk) {
      return new Response(
        JSON.stringify({ ok: false, reason: "lock_busy" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Lock was acquired above -- guarantee it's released on every exit path
    // from here on (success, throttled, or the fatal error caught below),
    // including if record_cron_run_start itself throws. Previously the lock
    // was never released and only cleared via its 30-minute TTL, so the job
    // could silently go dark for up to 30 minutes after any single run.
    try {
      const { data: runId } = await supabase.rpc("record_cron_run_start", {
        p_job: "learn-intl-fee-multipliers",
        p_overlap_window_minutes: 30,
      });
      cronRunId = typeof runId === "number" ? runId : null;

      return await runJob();
    } finally {
      try {
        await supabase.rpc("release_cron_lock", { p_job_name: "learn-intl-fee-multipliers" });
      } catch (e) {
        console.warn("[learn-intl-fee-multipliers] release_cron_lock failed:", (e as Error)?.message ?? e);
      }
    }
  } catch (e) {
    console.error("[learn-intl-fee-multipliers] fatal:", e);
    if (cronRunId) {
      try {
        await supabase.rpc("record_cron_run_finish", {
          p_id: cronRunId,
          p_status: "error",
          p_notes: String((e as Error).message || e).slice(0, 500),
        });
      } catch {
        // best-effort logging only -- must not mask the real error being returned below
      }
    }
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error).message || e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
