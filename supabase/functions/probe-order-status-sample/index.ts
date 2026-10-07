/**
 * Ask Amazon what it says about specific order ids. Read-only, always.
 *
 * ── WHY A SEPARATE FUNCTION ───────────────────────────────────────────────
 *
 * 449 orders older than three months still carry a price estimate and have
 * never settled -- $11,702.14 of estimated revenue that Live Sales counts and
 * the P&L cannot see. Deciding what to do about them starts with one question:
 * what does Amazon say about each one NOW?
 *
 * Nothing existing can answer it:
 *   * sync-order-status-updates queries by LastUpdatedAfter, so an order
 *     Amazon has not touched in months is invisible to it however often it
 *     runs. That is structural, not a failure.
 *   * refresh-order-status CAN fetch a single order id, but it writes -- and
 *     on a cancelled order it zeroes quantity, sold price and every fee. That
 *     is not something to do to 449 rows before anyone has seen the shape of
 *     the data. It now has a dryRun flag, but it is browser-facing and
 *     requires a user JWT, which a migration cannot mint.
 *
 * So this exists: internal-only, no user session, and it has no write path at
 * all. Not "a write guarded by a flag" -- there is no table write in this file,
 * which is a property you can check by reading it rather than a promise.
 *
 * Delete it once the stuck-pending investigation is closed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getLWAAccessToken, getSpApiEndpoint } from "../_shared/sp-api-sigv4.ts";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Amazon's getOrder is 0.5 requests/second with a burst of 30. 250ms keeps us
// under that with room to spare -- this is a diagnostic, not a race.
const PACE_MS = 250;
const MAX_IDS = 60;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const orderIds: string[] = Array.isArray(body?.order_ids) ? body.order_ids.slice(0, MAX_IDS) : [];
    const userEmail: string = String(body?.user_email || "");
    if (!orderIds.length) return json({ error: "order_ids required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: userRow } = await supabase
      .from("profiles").select("id").eq("email", userEmail).maybeSingle();
    let userId: string | null = (userRow as any)?.id ?? null;
    if (!userId) {
      // profiles may not carry the email; fall back to the single active auth.
      const { data: anyAuth } = await supabase
        .from("seller_authorizations").select("user_id").eq("is_active", true).limit(1).maybeSingle();
      userId = (anyAuth as any)?.user_id ?? null;
    }
    if (!userId) return json({ error: "could not resolve a user" }, 400);

    const { data: auths } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, marketplace_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .not("refresh_token", "is", null);
    const auth = (auths ?? [])[0] as any;
    if (!auth?.refresh_token) return json({ error: "no active seller authorization" }, 400);

    const token = await getLWAAccessToken(auth.refresh_token);
    const rawEndpoint = getSpApiEndpoint(auth.marketplace_id);
    const base = rawEndpoint.startsWith("http") ? rawEndpoint.replace(/\/+$/, "") : `https://${rawEndpoint}`;

    const rows: Array<Record<string, unknown>> = [];
    const tally: Record<string, number> = {};

    for (let i = 0; i < orderIds.length; i++) {
      const oid = String(orderIds[i]).replace(/-REFUND(-\d+)?$/, "");
      try {
        const res = await fetch(`${base}/orders/v0/orders/${encodeURIComponent(oid)}`, {
          headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
        });
        if (!res.ok) {
          // 404 is itself an answer -- "Amazon has no such order" is one of the
          // buckets this investigation is trying to size.
          const key = `http_${res.status}`;
          tally[key] = (tally[key] ?? 0) + 1;
          rows.push({ order_id: oid, amazon_status: null, http: res.status });
        } else {
          const payload = await res.json();
          const o = payload?.payload ?? {};
          const status = o?.OrderStatus ?? null;
          tally[String(status)] = (tally[String(status)] ?? 0) + 1;
          rows.push({
            order_id: oid,
            amazon_status: status,
            last_update: o?.LastUpdateDate ?? null,
            purchase_date: o?.PurchaseDate ?? null,
            order_total: o?.OrderTotal?.Amount ?? null,
            currency: o?.OrderTotal?.CurrencyCode ?? null,
            marketplace_id: o?.MarketplaceId ?? null,
            // Amazon's own word on whether anything shipped, which separates
            // "cancelled before despatch" from "shipped and settled".
            items_shipped: o?.NumberOfItemsShipped ?? null,
            items_unshipped: o?.NumberOfItemsUnshipped ?? null,
          });
        }
      } catch (e) {
        tally.error = (tally.error ?? 0) + 1;
        rows.push({ order_id: oid, amazon_status: null, error: e instanceof Error ? e.message : String(e) });
      }
      if (i < orderIds.length - 1) await new Promise(r => setTimeout(r, PACE_MS));
    }

    return json({ readOnly: true, requested: orderIds.length, tally, rows });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
