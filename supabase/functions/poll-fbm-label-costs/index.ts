// Auto-poller for FBM shipping label costs.
// Runs every 30 minutes via cron. For each FBM sales_orders row that:
//   - is younger than `windowDays` days (default 7)
//   - has no shipping_label_fee yet (or zero)
//   - source is not 'manual'
//   - last polled > 25 min ago (or never)
//   - poll_attempts < 60
// it calls the same lookup chain: Merchant Fulfillment -> Finances-by-order -> Finances-range.
// First hit wins; tags source as 'buy_shipping_rate' or 'amazon_finances'.
//
// ── WHY THE WINDOW IS A PARAMETER (2026-08-31) ────────────────────────────
//
// It was a hard-coded 7 days, and that contradicted the lookup chain above.
// Merchant Fulfillment answers within minutes, but Finances-by-order arrives
// "hours-to-days later" and the range scan later still -- so an order that had
// not resolved inside 7 days was abandoned before its own fallbacks could
// deliver. Measured against InventoryLab over 2026: 54 orders carry a label
// fee totalling $425.20 where InventoryLab reports $1,148.26, and the May-Aug
// period alone -- while the poller WAS running -- came to 75% coverage. The
// missing quarter is the window closing early.
//
// It also made the whole pre-May-2026 history unreachable: 22 MFN orders
// across Feb-Apr have no label cost and no way to acquire one, because the
// only query that finds candidates refuses to look further back than a week.
//
// Default stays 7, so the 30-minute cron is completely unchanged. A caller
// that wants history passes windowDays explicitly. Capped at 400: beyond that
// Amazon has nothing left to return and the run is just quota burnt.
//
// NOT a fix for the seller's whole gap. January had ZERO MFN orders against
// InventoryLab's $113.72, so that line is measuring something other than
// per-order FBM labels and no backfill will reproduce it. Widening the window
// recovers what is genuinely ours and nothing more.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { convertCurrency } from "../_shared/fx-utils.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ORDERS_PER_RUN = 200;
const POLL_COOLDOWN_MIN = 25;
const MAX_ATTEMPTS = 60;
const WINDOW_DAYS = 7;          // default; override per-call with windowDays
const MAX_WINDOW_DAYS = 400;
const INTER_ORDER_DELAY_MS = 900;

const MARKETPLACE_IDS: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

// ---- SP-API crypto (same as sync-fbm-label-cost) ----
async function sha256(message: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}
async function signSpApiRequest(method: string, url: string, accessToken: string): Promise<Record<string, string>> {
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS credentials not configured");
  const urlObj = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";
  const service = "execute-api";
  const canonicalHeaders = `host:${urlObj.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";
  const canonicalRequest = `${method}\n${urlObj.pathname}\n${urlObj.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${await sha256("")}`;
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;
  const kDate = await hmac(new TextEncoder().encode("AWS4" + secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = Array.from(new Uint8Array(await hmac(kSigning, stringToSign))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    host: urlObj.host,
    "x-amz-access-token": accessToken,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID") ?? Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") ?? Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("LWA credentials not configured");
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`LWA refresh failed: ${await res.text()}`);
  const j = await res.json();
  return j.access_token as string;
}

// ---- Fee correction (safety net) ----
// Confirming a real shipping-label cost is authoritative proof this order is
// FBM. If its fees were computed back when fulfillment_channel was still
// ambiguous (defaulted to assuming FBA — see fetch-live-orders/index.ts),
// referral_fee will be non-zero: correctly-computed FBM fees are always
// bundled entirely into fba_fee with referral_fee=0 (see the "FBM: Bundle
// ALL fees" convention there). Re-fetching here closes the loop for orders
// that won't get another enrichment pass (e.g. already shipped), where the
// sticky fulfillment_channel fix alone wouldn't self-heal them.
type CorrectedFees = { referralFee: number; fbaFee: number; closingFee: number; totalFees: number } | null;

async function getFbmFeesCorrection(
  supabase: any,
  asin: string,
  referencePriceUsd: number,
  accessToken: string,
  marketplaceId: string,
): Promise<CorrectedFees> {
  if (!asin || !(referencePriceUsd > 0)) return null;
  const url = `https://sellingpartnerapi-na.amazon.com/products/fees/v0/items/${asin}/feesEstimate`;
  const body = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: false,
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: "USD", Amount: referencePriceUsd } },
      Identifier: asin,
    },
  });
  try {
    await waitForApiToken(supabase, "fees_api");
    const headers = await signSpApiRequest("POST", url, accessToken);
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
    if (!res.ok) { console.warn(`[poll] fee correction failed for ${asin}: HTTP ${res.status}`); return null; }
    const data = await res.json();
    const feeDetails = data?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList;
    if (!Array.isArray(feeDetails)) return null;
    let referralFee = 0, fbaFee = 0, closingFee = 0;
    for (const fee of feeDetails) {
      const amount = Number(fee?.FeeAmount?.Amount ?? 0);
      const type = String(fee?.FeeType || "");
      if (type === "ReferralFee" || type.includes("Referral")) referralFee += amount;
      else if (type === "VariableClosingFee" || type === "FixedClosingFee" || type.includes("ClosingFee")) closingFee += amount;
      else if (type === "FBAFees" || type.startsWith("FBA") || type.includes("Fulfillment")) fbaFee += amount;
    }
    // Bundle into fba_fee, zero referral/closing — matches the FBM convention
    // used everywhere else this app writes sales_orders fee columns.
    const totalFbmFees = Math.round((referralFee + fbaFee + closingFee) * 100) / 100;
    return { referralFee: 0, fbaFee: totalFbmFees, closingFee: 0, totalFees: totalFbmFees };
  } catch (e) {
    console.warn(`[poll] fee correction error for ${asin}:`, (e as Error).message);
    return null;
  }
}

// ---- Resolvers (subset of sync-fbm-label-cost) ----
type Resolved = { amount: number; currency: string; source: "buy_shipping_rate" | "amazon_finances" };
type TraceStage = { stage: string; ok: boolean; status?: number; reason?: string; shipment_count?: number; shipment_ids?: string[]; candidate_amounts?: number[]; event_counts?: Record<string, number>; resolved_amount?: number };

function countFinancialEvents(events: any): Record<string, number> {
  return {
    ServiceFeeEventList: events?.ServiceFeeEventList?.length ?? 0,
    ShipmentEventList: events?.ShipmentEventList?.length ?? 0,
    RefundEventList: events?.RefundEventList?.length ?? 0,
    AdjustmentEventList: events?.AdjustmentEventList?.length ?? 0,
  };
}

async function tryMerchantFulfillment(orderId: string, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/mfn/v0/shipments?AmazonOrderId=${encodeURIComponent(orderId)}`;
  try {
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) { trace?.push({ stage: "merchant_fulfillment", ok: false, status: res.status, reason: text.slice(0, 300) }); return null; }
    const data = JSON.parse(text);
    const shipments: any[] = data?.payload?.Shipments ?? data?.payload ?? [];
    let total = 0; let currency = "USD"; const amounts: number[] = [];
    for (const s of shipments) {
      const rate = s?.ShippingService?.Rate || s?.Rate;
      const amount = Number(rate?.Amount ?? 0);
      if (Number.isFinite(amount) && amount > 0) { total += amount; amounts.push(amount); currency = String(rate?.CurrencyCode || currency); }
    }
    const baseTrace = { stage: "merchant_fulfillment", status: res.status, shipment_count: shipments.length, shipment_ids: shipments.map((s: any) => String(s?.ShipmentId || s?.ShipmentID || "")).filter(Boolean), candidate_amounts: amounts };
    if (total <= 0) { trace?.push({ ...baseTrace, ok: false, reason: "No ShippingService.Rate.Amount returned" }); return null; }
    const amount = Math.round(total * 100) / 100;
    trace?.push({ ...baseTrace, ok: true, resolved_amount: amount });
    return { amount, currency, source: "buy_shipping_rate" };
  } catch (err) { trace?.push({ stage: "merchant_fulfillment", ok: false, reason: (err as Error).message }); return null; }
}

function isLabelReason(v: unknown) {
  const s = String(v || "").toLowerCase().replace(/[\s_-]+/g, "");
  return s.includes("shippingservice") || s.includes("shippinglabel") || s.includes("buyshipping") || s.includes("postage");
}
function extractLabelCost(events: any, orderId: string, allowUnscopedAdjustments = false) {
  let total = 0; let currency = "USD";
  const add = (a: unknown, c: unknown) => {
    const v = Math.abs(Number(a ?? 0));
    if (Number.isFinite(v) && v > 0) { total += v; currency = String(c || currency); }
  };
  for (const event of events?.ServiceFeeEventList ?? []) {
    if (event?.AmazonOrderId && event.AmazonOrderId !== orderId) continue;
    const eventIsLabel = isLabelReason(event?.FeeReason);
    for (const fee of event?.FeeList ?? event?.FeeComponentList ?? []) {
      const feeType = fee?.FeeType || fee?.ChargeType || "";
      const label = `${feeType} ${event?.FeeReason || ""}`;
      const amount = fee?.FeeAmount || fee?.ChargeAmount || fee?.Amount || {};
      if (eventIsLabel) add(amount.CurrencyAmount, amount.CurrencyCode);
      else if (isLabelReason(label) && !/shippingchargeback/i.test(String(feeType))) add(amount.CurrencyAmount, amount.CurrencyCode);
    }
  }
  for (const event of events?.AdjustmentEventList ?? []) {
    if (event?.AmazonOrderId && event.AmazonOrderId !== orderId) continue;
    if (!event?.AmazonOrderId && !allowUnscopedAdjustments) continue;
    const adjustmentType = event?.AdjustmentType || event?.Reason || event?.Description || "";
    if (!isLabelReason(adjustmentType)) continue;
    const eventAmount = event?.TotalAmount || event?.AdjustmentAmount || event?.Amount || {};
    add(eventAmount.CurrencyAmount, eventAmount.CurrencyCode);
    for (const item of event?.AdjustmentItemList ?? []) {
      const amount = item?.TotalAmount || item?.AdjustmentAmount || item?.Amount || {};
      add(amount.CurrencyAmount, amount.CurrencyCode);
    }
  }
  return total > 0 ? { amount: Math.round(total * 100) / 100, currency } : null;
}

async function tryFinancesByOrder(supabase: any, orderId: string, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`;
  try {
    await waitForApiToken(supabase, 'finances_api');
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) { trace?.push({ stage: "finances_by_order", ok: false, status: res.status, reason: text.slice(0, 300) }); return null; }
    const data = JSON.parse(text);
    const events = data?.payload?.FinancialEvents ?? {};
    const r = extractLabelCost(events, orderId, true);
    trace?.push({ stage: "finances_by_order", ok: Boolean(r), status: res.status, event_counts: countFinancialEvents(events), resolved_amount: r?.amount, reason: r ? undefined : "No Buy Shipping/Postage label fee event found" });
    return r ? { ...r, source: "amazon_finances" } : null;
  } catch (err) { trace?.push({ stage: "finances_by_order", ok: false, reason: (err as Error).message }); return null; }
}

async function tryFinancesByRange(supabase: any, orderId: string, orderDate: string | null, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
  if (!orderDate) return null;
  const center = new Date(`${orderDate}T00:00:00.000Z`);
  if (Number.isNaN(center.getTime())) return null;
  const after = new Date(center);
  after.setUTCDate(after.getUTCDate() - 3);
  const before = new Date(center);
  before.setUTCDate(before.getUTCDate() + 21);
  const latestAllowedBefore = new Date(Date.now() - 2 * 60 * 1000);
  if (before > latestAllowedBefore) before.setTime(latestAllowedBefore.getTime());
  if (after >= before) after.setTime(before.getTime() - 24 * 60 * 60 * 1000);
  let nextToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ PostedAfter: after.toISOString(), PostedBefore: before.toISOString(), MaxResultsPerPage: "100" });
    if (nextToken) params.set("NextToken", nextToken);
    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params.toString()}`;
    await waitForApiToken(supabase, 'finances_api');
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) { trace?.push({ stage: "finances_range", ok: false, status: res.status, reason: text.slice(0, 300) }); return null; }
    const data = JSON.parse(text);
    const events = data?.payload?.FinancialEvents ?? {};
    const r = extractLabelCost(events, orderId, false);
    trace?.push({ stage: "finances_range", ok: Boolean(r), status: res.status, event_counts: countFinancialEvents(events), resolved_amount: r?.amount, reason: r ? undefined : `No label fee found on page ${page + 1}` });
    if (r) return { ...r, source: "amazon_finances" };
    nextToken = data?.payload?.NextToken ?? null;
    if (!nextToken) break;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = Date.now();
  let processed = 0, resolved = 0, errors = 0;
  const traces: Array<{ order_id: string; trace: TraceStage[]; found: Resolved | null }> = [];

  try {
    const body = await req.json().catch(() => ({}));
    const targetOrderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
    // Clamped rather than trusted: a bad value here means a full-table scan of
    // sales_orders and a run that spends SP-API quota on orders Amazon can no
    // longer answer for.
    const windowDays = Math.min(
      Math.max(Number(body?.windowDays) || WINDOW_DAYS, 1),
      MAX_WINDOW_DAYS,
    );
    const sinceDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cooldownTs = new Date(Date.now() - POLL_COOLDOWN_MIN * 60 * 1000).toISOString();

    // Fetch candidates. We OR last_polled IS NULL OR last_polled < cooldownTs.
    let candidateQuery = supabase
      .from("sales_orders")
      .select("id, order_id, user_id, marketplace, order_date, shipping_label_fee_poll_attempts, shipping_label_fee_last_polled_at, asin, referral_fee, sold_price, total_sale_amount, item_price, quantity")
      .eq("fulfillment_channel", "MFN")
      .or("shipping_label_fee.is.null,shipping_label_fee.eq.0")
      .or("shipping_label_fee_source.is.null,shipping_label_fee_source.neq.manual")
      .order("order_date", { ascending: false });

    if (targetOrderId) {
      candidateQuery = candidateQuery.eq("order_id", targetOrderId).limit(1);
    } else {
      candidateQuery = candidateQuery
        .gte("order_date", sinceDate)
        .lt("shipping_label_fee_poll_attempts", MAX_ATTEMPTS)
        .or(`shipping_label_fee_last_polled_at.is.null,shipping_label_fee_last_polled_at.lt.${cooldownTs}`)
        .limit(MAX_ORDERS_PER_RUN);
    }

    const { data: candidates, error: qErr } = await candidateQuery;

    if (qErr) throw qErr;

    // ── Diagnostic ladder (debug:true only) ─────────────────────────────
    //
    // On 2026-08-31 this query returned 0 candidates while the identical
    // filters written as SQL returned 23. Three hypotheses were wrong in a
    // row -- NULL poll_attempts (the column is NOT NULL DEFAULT 0), gateway
    // auth (verify_jwt is false), and the date window (an order_id-targeted
    // call, which skips the window entirely, also returned 0). Each cost a
    // round trip.
    //
    // So stop guessing: rebuild the filter one clause at a time and count.
    // Whichever step falls to 0 is the bug, and -1 means that step raised a
    // PostgREST error rather than returning rows -- which an .or() chain can
    // do silently when it is malformed.
    let debugLadder: Record<string, number | null> | undefined;
    if (body?.debug === true) {
      const cnt = async (build: (q: any) => any): Promise<number | null> => {
        const { count, error } = await build(
          supabase.from("sales_orders").select("id", { count: "exact", head: true }),
        );
        return error ? -1 : (count ?? null);
      };
      const mfn = (q: any) => q.eq("fulfillment_channel", "MFN");
      const since = (q: any) => mfn(q).gte("order_date", sinceDate);
      const feeOr = (q: any) => since(q).or("shipping_label_fee.is.null,shipping_label_fee.eq.0");
      const srcOr = (q: any) => feeOr(q).or("shipping_label_fee_source.is.null,shipping_label_fee_source.neq.manual");
      const attempts = (q: any) => srcOr(q).lt("shipping_label_fee_poll_attempts", MAX_ATTEMPTS);
      debugLadder = {
        a_mfn: await cnt(mfn),
        b_plus_since: await cnt(since),
        c_plus_fee_or: await cnt(feeOr),
        d_plus_source_or: await cnt(srcOr),
        e_plus_attempts: await cnt(attempts),
        f_plus_cooldown_or: await cnt((q: any) =>
          attempts(q).or(`shipping_label_fee_last_polled_at.is.null,shipping_label_fee_last_polled_at.lt.${cooldownTs}`)),
      };
    }

    // Cache tokens per user/marketplace
    const tokenCache = new Map<string, string | null>();
    const refreshCache = new Map<string, string | null>();
    const getRefreshForUser = async (userId: string, marketplace: string): Promise<string | null> => {
      const key = `${userId}:${marketplace}`;
      if (refreshCache.has(key)) return refreshCache.get(key)!;
      const mkt = MARKETPLACE_IDS[String(marketplace || "US").toUpperCase()] || MARKETPLACE_IDS.US;
      const { data: rows } = await supabase
        .from("seller_authorizations")
        .select("refresh_token, marketplace_id, is_active")
        .eq("user_id", userId)
        .eq("is_active", true);
      const row = (rows ?? []).find((r: any) => r.marketplace_id === mkt) || (rows ?? [])[0];
      const rt = row?.refresh_token || Deno.env.get("SPAPI_REFRESH_TOKEN") || null;
      refreshCache.set(key, rt);
      return rt;
    };
    const getAccess = async (refreshToken: string): Promise<string | null> => {
      if (tokenCache.has(refreshToken)) return tokenCache.get(refreshToken)!;
      try {
        const t = await getAccessToken(refreshToken);
        tokenCache.set(refreshToken, t);
        return t;
      } catch (err) {
        console.error(`[poll] LWA failed: ${(err as Error).message}`);
        tokenCache.set(refreshToken, null);
        return null;
      }
    };

    for (const o of candidates ?? []) {
      processed++;
      try {
        const rt = await getRefreshForUser(o.user_id, o.marketplace || "US");
        if (!rt) { errors++; continue; }
        const access = await getAccess(rt);
        if (!access) { errors++; continue; }

        const trace: TraceStage[] = [];
        let found = await tryMerchantFulfillment(o.order_id, access, trace);
        if (!found) found = await tryFinancesByOrder(supabase, o.order_id, access, trace);
        if (!found) found = await tryFinancesByRange(supabase, o.order_id, o.order_date, access, trace);

        if (found) {
          // FX SAFETY: shipping_label_fee column is USD. SP-API returns the
          // label cost in the marketplace's native currency (MXN/CAD/BRL for
          // non-US labels). Without conversion, MX $50 MXN would be stored as
          // "$50 USD" and inflate profit math ~17× for MX, ~5× for BR, ~1.4×
          // for CA. Convert here; if FX is unavailable, SKIP the write so the
          // row stays pollable rather than corrupted. See memory
          // [No Hardcoded FX] + .lovable/future-currency-unification.md.
          const foundCurrency = String(found.currency || "USD").toUpperCase();
          let usdAmount = found.amount;
          if (foundCurrency !== "USD") {
            try {
              const { converted, fxRate } = await convertCurrency(
                found.amount,
                foundCurrency,
                "USD",
                supabase,
              );
              if (!Number.isFinite(converted) || converted <= 0 || fxRate === 1) {
                // FX missing or degenerate — do NOT write native as USD.
                console.warn(
                  `[poll] SKIP ${o.order_id}: FX ${foundCurrency}->USD unavailable (native amount=${found.amount}); leaving pollable`,
                );
                await supabase.from("sales_orders").update({
                  shipping_label_fee_last_polled_at: new Date().toISOString(),
                  shipping_label_fee_poll_attempts: (o.shipping_label_fee_poll_attempts ?? 0) + 1,
                }).eq("id", o.id);
                errors++;
                if (targetOrderId) traces.push({ order_id: o.order_id, trace, found: { ...found, skipped: "fx_unavailable" } as any });
                continue;
              }
              usdAmount = Math.round(converted * 100) / 100;
              console.log(
                `[poll] FX ${o.order_id}: ${foundCurrency} ${found.amount} -> USD ${usdAmount} (rate=${fxRate.toFixed(4)})`,
              );
            } catch (fxErr) {
              console.error(`[poll] FX conversion failed for ${o.order_id}: ${(fxErr as Error).message}`);
              await supabase.from("sales_orders").update({
                shipping_label_fee_last_polled_at: new Date().toISOString(),
                shipping_label_fee_poll_attempts: (o.shipping_label_fee_poll_attempts ?? 0) + 1,
              }).eq("id", o.id);
              errors++;
              continue;
            }
          }

          // Safety-net fee correction: referral_fee > 0 means these fees were
          // computed while fulfillment_channel was still ambiguous — a real
          // FBA fee estimate got attached to what's now confirmed to be an
          // FBM order. Re-fetch under IsAmazonFulfilled=false and fold the
          // correction into this same write.
          let feeCorrection: Record<string, unknown> = {};
          if (Number(o.referral_fee) > 0 && o.asin) {
            const refPrice = Number(o.sold_price) > 0 ? Number(o.sold_price)
              : Number(o.total_sale_amount) > 0 ? Number(o.total_sale_amount) / Math.max(1, Number(o.quantity) || 1)
              : Number(o.item_price) > 0 ? Number(o.item_price)
              : 0;
            const mktId = MARKETPLACE_IDS[String(o.marketplace || "US").toUpperCase()] || MARKETPLACE_IDS.US;
            const corrected = await getFbmFeesCorrection(supabase, o.asin, refPrice, access, mktId);
            if (corrected) {
              feeCorrection = {
                referral_fee: corrected.referralFee,
                fba_fee: corrected.fbaFee,
                closing_fee: corrected.closingFee,
                total_fees: Math.round((corrected.totalFees + usdAmount) * 100) / 100,
              };
              console.log(`[poll] corrected FBM fees for ${o.order_id}: was referral=$${o.referral_fee}, now bundled fba_fee=$${corrected.fbaFee}`);
            } else {
              console.warn(`[poll] fee correction unavailable for ${o.order_id} (referral_fee=$${o.referral_fee} still stale)`);
            }
          }

          await supabase.from("sales_orders").update({
            shipping_label_fee: usdAmount,
            shipping_label_fee_source: found.source,
            shipping_label_fee_synced_at: new Date().toISOString(),
            shipping_label_fee_last_polled_at: new Date().toISOString(),
            shipping_label_fee_poll_attempts: (o.shipping_label_fee_poll_attempts ?? 0) + 1,
            ...feeCorrection,
          }).eq("id", o.id);
          resolved++;
          console.log(`[poll] resolved ${o.order_id} via ${found.source} = USD ${usdAmount} (from ${foundCurrency} ${found.amount})`);
          if (targetOrderId) traces.push({ order_id: o.order_id, trace, found: { ...found, usdAmount } as any });
        } else {
          console.log(`[poll] unresolved ${o.order_id}`, JSON.stringify(trace));
          if (targetOrderId) traces.push({ order_id: o.order_id, trace, found: null });
          await supabase.from("sales_orders").update({
            shipping_label_fee_last_polled_at: new Date().toISOString(),
            shipping_label_fee_poll_attempts: (o.shipping_label_fee_poll_attempts ?? 0) + 1,
          }).eq("id", o.id);
        }
      } catch (err) {
        errors++;
        console.error(`[poll] order ${o.order_id} error: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, INTER_ORDER_DELAY_MS));
    }

    const summary = {
      processed, resolved, errors, ms: Date.now() - startedAt,
      ...(targetOrderId ? { traces } : {}),
      ...(debugLadder
        ? { debug: { windowDays, sinceDate, cooldownTs, targetOrderId: targetOrderId || null, candidates: candidates?.length ?? 0, ladder: debugLadder } }
        : {}),
    };
    console.log(`[poll-fbm-label-costs] done`, summary);
    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[poll-fbm-label-costs] fatal:", err);
    return new Response(JSON.stringify({ error: (err as Error).message, processed, resolved, errors }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
