import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { exchangeLwaToken } from '../_shared/lwa-token.ts';
import { getSpApiEndpoint, signRequest } from '../_shared/sp-api-sigv4.ts';
import { waitForApiToken } from '../_shared/rate-limiter.ts';
import { mergeOrderItemsByAsin } from '../_shared/order-items.ts';

// Repair sales_orders rows whose quantity or revenue was lost to the
// same-ASIN collapse.
//
// THE BUG (fixed forward in d51b6d5). sales_orders is unique on
// (user_id, order_id, asin) with no order-item column, so two OrderItems for
// one ASIN cannot both be stored. The Orders API writers looped items and
// upserted per item, so both landed on one row and the last won -- replacing
// quantity and revenue instead of adding to them.
//
// WHY THIS RUNS AGAINST AMAZON AND NOT AGAINST A HEURISTIC. The obvious
// detection is fba_fee / median_per_unit_fee, and it is not good enough: on
// this account 1,722 rows exceed 1.6x that ratio but only 444 land near a whole
// number, and the rest is ordinary FBA fee variance -- size-tier changes, fee
// schedule updates, peak surcharges. Rewriting financial records on that
// estimate would corrupt more rows than it fixed. GetOrderItems is the only
// thing that actually knows, so every repair here is checked against it.
//
// TWO FAILURE CLASSES, measured 2026-09-09, and they move profit in OPPOSITE
// directions:
//   A. revenue understated -- 7 rows. Revenue kept one item, fees cover N.
//      referral_fee runs 30-75% of recorded revenue. Understates profit.
//      This is the one the seller noticed.
//   B. quantity understated only -- 437 rows, 997 real units recorded as 437.
//      Revenue already holds the full line total, referral sits near a normal
//      15%, but total_cost = unit_cost x 1. OVERSTATES profit by ~5,581.78,
//      and shows nothing wrong on screen. The larger and quieter problem.
//
// DRY RUN IS THE DEFAULT. Pass dry_run: false deliberately. Anything that
// rewrites booked financial history should have to be asked for twice.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const MARKETPLACE_ID_MAP: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// Amazon's Orders API allows about 0.5 requests/second with a burst of 30.
//
// This started at 250ms -- 4/s, eight times over -- which worked for the first
// batch because a full burst bucket absorbed it, and then collapsed: batch 2
// made 60 calls in 19.4 seconds and returned 51 unverifiable out of 60. Those
// were not missing orders. Every one of the 348 rows still on the shortlist is
// inside the two-year retention window; they were throttled, and a 429 reads
// exactly like an order that cannot be found.
//
// That matters beyond this function. The Orders API quota is account-wide and
// shared with sync-sales-orders, so a sweep that overruns it degrades the sales
// sync for everything else running at the time. Slow is the correct setting.
// 2100ms, and an experiment on 2026-10-31 says leave it there.
//
// Ten dry-run passes over 285 candidates produced 172 throttles against 448
// checks. The shape is the interesting part: the first three invocations (~150
// calls) were CLEAN -- 0 throttles -- and then throttling set in and stayed.
//
// The obvious reading was that 2100ms (0.476 calls/s) sits too close to
// getOrderItems' nominal 0.5/s once sync-sales-orders and fetch-live-orders
// take their share, so this was raised to 3200ms (0.31/s). THAT DID NOT WORK:
// the very next pass at 3200ms still throttled 23 of 32. Slowing down by a
// third changed nothing, which rules out our own call RATE as the binding
// constraint and points at a longer-window quota that the first 150 calls
// exhausted. A burst bucket that refills slowly behaves exactly like this.
//
// So the delay is back at 2100ms: 3200ms bought no fewer throttles and cost a
// third of the coverage per invocation (110s/3.2s is ~34 orders against ~52).
// The honest conclusion is that a large sweep has to be spread over TIME, not
// slowed down within one invocation -- and the design already handles that,
// because a throttled row is deliberately not recorded and returns on the next
// run. Do not raise this again on the reasoning above; it has been tried.
const PER_CALL_DELAY_MS = 2100;
// And wait for a token rather than giving up and firing anyway -- an 8s cap
// meant the gate silently stopped gating under exactly the load it exists for.
const TOKEN_WAIT_MS = 20_000;
// Leave headroom before the platform kills the worker mid-write.
const TIME_BUDGET_MS = 110_000;

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const money = (v: number): number => Math.round(v * 100) / 100;

// Set by fetchOrderItems so the caller can separate "throttled, try later" from
// "Amazon has no record of this order". Module-level rather than threaded
// through a return type because each invocation handles one batch serially.
let lastFetchStatus = 0;

async function fetchOrderItems(
  accessToken: string,
  orderId: string,
  marketplaceId: string,
  supabase: any,
): Promise<any[] | null> {
  const endpoint = getSpApiEndpoint(marketplaceId);
  const url = `${endpoint}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`;
  await waitForApiToken(supabase, 'order_items_api', { maxWaitMs: TOKEN_WAIT_MS });
  const headers = await signRequest('GET', url, '', accessToken);
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) {
    // Distinguish these in the counts. A 404 is an order Amazon no longer
    // retains and will never be repairable; a 429 is this sweep going too fast
    // and IS repairable on a later pass. Folding both into "unverifiable" is
    // what made 51 throttled rows look like 51 missing orders.
    lastFetchStatus = res.status;
    console.warn(`[repair] ${orderId}: ${res.status} ${text.slice(0, 160)}`);
    return null;
  }
  lastFetchStatus = 200;
  try {
    return mergeOrderItemsByAsin(JSON.parse(text)?.payload?.OrderItems || []);
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const started = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const userId = body.user_id as string;
    // null = every marketplace. Defaulting to US was what hid the BR and MX
    // rows behind an "unverifiable" count instead of repairing them.
    const marketplace = (body.marketplace ?? null) as string | null;
    const dryRun = body.dry_run !== false; // default true
    // QUANTITY_ONLY (added 2026-11-01, operator-requested). Writes the
    // quantity-related columns -- quantity and total_cost -- and leaves
    // revenue alone even where GetOrderItems disagrees with it.
    //
    // Why anyone would want that: on the 2026-11-01 examination the revenue
    // corrections moved in BOTH directions (24.47 -> 22.97 as well as
    // 15.56 -> 77.80), so some are price restatements rather than collapse
    // damage, and the operator chose not to accept them wholesale.
    //
    // The cost of it, stated so it is not discovered later: a row written this
    // way is internally INCONSISTENT -- 10 units at a revenue figure for 2 --
    // so per-order ROI screens will show a loss where they previously showed a
    // profit. COGS and the P&L are unaffected, because get_monthly_cogs reads
    // quantity and the P&L takes revenue from financial_events_cache, not from
    // here. Default false, so nothing changes for other callers.
    const quantityOnly = body.quantity_only === true;
    const limit = Math.min(Number(body.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const orderIds: string[] | null = Array.isArray(body.order_ids) && body.order_ids.length
      ? body.order_ids.map(String)
      : null;

    if (!userId) {
      return new Response(JSON.stringify({ ok: false, error: 'user_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Candidates. With explicit order_ids this checks exactly those; otherwise
    // it uses the fee-ratio shortlist purely to decide WHICH orders are worth
    // an SP-API call. The heuristic never decides the new values -- Amazon does.
    let candidates: any[] = [];
    if (orderIds) {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, marketplace, quantity, sold_price, total_sale_amount, unit_cost, total_cost, referral_fee, fba_fee, total_fees, order_date')
        .eq('user_id', userId)
        .in('order_id', orderIds);
      if (error) throw error;
      candidates = data || [];
    } else {
      const { data, error } = await supabase.rpc('collapsed_order_candidates', {
        p_user_id: userId,
        p_limit: limit,
        // null means every marketplace; the per-row marketplace decides how
        // each call is signed.
        p_marketplace: body.marketplace ?? null,
        // Already-correct rows never leave the shortlist, so a sweep has to
        // page past them or it re-checks the same head forever.
        p_offset: Number(body.offset) || 0,
      });
      if (error) throw error;
      candidates = data || [];
    }

    if (candidates.length === 0) {
      return new Response(JSON.stringify({ ok: true, dry_run: dryRun, checked: 0, repaired: 0, rows: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: authRows } = await supabase
      .from('seller_authorizations')
      .select('seller_id, marketplace_id, refresh_token')
      .eq('user_id', userId);
    if (!authRows?.length) {
      return new Response(JSON.stringify({ ok: false, error: 'no_seller_auth' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve the token PER MARKETPLACE. The first version signed every call
    // with one marketplace, so 6 of the first 12 candidates -- all BR and MX --
    // came back unverifiable rather than repaired. The shortlist now carries
    // each row's own marketplace and each call is signed for it.
    //
    // Tokens are cached by refresh_token, not by marketplace: several
    // marketplaces usually share one authorization, and exchanging the same
    // refresh token four times per batch is wasted round-trips against a rate
    // limit that is already the tight resource here.
    const tokenCache = new Map<string, string>();
    async function authFor(mp: string): Promise<{ token: string; marketplaceId: string } | null> {
      const mpId = MARKETPLACE_ID_MAP[mp] || MARKETPLACE_ID_MAP.US;
      const auth = (authRows || []).find((a: any) => a.marketplace_id === mpId)
        || (authRows || [])[0];
      if (!auth?.refresh_token) return null;
      let token = tokenCache.get(auth.refresh_token);
      if (!token) {
        token = await exchangeLwaToken(auth.refresh_token, supabase, userId);
        tokenCache.set(auth.refresh_token, token);
      }
      return { token, marketplaceId: mpId };
    }

    let checked = 0, repaired = 0, unverifiable = 0, alreadyCorrect = 0, fxSkipped = 0, throttled = 0;
    // Rows where GetOrderItems reported MORE units than the money signal's
    // upper bound -- skipped and recorded, never written. See the ceiling gate.
    let exceedsEstimate = 0;

    // Final verdicts, written to collapsed_order_checks so the shortlist stops
    // offering the same rows. Without this the sweep re-verified the same 50
    // cleared rows every run: 23 runs, 1,149 SP-API calls, 0 repairs. Only
    // verdicts that cannot change are recorded -- a 429, any other transient
    // failure, or missing seller auth leaves the row eligible for a later run.
    const checks: Array<{ sales_order_id: string; user_id: string; outcome: string }> = [];
    const recordVerdict = (salesOrderId: string, outcome: string) => {
      if (!dryRun) checks.push({ sales_order_id: salesOrderId, user_id: userId, outcome });
    };
    const rows: any[] = [];

    for (const row of candidates.slice(0, limit)) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        console.log('[repair] time budget reached, stopping cleanly');
        break;
      }
      checked++;

      const rowMp = String(row.marketplace || marketplace || 'US').toUpperCase();
      const auth = await authFor(rowMp);
      if (!auth) { unverifiable++; continue; }

      const items = await fetchOrderItems(auth.token, row.order_id, auth.marketplaceId, supabase);
      await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
      if (!items || items.length === 0) {
        if (lastFetchStatus === 429) {
          throttled++;
        } else {
          unverifiable++;
          // Only a 404 is final -- Amazon has no such order and never will.
          // A 5xx, a parse failure or an empty 200 could be transient, so those
          // rows stay eligible rather than being dropped from the sweep for good.
          if (lastFetchStatus === 404) recordVerdict(row.id, 'not_found');
        }
        continue;
      }

      const match = items.find((i: any) => String(i?.ASIN || '') === String(row.asin));
      if (!match) { unverifiable++; recordVerdict(row.id, 'asin_not_in_order'); continue; }

      const trueQty = num(match.QuantityOrdered) || 1;

      // ── CEILING GATE (added 2026-11-01) ──────────────────────────────
      //
      // The shortlist's implied_units comes from Amazon's posted money divided
      // by our stored unit price, and it is a proven UPPER BOUND: on the rows
      // validated 2026-10-31 it ran about 16 pct high, because the collapse
      // overwrote sold_price as well as quantity, so the denominator is too
      // small. Amazon confirming FEWER units than the money implies is the
      // normal, expected case and is not suspicious.
      //
      // Amazon confirming MORE units than the money implies is NOT expected,
      // and it is the direction that matters: it would mean the money-based
      // shortlist and GetOrderItems disagree in a way the known bias cannot
      // explain, so something else is wrong with the row. Those are skipped and
      // recorded rather than written, so one odd row cannot inflate COGS.
      //
      // ⚠️ CORRECTION, 2026-11-01. The paragraph above calls the money figure
      // an upper bound, and that is only HALF true. All 8 rows this gate
      // skipped were examined against GetOrderItems afterwards and every one
      // was a genuine under-ingest, with Amazon reporting substantially more
      // (stored 1 -> 6, 1 -> 8, 1 -> 9, 2 -> 7, 2 -> 10, 3 -> 6, 1 -> 3,
      // 2 -> 4). So the gate produced 8 false skips and 0 true catches.
      //
      // The reason: money / sold_price over-states when sold_price was
      // collapsed, but UNDER-states when Amazon has only posted PART of the
      // order's money -- an order still settling has less money against it
      // than units shipped. The two biases run in opposite directions, so the
      // figure is an estimate with no guaranteed side, not a bound.
      //
      // The gate is kept anyway, and deliberately: its job is to refuse to
      // write a value it cannot explain, and "refuse and record" was the right
      // behaviour even though the explanation turned out to be benign. The
      // follow-up is a human-ordered GetOrderItems pass on the skips, which is
      // exactly what resolved these 8. Do NOT remove the gate on the strength
      // of this note; remove the claim that the money figure bounds anything.
      //
      // A tiny tolerance absorbs rounding in the division.
      const moneyImplied = num(row.implied_units);
      if (moneyImplied > 0 && trueQty > moneyImplied + 0.01) {
        exceedsEstimate++;
        recordVerdict(row.id, 'exceeds_money_estimate');
        rows.push({
          order_id: row.order_id,
          asin: row.asin,
          mp: rowMp,
          order_date: row.order_date,
          skipped: 'amazon_exceeds_money_estimate',
          stored_quantity: num(row.quantity),
          amazon_quantity: trueQty,
          money_implied: moneyImplied,
        });
        continue;
      }
      const truePrincipal = money(num(match.ItemPrice?.Amount));
      const itemCurrency = String(match.ItemPrice?.CurrencyCode || '').toUpperCase();
      const storedQty = num(row.quantity) || 0;
      const storedRevenue = money(num(row.total_sale_amount));

      const qtyWrong = trueQty !== storedQty;

      // CURRENCY GATE. sales_orders stores revenue converted to USD; Amazon
      // returns ItemPrice in the marketplace's own currency. Without this check
      // a Brazilian order looks like a fivefold revenue increase and the repair
      // writes raw BRL into a USD column.
      //
      // Caught by the first dry run, which proposed:
      //   701-6134054-0537846  49.07 -> 253.83   ratio 5.17
      //   701-6915416-8205042  27.31 -> 141.86   ratio 5.19
      //   702-7153485-3165817  27.15 -> 140.46   ratio 5.17
      //   701-3589045-1309846  21.38 -> 110.65   ratio 5.18
      // all with NO quantity change -- a consistent BRL/USD rate, not a
      // collapse. Overwriting on that would have inflated the P&L by five
      // times on every non-USD order it touched.
      //
      // Non-USD orders are skipped for revenue rather than converted: this
      // function has no FX table, and the sale needs the rate that applied on
      // its own order date, not today's. The QUANTITY correction is
      // currency-free and still applies, which is the class B repair and the
      // larger of the two anyway.
      const revenueComparable = itemCurrency === 'USD' || itemCurrency === '';
      const revenueWrong = revenueComparable
        && truePrincipal > 0
        && Math.abs(truePrincipal - storedRevenue) >= 0.02;
      const revenueSkippedForFx = !revenueComparable
        && truePrincipal > 0
        && Math.abs(truePrincipal - storedRevenue) >= 0.02;

      if (revenueSkippedForFx) fxSkipped++;
      if (!qtyWrong && !revenueWrong) {
        alreadyCorrect++;
        recordVerdict(row.id, 'already_correct');
        continue;
      }

      const unitCost = num(row.unit_cost);
      const patch: Record<string, unknown> = {};
      if (qtyWrong) {
        patch.quantity = trueQty;
        // COGS follows quantity. This is the class B correction and the one
        // that moves profit DOWN, so it must not be skipped just because
        // revenue already looked right.
        if (unitCost > 0) patch.total_cost = money(unitCost * trueQty);
      }
      if (revenueWrong && !quantityOnly) {
        patch.total_sale_amount = truePrincipal;
        patch.item_price = truePrincipal;
        patch.sold_price = money(truePrincipal / Math.max(trueQty, 1));
      }

      // With quantityOnly set, a row whose ONLY fault is revenue produces an
      // empty patch. Writing an empty object would be a no-op UPDATE that still
      // recorded a 'repaired' verdict -- which would drop the row from the
      // shortlist for good while having fixed nothing. Skip it instead and
      // record nothing, so it stays eligible.
      if (Object.keys(patch).length === 0) {
        rows.push({
          order_id: row.order_id,
          asin: row.asin,
          mp: rowMp,
          order_date: row.order_date,
          skipped: 'revenue_only_and_quantity_only_mode',
          stored_quantity: storedQty,
          amazon_quantity: trueQty,
        });
        continue;
      }

      rows.push({
        order_id: row.order_id,
        asin: row.asin,
        mp: rowMp,
        order_date: row.order_date,
        quantity: qtyWrong ? { from: storedQty, to: trueQty } : undefined,
        revenue: revenueWrong ? { from: storedRevenue, to: truePrincipal } : undefined,
        total_cost: patch.total_cost !== undefined
          ? { from: money(num(row.total_cost)), to: patch.total_cost }
          : undefined,
        merged_item_ids: match.__mergedItemIds || undefined,
        revenue_skipped_non_usd: revenueSkippedForFx ? itemCurrency : undefined,
      });

      if (!dryRun) {
        const { error: updErr } = await supabase
          .from('sales_orders')
          .update(patch)
          .eq('id', row.id);
        if (updErr) {
          // Not recorded: a failed write is exactly the row that must be tried
          // again, not settled.
          console.warn(`[repair] update failed ${row.order_id}: ${updErr.message}`);
          continue;
        }
      }
      recordVerdict(row.id, 'repaired');
      repaired++;
    }

    // Persist every verdict in one write, before the summary. The loop exits
    // cleanly at its time budget, so this always runs on a normal return. A
    // worker killed mid-loop loses only this run's verdicts, and those rows are
    // simply checked again next run -- the safe direction to fail in.
    let checksRecorded = 0;
    if (checks.length > 0) {
      const { error: chkErr } = await supabase
        .from('collapsed_order_checks')
        .upsert(checks, { onConflict: 'sales_order_id' });
      if (chkErr) {
        console.warn(`[repair] could not record ${checks.length} verdicts: ${chkErr.message}`);
      } else {
        checksRecorded = checks.length;
      }
    }

    const summary = {
      ok: true,
      checks_recorded: checksRecorded,
      dry_run: dryRun,
      quantity_only: quantityOnly,
      checked,
      would_repair: dryRun ? repaired : undefined,
      repaired: dryRun ? 0 : repaired,
      already_correct: alreadyCorrect,
      unverifiable,
      throttled,
      exceeds_money_estimate: exceedsEstimate,
      revenue_skipped_non_usd: fxSkipped,
      elapsed_ms: Date.now() - started,
      // Was slice(0, 40). That silently truncated the per-order detail while
      // the COUNTS stayed complete, so a dry run of 50 reported would_repair:
      // 50 alongside 40 rows -- and anything computing a total from `rows`
      // understated it with no indication. On 2026-10-31 six dry-run batches
      // reported would_repair 217 against 189 rows, making a COGS prediction
      // of 3,411.13 that was short by 28 orders' worth.
      //
      // A cap is still right for a browser-facing response, but it has to be
      // above MAX_LIMIT (200) so a full-size invocation can never be cut off.
      // If a caller ever needs more than this, the honest fix is smaller
      // batches, not a bigger window.
      rows: rows.slice(0, 250),
      rows_total: rows.length,
      rows_truncated: rows.length > 250,
    };
    console.log(`[repair] ${JSON.stringify({ ...summary, rows: rows.length })}`);
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[repair] error:', e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
