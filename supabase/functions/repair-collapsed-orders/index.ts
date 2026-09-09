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
const PER_CALL_DELAY_MS = 250;
// Leave headroom before the platform kills the worker mid-write.
const TIME_BUDGET_MS = 110_000;

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const money = (v: number): number => Math.round(v * 100) / 100;

async function fetchOrderItems(
  accessToken: string,
  orderId: string,
  marketplaceId: string,
  supabase: any,
): Promise<any[] | null> {
  const endpoint = getSpApiEndpoint(marketplaceId);
  const url = `${endpoint}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`;
  await waitForApiToken(supabase, 'order_items_api', { maxWaitMs: 8000 });
  const headers = await signRequest('GET', url, '', accessToken);
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) {
    // 404 is normal for an order outside Amazon's retention window; it is not
    // a failure of this repair, just an order that can no longer be verified.
    console.warn(`[repair] ${orderId}: ${res.status} ${text.slice(0, 160)}`);
    return null;
  }
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
    const marketplace = (body.marketplace || 'US') as string;
    const dryRun = body.dry_run !== false; // default true
    const limit = Math.min(Number(body.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const orderIds: string[] | null = Array.isArray(body.order_ids) && body.order_ids.length
      ? body.order_ids.map(String)
      : null;

    if (!userId) {
      return new Response(JSON.stringify({ ok: false, error: 'user_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const marketplaceId = MARKETPLACE_ID_MAP[marketplace] || MARKETPLACE_ID_MAP.US;

    // Candidates. With explicit order_ids this checks exactly those; otherwise
    // it uses the fee-ratio shortlist purely to decide WHICH orders are worth
    // an SP-API call. The heuristic never decides the new values -- Amazon does.
    let candidates: any[] = [];
    if (orderIds) {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, quantity, sold_price, total_sale_amount, unit_cost, total_cost, referral_fee, fba_fee, total_fees, order_date')
        .eq('user_id', userId)
        .in('order_id', orderIds);
      if (error) throw error;
      candidates = data || [];
    } else {
      const { data, error } = await supabase.rpc('collapsed_order_candidates', {
        p_user_id: userId,
        p_limit: limit,
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
    const sellerAuth = (authRows || []).find((a: any) => a.marketplace_id === marketplaceId)
      || (authRows || [])[0];
    if (!sellerAuth?.refresh_token) {
      return new Response(JSON.stringify({ ok: false, error: 'no_seller_auth' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const accessToken = await exchangeLwaToken(sellerAuth.refresh_token, supabase, userId);

    let checked = 0, repaired = 0, unverifiable = 0, alreadyCorrect = 0, fxSkipped = 0;
    const rows: any[] = [];

    for (const row of candidates.slice(0, limit)) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        console.log('[repair] time budget reached, stopping cleanly');
        break;
      }
      checked++;

      const items = await fetchOrderItems(accessToken, row.order_id, marketplaceId, supabase);
      await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
      if (!items || items.length === 0) { unverifiable++; continue; }

      const match = items.find((i: any) => String(i?.ASIN || '') === String(row.asin));
      if (!match) { unverifiable++; continue; }

      const trueQty = num(match.QuantityOrdered) || 1;
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
      if (!qtyWrong && !revenueWrong) { alreadyCorrect++; continue; }

      const unitCost = num(row.unit_cost);
      const patch: Record<string, unknown> = {};
      if (qtyWrong) {
        patch.quantity = trueQty;
        // COGS follows quantity. This is the class B correction and the one
        // that moves profit DOWN, so it must not be skipped just because
        // revenue already looked right.
        if (unitCost > 0) patch.total_cost = money(unitCost * trueQty);
      }
      if (revenueWrong) {
        patch.total_sale_amount = truePrincipal;
        patch.item_price = truePrincipal;
        patch.sold_price = money(truePrincipal / Math.max(trueQty, 1));
      }

      rows.push({
        order_id: row.order_id,
        asin: row.asin,
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
          console.warn(`[repair] update failed ${row.order_id}: ${updErr.message}`);
          continue;
        }
      }
      repaired++;
    }

    const summary = {
      ok: true,
      dry_run: dryRun,
      checked,
      would_repair: dryRun ? repaired : undefined,
      repaired: dryRun ? 0 : repaired,
      already_correct: alreadyCorrect,
      unverifiable,
      revenue_skipped_non_usd: fxSkipped,
      elapsed_ms: Date.now() - started,
      rows: rows.slice(0, 40),
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
