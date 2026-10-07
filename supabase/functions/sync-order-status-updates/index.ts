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
import { withCronLock } from "../_shared/cron-lock.ts";
import { needsWrite, statusPatch } from "./status-patch.ts";

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

    /**
     * Wrapped in the cron lock so it has a run history at all.
     *
     * cron job 170 has run hourly since it was created and cron_run_history
     * held NOT ONE row for it, so "is the status sync working" could only be
     * answered by inference from the orders themselves. An hourly job with no
     * record of its own runs is a job nobody can tell has stopped.
     *
     * 300s TTL: a run walks up to 20 pages of Amazon orders and now reads each
     * row before writing, so it is slower than it was, but nowhere near an
     * hour. The lock also stops two runs overlapping if one is slow -- they
     * would fight over the same rows.
     */
    const lockOutcome = await withCronLock(supabase as any, "sync-order-status-updates-hourly", 300, async () => {
    let totalSeen = 0, totalUpdated = 0;

    for (const auth of (auths ?? []) as any[]) {
      let token: string;
      try {
        token = await getLWAAccessToken(auth.refresh_token);
      } catch (e) {
        results.push({ user_id: auth.user_id, error: `lwa: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }

      const rawEndpoint = getSpApiEndpoint(auth.marketplace_id);
      const base = rawEndpoint.startsWith("http") ? rawEndpoint.replace(/\/+$/, "") : `https://${rawEndpoint}`;
      const after = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
      const before = new Date(Date.now() - SAFETY_LAG_MINUTES * 60_000).toISOString();

      let nextToken: string | null = null;
      let pages = 0, seen = 0, updated = 0, unchanged = 0, notFound = 0;

      do {
        const url = new URL(`${base}/orders/v0/orders`);
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

          // Read first, then decide. The old guard was `.neq("order_status",
          // status)` in the UPDATE itself, which skipped the one case this
          // worker most needed to fix: order_status already Canceled while
          // is_cancelled was still false. 321 orders sat in exactly that state
          // carrying $7,671.08 of estimated revenue, skipped forever PRECISELY
          // because the status had not changed. needsWrite() asks about both
          // columns, so a no-op is still a no-op and that row is not.
          const { data: current } = await supabase
            .from("sales_orders")
            .select("order_status, is_cancelled")
            .eq("user_id", auth.user_id)
            .eq("order_id", id)
            .maybeSingle();

          if (!current) { notFound++; continue; }
          if (!needsWrite(current, status)) { unchanged++; continue; }

          const { data: hit, error: uErr } = await supabase
            .from("sales_orders")
            .update(statusPatch(status, new Date().toISOString()))
            .eq("user_id", auth.user_id)
            .eq("order_id", id)
            .select("order_id");
          if (uErr) { console.warn(`[order-status] ${id}:`, uErr.message); continue; }
          if ((hit?.length ?? 0) > 0) {
            updated++;
            // Every status change, logged. There was no record of what this
            // worker did to which order, so a wrong move left no trail.
            console.log(`[order-status] ${id}: ${current.order_status ?? "unknown"} -> ${status}` +
              (statusPatch(status, "").is_cancelled !== Boolean(current.is_cancelled)
                ? ` (is_cancelled ${Boolean(current.is_cancelled)} -> ${statusPatch(status, "").is_cancelled})` : ""));
          } else { unchanged++; }
        }
      } while (nextToken && pages < MAX_PAGES);

      // notFound is now counted for real: the loop reads the row before
      // deciding, so "Amazon knows this order and we do not" is no longer
      // indistinguishable from "already correct".
      totalSeen += seen; totalUpdated += updated;
      results.push({
        user_id: auth.user_id, marketplace: auth.marketplace_id,
        pages, ordersSeen: seen, statusUpdated: updated, alreadyCorrect: unchanged, notFound,
        truncated: pages >= MAX_PAGES,
      });
    }

      return { items_processed: totalUpdated, detail: { ordersSeen: totalSeen, dryRun, lookbackHours, results } };
    });

    return json({ dryRun, lookbackHours, lock: lockOutcome, results });
  } catch (err) {
    console.error("[sync-order-status-updates]", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
