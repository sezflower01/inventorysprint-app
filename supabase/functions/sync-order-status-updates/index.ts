/**
 * Refresh order_status on orders whose status changed AFTER we first saw them.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────────
 *
 * fetch-live-orders queries Amazon with `CreatedAfter` — orders CREATED in a
 * window. An order created in December is fetched once, while Pending, and
 * written as Pending. When Amazon later ships it, nothing ever asks about that
 * order again, because it was not *created* in any later window. Its status
 * stays Pending forever.
 *
 * Measured: 19,724 orders stuck at Pending since 2025-12-28, 448 of them
 * already settled. They are not stuck because something failed — they are
 * stuck because nothing looks at them a second time.
 *
 * Amazon provides `LastUpdatedAfter` for exactly this: it returns orders whose
 * status CHANGED in a window, regardless of when they were created. That is a
 * different question from "what is new", so this is a separate worker rather
 * than a flag on the existing one.
 *
 * ── UPDATES ONLY, NEVER INSERTS ───────────────────────────────────────────
 *
 * This writes order_status and nothing else, and only to rows that already
 * exist. Creating orders is fetch-live-orders' job, with all its enrichment,
 * pricing and fee logic. An order arriving here that we have never seen is
 * counted and skipped — it means the creation path missed it, which is a
 * separate problem (see the ~1,300 orders absent from sales_orders) and not
 * one to paper over by inserting a bare status row.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getLWAAccessToken, getSpApiEndpoint } from "../_shared/sp-api-sigv4.ts";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Amazon rejects LastUpdatedAfter within ~2 minutes of now.
const SAFETY_LAG_MINUTES = 5;
const DEFAULT_LOOKBACK_HOURS = 26;   // one day plus overlap, so a missed run self-heals
const MAX_PAGES = 20;                 // bounds a wide backfill window

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const lookbackHours = Math.min(Math.max(Number(body?.lookbackHours) || DEFAULT_LOOKBACK_HOURS, 1), 24 * 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: auths, error: aErr } = await supabase
      .from("seller_authorizations")
      .select("user_id, refresh_token, marketplace_id")
      .not("refresh_token", "is", null)
      .eq("is_active", true);
    if (aErr) return json({ error: aErr.message }, 500);

    const results: Array<Record<string, unknown>> = [];

    for (const auth of (auths ?? []) as any[]) {
      let token: string;
      try {
        token = await getLWAAccessToken(auth.refresh_token);
      } catch (e) {
        results.push({ user_id: auth.user_id, error: `lwa: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }

      const endpoint = getSpApiEndpoint(auth.marketplace_id);
      const after = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
      const before = new Date(Date.now() - SAFETY_LAG_MINUTES * 60_000).toISOString();

      let nextToken: string | null = null;
      let pages = 0, seen = 0, updated = 0, unchanged = 0, notFound = 0;

      do {
        const url = new URL(`https://${endpoint}/orders/v0/orders`);
        if (nextToken) {
          url.searchParams.set("NextToken", nextToken);
        } else {
          // The whole point of this worker. CreatedAfter would return the same
          // orders fetch-live-orders already has; LastUpdatedAfter returns the
          // ones whose status MOVED since.
          url.searchParams.set("LastUpdatedAfter", after);
          url.searchParams.set("LastUpdatedBefore", before);
        }
        url.searchParams.set("MarketplaceIds", auth.marketplace_id);

        const res = await fetch(url.toString(), {
          headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
        });
        if (!res.ok) {
          results.push({ user_id: auth.user_id, error: `orders api ${res.status}`, page: pages });
          break;
        }
        const payload = await res.json();
        const orders = payload?.payload?.Orders ?? [];
        nextToken = payload?.payload?.NextToken ?? null;
        pages++;

        for (const o of orders) {
          const id = o?.AmazonOrderId;
          const status = o?.OrderStatus;
          if (!id || !status) continue;
          seen++;
          if (dryRun) continue;

          // Only rows that already exist, and only when the status actually
          // differs — a no-op UPDATE would still bump updated_at and, on a
          // published table, fan out a realtime event for no change.
          const { data: hit, error: uErr } = await supabase
            .from("sales_orders")
            .update({ order_status: status })
            .eq("user_id", auth.user_id)
            .eq("order_id", id)
            .neq("order_status", status)
            .select("order_id");
          if (uErr) { console.warn(`[order-status] ${id}:`, uErr.message); continue; }
          if ((hit?.length ?? 0) > 0) updated++; else unchanged++;
        }
      } while (nextToken && pages < MAX_PAGES);

      // notFound is inferred rather than queried: an order Amazon reports as
      // updated that matched no row is either already correct or absent
      // entirely, and separating those costs a query per order for a number
      // nothing acts on.
      results.push({
        user_id: auth.user_id, marketplace: auth.marketplace_id,
        pages, ordersSeen: seen, statusUpdated: updated, alreadyCorrect: unchanged, notFound,
        truncated: pages >= MAX_PAGES,
      });
    }

    return json({ dryRun, lookbackHours, results });
  } catch (err) {
    console.error("[sync-order-status-updates]", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
