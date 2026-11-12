// Sync FBM shipping label cost for a single sales_orders row.
//
// Resolution order (each step writes shipping_label_fee + source and stops):
//   1. manual_amount provided                -> source='manual'
//   2. Merchant Fulfillment API (per order)  -> source='buy_shipping_rate'  (PRIMARY - available within minutes)
//   3. Finances by order ID                  -> source='amazon_finances'    (hours-to-days later)
//   4. Finances date-range scan              -> source='amazon_finances'
//   5. Nothing found                         -> returns { found:false }, UI prompts manual entry
//
// Settlement reconciliation (source='settlement') is handled by fetch-profit-loss
// when FEC posts the confirmed amount; it may overwrite buy_shipping_rate / amazon_finances.
// Manual entries are never overwritten unless caller passes force=true.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mayActOnOperatorCredentials } from "../_shared/operator-credential-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId =
    Deno.env.get("LWA_CLIENT_ID") ?? Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret =
    Deno.env.get("LWA_CLIENT_SECRET") ?? Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("LWA credentials not configured");

  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`LWA refresh failed: ${await res.text()}`);
  const j = await res.json();
  return j.access_token as string;
}

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

const MARKETPLACE_IDS: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

type Resolved = { amount: number; currency: string; source: "buy_shipping_rate" | "amazon_finances"; raw?: unknown };
type TraceStage = {
  stage: "merchant_fulfillment" | "finances_by_order" | "finances_range";
  ok: boolean;
  status?: number;
  shipment_ids?: string[];
  shipment_count?: number;
  candidate_amounts?: number[];
  event_counts?: Record<string, number>;
  resolved_amount?: number;
  reason?: string;
  raw?: unknown;
};

function countFinancialEvents(events: any): Record<string, number> {
  return {
    ServiceFeeEventList: events?.ServiceFeeEventList?.length ?? 0,
    ShipmentEventList: events?.ShipmentEventList?.length ?? 0,
    RefundEventList: events?.RefundEventList?.length ?? 0,
    AdjustmentEventList: events?.AdjustmentEventList?.length ?? 0,
  };
}

// ---------- 1) PRIMARY: Merchant Fulfillment API ----------
// GET /mfn/v0/shipments?AmazonOrderId=...  returns shipments with ShippingService.Rate.Amount.
// Available within minutes of the seller purchasing the Buy Shipping label.
async function tryMerchantFulfillment(orderId: string, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/mfn/v0/shipments?AmazonOrderId=${encodeURIComponent(orderId)}`;
  try {
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      // 404 = no shipment created yet; that's expected for very fresh orders.
      console.log(`[label-cost] mfn ${res.status}: ${text.slice(0, 200)}`);
      trace?.push({ stage: "merchant_fulfillment", ok: false, status: res.status, reason: text.slice(0, 500) });
      return null;
    }
    const data = JSON.parse(text);
    const shipments: any[] = data?.payload?.Shipments ?? data?.payload ?? [];
    const candidates: Array<{ amount: number; currency: string; raw: unknown }> = [];
    for (const s of shipments) {
      const rate = s?.ShippingService?.Rate || s?.Rate;
      const amount = Number(rate?.Amount ?? 0);
      const currency = String(rate?.CurrencyCode || "USD");
      if (Number.isFinite(amount) && amount > 0) candidates.push({ amount, currency, raw: s });
    }
    if (candidates.length === 0) {
      trace?.push({
        stage: "merchant_fulfillment",
        ok: false,
        status: res.status,
        shipment_count: shipments.length,
        shipment_ids: shipments.map((s: any) => String(s?.ShipmentId || s?.ShipmentID || "")).filter(Boolean),
        candidate_amounts: [],
        reason: "No ShippingService.Rate.Amount returned",
        raw: data,
      });
      return null;
    }
    // Sum across multiple shipments for the same order (rare but possible).
    const total = candidates.reduce((sum, c) => sum + c.amount, 0);
    trace?.push({
      stage: "merchant_fulfillment",
      ok: true,
      status: res.status,
      shipment_count: shipments.length,
      shipment_ids: shipments.map((s: any) => String(s?.ShipmentId || s?.ShipmentID || "")).filter(Boolean),
      candidate_amounts: candidates.map((c) => c.amount),
      resolved_amount: Math.round(total * 100) / 100,
      raw: data,
    });
    return {
      amount: Math.round(total * 100) / 100,
      currency: candidates[0].currency,
      source: "buy_shipping_rate",
      raw: candidates[0].raw,
    };
  } catch (err) {
    console.log(`[label-cost] mfn error: ${(err as Error).message}`);
    trace?.push({ stage: "merchant_fulfillment", ok: false, reason: (err as Error).message });
    return null;
  }
}

// ---------- 2/3) Finances fallback ----------
function isLabelReason(value: unknown): boolean {
  const v = String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
  return v.includes("shippingservice") || v.includes("shippinglabel") || v.includes("buyshipping") || v.includes("postage");
}

function extractLabelCost(events: any, orderId: string, allowUnscopedAdjustments = false): { amount: number; currency: string; raw?: unknown } | null {
  const candidates: Array<{ amount: number; currency: string; raw: unknown }> = [];
  const addAmount = (rawAmount: unknown, currency: unknown, raw: unknown) => {
    const value = Math.abs(Number(rawAmount ?? 0));
    if (Number.isFinite(value) && value > 0) candidates.push({ amount: value, currency: String(currency || "USD"), raw });
  };
  const maybeAddFee = (fee: any, context: any) => {
    const feeType = fee?.FeeType || fee?.ChargeType || fee?.Type || "";
    const label = `${feeType} ${context?.FeeReason || ""} ${context?.FeeDescription || ""}`;
    if (!isLabelReason(label)) return;
    if (/shippingchargeback/i.test(String(feeType))) return;
    const amount = fee?.FeeAmount || fee?.ChargeAmount || fee?.Amount || {};
    addAmount(amount.CurrencyAmount, amount.CurrencyCode, context);
  };

  for (const event of events?.ServiceFeeEventList ?? []) {
    if (event?.AmazonOrderId && event.AmazonOrderId !== orderId) continue;
    const eventIsLabel = isLabelReason(event?.FeeReason);
    for (const fee of event?.FeeList ?? event?.FeeComponentList ?? event?.ChargeComponentList ?? []) {
      if (eventIsLabel) {
        const amount = fee?.FeeAmount || fee?.ChargeAmount || fee?.Amount || {};
        addAmount(amount.CurrencyAmount, amount.CurrencyCode, event);
      } else {
        maybeAddFee(fee, event);
      }
    }
  }
  for (const event of events?.ShipmentEventList ?? []) {
    if (event?.AmazonOrderId && event.AmazonOrderId !== orderId) continue;
    for (const item of event?.ShipmentItemList ?? []) {
      for (const charge of item?.ItemChargeList ?? []) {
        const chargeType = String(charge?.ChargeType || "");
        const amount = Number(charge?.ChargeAmount?.CurrencyAmount ?? 0);
        if (chargeType === "ShippingCharge" && amount < 0) {
          addAmount(amount, charge?.ChargeAmount?.CurrencyCode, item);
        }
      }
      for (const fee of item?.ItemFeeList ?? []) maybeAddFee(fee, item);
    }
  }
  for (const event of events?.AdjustmentEventList ?? []) {
    if (event?.AmazonOrderId && event.AmazonOrderId !== orderId) continue;
    if (!event?.AmazonOrderId && !allowUnscopedAdjustments) continue;
    const adjustmentType = event?.AdjustmentType || event?.Reason || event?.Description || "";
    if (!isLabelReason(adjustmentType)) continue;
    const eventAmount = event?.TotalAmount || event?.AdjustmentAmount || event?.Amount || {};
    addAmount(eventAmount.CurrencyAmount, eventAmount.CurrencyCode, event);
    for (const item of event?.AdjustmentItemList ?? []) {
      const amount = item?.TotalAmount || item?.AdjustmentAmount || item?.Amount || {};
      addAmount(amount.CurrencyAmount, amount.CurrencyCode, item);
    }
  }
  if (candidates.length === 0) return null;
  const currency = candidates[0]?.currency || "USD";
  const amount = candidates.reduce((sum, item) => sum + item.amount, 0);
  return { amount: Math.round(amount * 100) / 100, currency, raw: candidates[0]?.raw };
}

async function tryFinancesByOrder(orderId: string, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`;
  try {
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      console.log(`[label-cost] finances-by-order ${res.status}: ${text.slice(0, 200)}`);
      trace?.push({ stage: "finances_by_order", ok: false, status: res.status, reason: text.slice(0, 500) });
      return null;
    }
    const data = JSON.parse(text);
    const events = data?.payload?.FinancialEvents ?? data?.payload ?? {};
    const r = extractLabelCost(events, orderId, true);
    trace?.push({
      stage: "finances_by_order",
      ok: Boolean(r),
      status: res.status,
      event_counts: countFinancialEvents(events),
      resolved_amount: r?.amount,
      reason: r ? undefined : "No Buy Shipping/Postage label fee event found",
      raw: data,
    });
    return r ? { ...r, source: "amazon_finances" } : null;
  } catch (err) {
    console.log(`[label-cost] finances-by-order error: ${(err as Error).message}`);
    trace?.push({ stage: "finances_by_order", ok: false, reason: (err as Error).message });
    return null;
  }
}

async function tryFinancesByRange(orderId: string, orderDate: string | null, accessToken: string, trace?: TraceStage[]): Promise<Resolved | null> {
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
    const headers = await signSpApiRequest("GET", url, accessToken);
    const res = await fetch(url, { headers: { ...headers, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      console.log(`[label-cost] finances-range ${res.status}: ${text.slice(0, 200)}`);
      trace?.push({ stage: "finances_range", ok: false, status: res.status, reason: text.slice(0, 500) });
      return null;
    }
    const data = JSON.parse(text);
    const events = data?.payload?.FinancialEvents ?? {};
    const r = extractLabelCost(events, orderId, false);
    trace?.push({
      stage: "finances_range",
      ok: Boolean(r),
      status: res.status,
      event_counts: countFinancialEvents(events),
      resolved_amount: r?.amount,
      reason: r ? undefined : `No label fee found on page ${page + 1}`,
      raw: data,
    });
    if (r) return { ...r, source: "amazon_finances" };
    nextToken = data?.payload?.NextToken ?? null;
    if (!nextToken) break;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: uErr } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const salesOrderId: string = String(body.sales_order_id || "").trim();
    const orderId: string = String(body.order_id || "").trim();
    const manualAmount = body.manual_amount != null ? Number(body.manual_amount) : null;
    const force = body.force === true;
    const debug = body.debug === true || body.trace === true;
    if (!salesOrderId && !orderId) {
      return new Response(JSON.stringify({ error: "sales_order_id or order_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (manualAmount != null && (!Number.isFinite(manualAmount) || manualAmount < 0 || manualAmount > 1000)) {
      return new Response(JSON.stringify({ error: "manual_amount must be 0..1000" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let orderQuery = supabase
      .from("sales_orders")
      .select("id, order_id, asin, quantity, fulfillment_channel, marketplace, user_id, sold_price, estimated_price, total_sale_amount, order_date, shipping_label_fee, shipping_label_fee_source, shipping_label_fee_poll_attempts")
      .eq("user_id", user.id);
    orderQuery = salesOrderId ? orderQuery.eq("id", salesOrderId) : orderQuery.eq("order_id", orderId);
    const { data: order, error: oErr } = await orderQuery.maybeSingle();
    if (oErr || !order) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (order.fulfillment_channel && order.fulfillment_channel !== "MFN") {
      return new Response(JSON.stringify({ error: "Not an FBM order" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Never overwrite manual entries silently.
    if (!force && order.shipping_label_fee_source === "manual" && manualAmount == null) {
      return new Response(JSON.stringify({
        success: true, found: true, source: "manual",
        amount: Number(order.shipping_label_fee || 0),
        note: "Manual entry already saved; pass force=true to overwrite.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const amazonOrderId = String(order.order_id || orderId).trim();

    // 1) Manual path
    if (manualAmount != null) {
      const { error } = await supabase
        .from("sales_orders")
        .update({
          shipping_label_fee: manualAmount,
          shipping_label_fee_source: "manual",
          shipping_label_fee_synced_at: new Date().toISOString(),
        })
        .eq("id", order.id);
      if (error) throw error;
      return new Response(JSON.stringify({
        success: true, found: true, source: "manual", amount: manualAmount,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Resolve seller refresh token. Starts NULL: the operator's token used to
    // be the starting value, so an account with no authorisation of its own
    // quietly billed its label costs against the operator's Amazon account.
    let refreshToken: string | null = null;
    const marketplaceId = MARKETPLACE_IDS[String(order.marketplace || "US").toUpperCase()] || MARKETPLACE_IDS.US;
    const { data: authRows } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, marketplace_id, is_active")
      .eq("user_id", user.id)
      .eq("is_active", true);
    const userAuth = (authRows ?? []).find((row: any) => row.marketplace_id === marketplaceId) || (authRows ?? [])[0];
    if (userAuth?.refresh_token) refreshToken = userAuth.refresh_token;

    if (!refreshToken) {
      const credDecision = await mayActOnOperatorCredentials(supabase, {
        actingUserId: user.id,
        fn: "sync-fbm-label-cost",
      });
      if (credDecision.allowed) refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN") || null;
    }

    if (!refreshToken) {
      return new Response(JSON.stringify({
        success: false, found: false,
        reason: "No Amazon seller authorization found — please enter the cost manually.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let resolved: Resolved | null = null;
    const trace: TraceStage[] = [];
    try {
      const accessToken = await getAccessToken(refreshToken);
      // 2) PRIMARY: Merchant Fulfillment (Buy Shipping rate)
      resolved = await tryMerchantFulfillment(amazonOrderId, accessToken, debug ? trace : undefined);
      // 3) Fallback: Finances by order
      if (!resolved) resolved = await tryFinancesByOrder(amazonOrderId, accessToken, debug ? trace : undefined);
      // 4) Fallback: Finances date-range scan
      if (!resolved) resolved = await tryFinancesByRange(amazonOrderId, order.order_date, accessToken, debug ? trace : undefined);
    } catch (err) {
      console.error(`[label-cost] Amazon path failed: ${(err as Error).message}`);
      if (debug) trace.push({ stage: "merchant_fulfillment", ok: false, reason: `Amazon path failed: ${(err as Error).message}` });
    }

    if (!resolved) {
      // Bump poll attempts so the background poller can back off appropriately.
      await supabase.from("sales_orders").update({
        shipping_label_fee_poll_attempts: (order.shipping_label_fee_poll_attempts ?? 0) + 1,
        shipping_label_fee_last_polled_at: new Date().toISOString(),
      }).eq("id", order.id);
      return new Response(JSON.stringify({
        success: false, found: false,
        reason: "Amazon has not posted the label fee yet. We'll keep checking in the background — try again later or enter it manually.",
        ...(debug ? { order_id: amazonOrderId, trace } : {}),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { error: upErr } = await supabase
      .from("sales_orders")
      .update({
        shipping_label_fee: resolved.amount,
        shipping_label_fee_source: resolved.source,
        shipping_label_fee_synced_at: new Date().toISOString(),
        shipping_label_fee_last_polled_at: new Date().toISOString(),
      })
      .eq("id", order.id);
    if (upErr) throw upErr;

    return new Response(JSON.stringify({
      success: true, found: true, source: resolved.source,
      amount: resolved.amount, currency: resolved.currency,
      ...(debug ? { order_id: amazonOrderId, trace } : {}),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[sync-fbm-label-cost] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
