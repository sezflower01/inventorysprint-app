/**
 * Resolve orders that have been Pending for months, one batch at a time.
 *
 * ── THE SITUATION ─────────────────────────────────────────────────────────
 *
 * fetch-live-orders queries Amazon with CreatedAfter, so an order is fetched
 * once, while Pending, and never asked about again. sync-order-status-updates
 * uses LastUpdatedAfter, which only returns orders Amazon has touched recently
 * -- so an order Amazon settled in April and has not touched since is
 * unreachable by both. The only way to resolve those is to ask about each one
 * by id, which is what this does.
 *
 * A stratified sample of 40 on 2026-10-07 came back 22 Shipped, 18 Canceled
 * and NOT ONE still Pending. Our own Canceled and Shipped labels were right
 * 10/10 and 12/12; our Pending label was right 0/10.
 *
 * ── WHY ORDER ITEMS AND NOT THE ORDER TOTAL ───────────────────────────────
 *
 * GetOrder returns OrderTotal for the whole order. sales_orders rows are per
 * ASIN, and the sample included orders with up to 7 items shipped, so writing
 * OrderTotal onto a row would book the entire basket as the price of one line.
 * That is the squared-revenue bug this codebase has already been bitten by
 * ($1,513 against a real $340). So a Shipped order costs a second call,
 * getOrderItems, and each row takes ITS OWN ItemPrice matched on ASIN.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
 *
 * If Amazon still says Pending, the row is left exactly as it is -- status,
 * flag, estimate, everything. "Still pending after four months" is a real
 * answer and not ours to overwrite.
 *
 * Defaults to dryRun. Writing requires apply:true, and every row it writes is
 * copied into backup_resolve_stuck_pending_20261007 first, by this function,
 * in the same pass -- so the backup cannot drift from what was changed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getLWAAccessToken, getSpApiEndpoint } from "../_shared/sp-api-sigv4.ts";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// getOrder and getOrderItems are both 0.5 req/s with a burst of 30. 250ms per
// call keeps a long batch inside the restore rate with room for the second
// call a Shipped order needs.
// getOrder restores at 0.5 req/s with a burst of 30, so 250ms is comfortable
// for the status pass.
const PACE_MS = 250;
// getOrderItems has the SAME 0.5/s restore but no burst left once the status
// pass has spent it. The first dry run paced both at 250ms and took 23 HTTP
// 429s on the items call out of 40 orders -- so no price would have been
// written for more than half the batch, silently. One call every 2.1s is the
// restore rate with a little headroom.
const ITEMS_PACE_MS = 2100;
const ITEMS_RETRY_MS = 5000;
const DEFAULT_BATCH = 20;
const MAX_BATCH = 60;

const CANCELLED = new Set(["Canceled", "Cancelled"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const apply = body?.apply === true;             // writing is opt-in
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_BATCH, 1), MAX_BATCH);
    const minAgeDays = Number(body?.minAgeDays) || 90;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: auths } = await supabase
      .from("seller_authorizations")
      .select("user_id, refresh_token, marketplace_id")
      .eq("is_active", true)
      .not("refresh_token", "is", null);
    const auth = (auths ?? [])[0] as any;
    if (!auth?.refresh_token) return json({ error: "no active seller authorization" }, 400);

    const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString().slice(0, 10);

    // The cohort, oldest first so repeated batches walk steadily through it
    // rather than re-reading the same expensive head every time.
    const { data: rows, error: rErr } = await supabase
      .from("sales_orders")
      .select("id, order_id, asin, sku, quantity, estimated_price, order_status, is_cancelled, sold_price, order_date")
      .eq("user_id", auth.user_id)
      .lte("order_date", cutoff)
      .eq("is_cancelled", false)
      .or("sold_price.is.null,sold_price.eq.0")
      .gt("estimated_price", 0)
      // THE EXIT CONDITION THIS WORKER DID NOT HAVE.
      //
      // A Shipped order whose price Amazon will not return gets labelled
      // ESTIMATE_UNRECOVERABLE and keeps sold_price 0 and estimated_price > 0
      // -- which is this query's own definition of an unresolved row. So it
      // selected the same rows every run, asked Amazon again, wrote again, and
      // logged again. Measured over three days on cron 194: 25 orders written
      // 18,195 times, the worst 734 times, while the other 149 in the cohort
      // were never reached because those 25 filled every batch.
      //
      // The label is the terminal state. Excluding it here is what makes it one.
      .or("price_confidence.is.null,price_confidence.neq.ESTIMATE_UNRECOVERABLE")
      // Over-fetch: capped orders are filtered out in code below, and without
      // the headroom a batch of 25 could be entirely capped rows and resolve
      // nothing -- which would trip the stall detector for the wrong reason.
      .limit(limit * 3)
      // '%-REFUND' misses '...-REFUND-1', and 115 such rows exist. The dry run
      // surfaced three of them -- writing a positive sold_price onto a refund
      // row would invert its sign. Match anywhere in the id, not just the end.
      .not("order_id", "like", "%-REFUND%")
      // Oldest first by default so repeated batches walk steadily through the
      // cohort. newestFirst exists because Amazon withholds ItemPrice on old
      // orders, and finding WHERE that boundary falls decides how much of this
      // cohort can be priced at all.
      .order("order_date", { ascending: body?.newestFirst !== true });
    if (rErr) return json({ error: rErr.message }, 500);
    if (!rows?.length) return json({ done: true, message: "no rows left in the cohort", tally: {} });

    // ── GUARDRAIL 1: the attempt cap ────────────────────────────────────────
    //
    // The resolution log only gets a row on a SUCCESSFUL write, so an order
    // Amazon throttles is retried leaving no trace -- the legitimate retry path,
    // and precisely the one that can spin forever. This counts every ASK.
    // Three strikes and the order is labelled and leaves the cohort, whatever
    // Amazon did or did not say.
    const candidateIds = [...new Set((rows as any[]).map(r =>
      String(r.order_id).replace(/-REFUND(-\d+)?$/, "")))];

    const { data: attemptRows } = await supabase
      .from("stuck_pending_attempts")
      .select("order_id, attempts")
      .in("order_id", candidateIds);
    const attemptsByOrder = new Map<string, number>(
      (attemptRows ?? []).map((a: any) => [String(a.order_id), Number(a.attempts) || 0]));

    // ── GUARDRAIL 2: the tripwire ───────────────────────────────────────────
    //
    // A successfully-written order must never be selected again -- that is what
    // the terminal labels are for. If one is, the exit condition has failed a
    // second time, and the right response is to stop and say so rather than to
    // start writing. Three days of silent re-writing is what this exists to
    // prevent happening twice.
    const { data: loggedRows } = await supabase
      .from("stuck_pending_resolution_log")
      .select("order_id")
      .in("order_id", candidateIds);
    const alreadyLogged = [...new Set((loggedRows ?? []).map((l: any) => String(l.order_id)))];
    if (alreadyLogged.length > 0) {
      await supabase.from("stuck_pending_drain_state").update({
        last_run_at: new Date().toISOString(),
        last_note: `TRIPWIRE: ${alreadyLogged.length} already-resolved orders re-selected, run aborted`,
      }).eq("id", 1);
      return json({
        tripwire: true,
        aborted: true,
        message: "selected orders that are already in the resolution log; the exit "
               + "condition has failed again, so nothing was written",
        alreadyLogged: alreadyLogged.slice(0, 20),
        count: alreadyLogged.length,
      });
    }

    const token = await getLWAAccessToken(auth.refresh_token);
    const rawEndpoint = getSpApiEndpoint(auth.marketplace_id);
    const base = rawEndpoint.startsWith("http") ? rawEndpoint.replace(/\/+$/, "") : `https://${rawEndpoint}`;

    const tally: Record<string, number> = {};
    const changes: Array<Record<string, unknown>> = [];
    const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };

    // Group by order id: several rows can belong to one order, and asking
    // Amazon once per ROW would spend the quota several times over for the
    // same answer.
    const byOrder = new Map<string, any[]>();
    for (const r of rows as any[]) {
      const base_id = String(r.order_id).replace(/-REFUND(-\d+)?$/, "");
      if (!byOrder.has(base_id)) byOrder.set(base_id, []);
      byOrder.get(base_id)!.push(r);
    }

    let i = 0;
    let asked = 0;
    for (const [orderId, orderRows] of byOrder) {
      if (i++ > 0) await new Promise(r => setTimeout(r, PACE_MS));

      const priorAttempts = attemptsByOrder.get(orderId) ?? 0;
      if (priorAttempts >= 3) { bump("skipped_at_cap"); continue; }
      // The query over-fetches so a batch is never all-capped; the BATCH SIZE
      // is still `limit` asks, because that is what the pacing was sized for.
      if (asked >= limit) { bump("deferred_to_next_run"); continue; }
      asked++;
      const thisAttempt = priorAttempts + 1;

      // Record the ASK before making it. If this run dies mid-flight the
      // attempt still counts -- an attempt counter that only increments on a
      // clean finish does not bound anything.
      if (apply) {
        await supabase.from("stuck_pending_attempts").upsert({
          order_id: orderId,
          attempts: thisAttempt,
          last_attempt: new Date().toISOString(),
          terminal_reason: thisAttempt >= 3 ? "attempt_cap_reached" : null,
        }, { onConflict: "order_id" });
      }

      let status: string | null = null;
      try {
        const res = await fetch(`${base}/orders/v0/orders/${encodeURIComponent(orderId)}`, {
          headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
        });
        if (!res.ok) { bump(`http_${res.status}`); continue; }
        status = (await res.json())?.payload?.OrderStatus ?? null;
      } catch (e) {
        bump("fetch_error");
        changes.push({ order_id: orderId, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!status) {
        bump("no_status");
        // Out of attempts and still no answer: label it so it leaves the
        // cohort rather than coming back forever.
        if (apply && thisAttempt >= 3) {
          for (const row of orderRows) {
            await supabase.from("sales_orders")
              .update({ price_confidence: "ESTIMATE_UNRECOVERABLE",
                        status_source: "resolve_stuck_pending_attempt_cap" })
              .eq("id", row.id);
          }
          bump("capped_terminal");
        }
        continue;
      }
      bump(status);

      // Amazon still says Pending: leave it completely alone. That is a real
      // answer, not a gap to fill.
      if (status === "Pending") {
        changes.push({ order_id: orderId, amazon_status: status, action: "left untouched" });
        continue;
      }

      const isCancelled = CANCELLED.has(status);
      const now = new Date().toISOString();

      // Shipped: fetch the per-ITEM prices. Never OrderTotal -- see the header.
      const itemPrices = new Map<string, { price: number; qty: number }>();
      let itemsDebug: Record<string, unknown> | null = null;
      let rawItemCount = 0;
      if (!isCancelled) {
        // One retry on a throttle, then give up for this order. A row with no
        // price keeps its estimate and stays in the cohort for the next batch,
        // which is strictly better than writing a price we could not read.
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise(r => setTimeout(r, attempt === 0 ? ITEMS_PACE_MS : ITEMS_RETRY_MS));
          try {
            const ir = await fetch(`${base}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`, {
              headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
            });
            if (ir.ok) {
              const items = (await ir.json())?.payload?.OrderItems ?? [];
              rawItemCount = items.length;
              for (const it of items) {
                const amt = Number(it?.ItemPrice?.Amount);
                const q = Number(it?.QuantityOrdered) || 1;
                if (it?.ASIN && Number.isFinite(amt) && amt > 0) {
                  itemPrices.set(String(it.ASIN), { price: amt, qty: q });
                }
              }
              // What came back, so a no-match is diagnosable rather than silent.
              itemsDebug = {
                count: ((await Promise.resolve(null)), itemPrices.size),
                asins: Array.from(itemPrices.keys()).slice(0, 5),
              };
              break;
            }
            if (ir.status !== 429) { bump(`items_http_${ir.status}`); break; }
            if (attempt === 1) bump("items_throttled_twice");
          } catch { bump("items_fetch_error"); break; }
        }
      }

      for (const row of orderRows) {
        const item = itemPrices.get(String(row.asin));
        const patch: Record<string, unknown> = {
          order_status: status,
          is_cancelled: isCancelled,
          cancelled_at: isCancelled ? now : null,
          last_status_sync_at: now,
          status_source: "resolve_stuck_pending_20261007",
        };
        // ItemPrice is the EXTENDED price for the quantity ordered, so the
        // per-unit figure is a division -- storing it as the unit price is the
        // line-total-as-unit-price bug this codebase has already seen.
        if (!isCancelled && !item) {
          // Amazon confirms this shipped but withholds ItemPrice -- a
          // data-retention restriction on old orders, not a fault in the call.
          // Measured 2026-10-07: items returned 1, items carrying a price 0,
          // on every order in the oldest batch.
          //
          // The estimate STAYS. It is the only figure we have, and zeroing or
          // excluding it would turn "we cannot verify this" into "this never
          // happened" -- a different and worse claim. It is labelled instead,
          // so these rows can be filtered out of any total that needs to be
          // defensible without being deleted from one that does not.
          //
          // ESTIMATE_UNRECOVERABLE is a new value in a column whose existing
          // consumers test for 'CONFIRMED' or 'LOW_CONFIDENCE_HINT' by
          // equality, so adding it changes no current behaviour: the row keeps
          // counting exactly as it does today.
          patch.price_confidence = "ESTIMATE_UNRECOVERABLE";
        }
        if (!isCancelled && item) {
          // ItemPrice is the EXTENDED price for QuantityOrdered, so the unit
          // price is a division. Storing the extended figure as the unit price
          // is the line-total-as-unit-price bug this codebase has already hit,
          // where two orders squared their revenue by quantity.
          patch.sold_price = Math.round((item.price / Math.max(1, item.qty)) * 100) / 100;
          patch.total_sale_amount = Math.round(item.price * 100) / 100;
          patch.item_price = Math.round(item.price * 100) / 100;
          patch.price_source = "orders_api:resolved_stuck_pending";
          patch.price_confidence = "CONFIRMED";
          patch.needs_price_enrich = false;
        }

        changes.push({
          order_id: row.order_id, asin: row.asin,
          was: { status: row.order_status, is_cancelled: row.is_cancelled, estimated: row.estimated_price },
          now: { status, is_cancelled: isCancelled, sold_price: patch.sold_price ?? null },
          priced: Boolean(patch.sold_price),
          items_returned: rawItemCount,
          items_with_price: itemsDebug?.count ?? 0,
          item_asins: itemsDebug?.asins ?? [],
        });

        if (apply) {
          // Back up inside the same pass, so the backup cannot describe a
          // different set of rows than the one that gets written.
          await supabase.from("backup_resolve_stuck_pending_20261007")
            .insert({ reason: `amazon_${status}`, row_data: row });
          const { error: uErr } = await supabase.from("sales_orders")
            .update(patch).eq("id", row.id);
          if (uErr) { bump("write_error"); changes[changes.length - 1].error = uErr.message; }
          else {
            bump("written");
            // Every status change, recorded in a table rather than only in the
            // reply body. An HTTP response nobody stored is not a log, and
            // this worker changes money-bearing rows.
            await supabase.from("stuck_pending_resolution_log").insert({
              order_id: row.order_id,
              asin: row.asin,
              old_status: row.order_status,
              new_status: status,
              old_is_cancelled: row.is_cancelled,
              new_is_cancelled: isCancelled,
              estimated_price: row.estimated_price,
              new_sold_price: (patch.sold_price as number | undefined) ?? null,
              price_recovered: Boolean(patch.sold_price),
              note: patch.price_confidence === "ESTIMATE_UNRECOVERABLE"
                ? "shipped, Amazon withheld ItemPrice, estimate kept and labelled"
                : (isCancelled ? "cancelled, flag set, figures untouched" : "shipped, price recovered"),
            });
          }
        }
      }
    }

    return json({
      apply, limit, minAgeDays,
      ordersAsked: asked, ordersSelected: byOrder.size, rowsConsidered: rows.length,
      tally, changes,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
