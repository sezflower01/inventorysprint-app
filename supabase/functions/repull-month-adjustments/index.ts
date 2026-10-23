// One-month ADJUSTMENT re-pull. Fetch first, validate, then replace atomically.
//
// WHY THIS EXISTS RATHER THAN REUSING fetch-profit-loss. Re-pulling an old
// month through the normal sync requires emptying it first, because
// isMonthCached only returns false when the month has ZERO rows -- deleting
// just the adjustments leaves shipments and service fees behind and the month
// is still skipped, and deleting the service fees instead trips the
// `old_shipments_only_service_fees_will_never_land` branch and is also treated
// as cached. So the normal path means every month spends minutes completely
// empty while an HTTP call it cannot supervise refills it. That call stalled
// three times in one session and left January blank for several minutes.
//
// It also went wrong in a second way: an inclusive DELETE against an exclusive
// re-fetch destroyed 41 shipment and refund rows dated 2026-10-23 and $836.99
// of sales, because a bare endDate is read as midnight.
//
// This function removes both hazards. It never touches shipments, refunds or
// service fees at all, and the delete and insert happen inside one plpgsql
// transaction (repull_month_adjustments_apply), so there is no window where the
// month has no adjustments. If the fetch fails, times out, or comes back
// shorter than what is already stored, it writes NOTHING.
//
// Classification comes from fetch-profit-loss/adjustment-router.ts -- the same
// module the live sync uses. A second copy would agree on the day it was
// written and drift after, producing backfilled months that cannot be compared
// with synced ones.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { routeAdjustment } from '../fetch-profit-loss/adjustment-router.ts';
import { adjustmentProvenance } from '../fetch-profit-loss/adjustment-provenance.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

const MONEY_COLUMNS = [
  'sales','refunds','shipping_credits','shipping_credit_refunds','gift_wrap_credits',
  'gift_wrap_credit_refunds','promotional_rebates','promotional_rebate_refunds','other_income',
  'reimbursements','liquidations','referral_fees','fba_fees','variable_closing_fees',
  'fixed_closing_fees','fba_inbound_fees','fba_storage_fees','fba_removal_fees','fba_disposal_fees',
  'fba_long_term_storage_fees','other_fees','sales_tax_collected','marketplace_facilitator_tax',
  'sales_tax_refunds','marketplace_facilitator_tax_refunds','fba_customer_return_fees',
  'compensated_clawback','hrr_non_apparel','digital_services_fee','warehouse_lost','warehouse_damage',
  'reversal_reimbursement','free_replacement_refund_items','fba_inbound_convenience_fee',
  'liquidations_brokerage_fee','re_commerce_grading_charge','shipping_chargeback',
  'shipping_chargeback_refund','restocking_fee','fbm_shipping_label_fee',
] as const;

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('LWA_CLIENT_ID')!,
      client_secret: Deno.env.get('LWA_CLIENT_SECRET')!,
    }),
  });
  if (!res.ok) throw new Error(`LWA token failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

/** Fixed FX, matching fetch-profit-loss. Adjustments are USD in practice. */
const FALLBACK_RATES: Record<string, number> = {
  USD: 1, CAD: 0.73, MXN: 0.058, BRL: 0.18, GBP: 1.27, EUR: 1.08,
};
const toUsd = (amt: number, cur: string) => amt * (FALLBACK_RATES[cur] || 1);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = req.headers.get('authorization') || '';
  const internal = req.headers.get('x-internal-secret') || '';
  if (!(auth.includes(SERVICE_ROLE) || (INTERNAL_SECRET && internal === INTERNAL_SECRET))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const started = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const userId: string = body.user_id;
    const month: string = body.month;                 // 'YYYY-MM-01'
    // DEFAULTS TO A DRY RUN. Writing has to be asked for explicitly: this
    // replaces a month of financial rows, and the safe default for that is to
    // do nothing and describe what would happen.
    const apply: boolean = body.apply === true;
    if (!userId || !/^\d{4}-\d{2}-01$/.test(month || '')) {
      throw new Error("user_id and month ('YYYY-MM-01') required");
    }

    const monthStart = new Date(`${month}T00:00:00Z`);
    const nextMonth = new Date(Date.UTC(
      monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 0, 0, 0));
    // Amazon rejects a PostedBefore in the future, so cap at now-5min. This is
    // the SAME boundary the SQL side uses: [monthStart, nextMonth).
    const nowCap = new Date(Date.now() - 5 * 60 * 1000);
    const postedBefore = nextMonth > nowCap ? nowCap : nextMonth;
    if (postedBefore <= monthStart) throw new Error('window is empty: month is in the future');

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // What is stored now, for the short-fetch guard and the dry-run report.
    const { data: storedRows, error: storedErr } = await supa
      .from('financial_events_cache')
      .select('compensated_clawback, reimbursements, warehouse_lost, warehouse_damage, reversal_reimbursement, free_replacement_refund_items, liquidations, fbm_shipping_label_fee')
      .eq('user_id', userId)
      // 'adjustment' ONLY. Liquidation rows are mostly produced by
      // RemovalShipmentEventList, which this function does not fetch, so
      // counting them made the guard compare apples to oranges -- and deleting
      // them would have destroyed 62 January rows it could never replace.
      // Liquidations are out of scope.
      .eq('event_type', 'adjustment')
      .gte('event_date', month)
      .lt('event_date', nextMonth.toISOString().split('T')[0]);
    if (storedErr) throw new Error(`stored read failed: ${storedErr.message}`);
    const storedCount = storedRows?.length ?? 0;
    const storedSigned = (storedRows ?? []).reduce((s: number, r: any) =>
      s + Object.values(r).reduce((a: number, v: any) => a + (Number(v) || 0), 0), 0);
    const storedClawback = (storedRows ?? []).reduce((s: number, r: any) =>
      s + (Number(r.compensated_clawback) || 0), 0);

    const { data: authRows } = await supa
      .from('seller_authorizations').select('refresh_token, marketplace_id').eq('user_id', userId);
    const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (!authData?.refresh_token) throw new Error('no seller authorization');
    const accessToken = await getLWAAccessToken(authData.refresh_token);

    // ---- FETCH EVERYTHING FIRST. No DB writes happen below this line until
    // the fetch has completed cleanly and passed the guards. ----
    const items: any[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    const MAX_PAGES = 400;
    let rateLimitHits = 0;

    do {
      if (Date.now() - started > 100_000) {
        throw new Error(`TIMEOUT after ${pages} pages -- aborting WITHOUT writing`);
      }
      const params = new URLSearchParams({ MaxResultsPerPage: '100' });
      if (nextToken) {
        params.set('NextToken', nextToken);
      } else {
        params.set('PostedAfter', monthStart.toISOString());
        params.set('PostedBefore', postedBefore.toISOString());
      }
      const res = await fetch(
        `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params}`,
        { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } },
      );
      if (res.status === 429) {
        rateLimitHits++;
        if (rateLimitHits > 25) throw new Error('too many rate limits -- aborting WITHOUT writing');
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      if (!res.ok) {
        throw new Error(`finances ${res.status}: ${(await res.text()).slice(0, 250)} -- aborting WITHOUT writing`);
      }
      const json = await res.json();
      const ev = json.payload?.FinancialEvents;
      for (const event of ev?.AdjustmentEventList || []) {
        for (const item of event.AdjustmentItemList || []) items.push({ event, item });
      }
      nextToken = json.payload?.NextToken || null;
      pages++;
      if (nextToken) await new Promise((r) => setTimeout(r, 250));
    } while (nextToken && pages < MAX_PAGES);

    if (nextToken) throw new Error(`paging incomplete at ${MAX_PAGES} pages -- aborting WITHOUT writing`);

    // ---- Build rows with the SHARED router, then dedupe by upsert key. ----
    // Deduping here is mandatory, not tidiness: Postgres refuses an
    // ON CONFLICT DO UPDATE that would touch the same row twice in one
    // statement, so same-key items must be summed before they are sent.
    const byKey = new Map<string, any>();
    let apiSigned = 0, apiClawback = 0, routedNull = 0, skippedLiquidation = 0;
    let evtIdx = 0;
    let lastEvent: any = null;
    let itemIdx = 0;

    for (const { event, item } of items) {
      if (event !== lastEvent) { evtIdx++; itemIdx = 0; lastEvent = event; }
      itemIdx++;

      const eventDate = (event.PostedDate || '').split('T')[0]
        || monthStart.toISOString().split('T')[0];
      const amount = toUsd(
        parseFloat(item.TotalAmount?.CurrencyAmount ?? '0'),
        item.TotalAmount?.CurrencyCode || 'USD',
      );
      apiSigned += amount;

      const route = routeAdjustment(event.AdjustmentType, amount);
      if (!route) { routedNull++; continue; }
      // A LIQUIDATION-typed adjustment would be written as event_type
      // 'liquidation'. Out of scope: this function does not delete liquidation
      // rows, so writing them would make them accumulate on every re-run.
      if (route.eventType !== 'adjustment') { skippedLiquidation++; continue; }
      if (route.column === 'compensated_clawback') apiClawback += route.value;

      const asin = item.ASIN || '';
      const orderId = event.AmazonOrderId && event.AmazonOrderId.length > 0
        ? `${event.AmazonOrderId}#${itemIdx}`
        : (route.postage
            ? `POSTAGE-${eventDate}-${evtIdx}#${itemIdx}`
            : `ADJ-${eventDate}-${evtIdx}#${itemIdx}`);

      const key = `${route.eventType}|${eventDate}|${orderId}|${asin}`;
      let row = byKey.get(key);
      if (!row) {
        row = { event_type: route.eventType, event_date: eventDate,
                amazon_order_id: orderId, asin, marketplace: 'UNKNOWN', marketplace_id: null };
        for (const c of MONEY_COLUMNS) row[c] = 0;
        Object.assign(row, adjustmentProvenance(event, item));
        byKey.set(key, row);
      }
      row[route.column] = (Number(row[route.column]) || 0) + route.value;
    }

    const rows = [...byKey.values()];

    const report = {
      month, apply,
      window: { posted_after: monthStart.toISOString(), posted_before: postedBefore.toISOString() },
      pages, rate_limit_hits: rateLimitHits,
      api_items: items.length,
      api_rows_after_dedupe: rows.length,
      api_items_routed_to_nothing: routedNull,
      api_items_skipped_liquidation: skippedLiquidation,
      api_signed_total: Math.round(apiSigned * 100) / 100,
      api_clawback_total: Math.round(apiClawback * 100) / 100,
      stored_rows: storedCount,
      stored_signed_total: Math.round(storedSigned * 100) / 100,
      stored_clawback_total: Math.round(storedClawback * 100) / 100,
      elapsed_ms: Date.now() - started,
    };

    // GUARD: a fetch that produced fewer rows than are stored is treated as
    // short, not as a correction. Checked here AND again inside the SQL
    // function, because this is the one mistake that would delete real data.
    if (rows.length < storedCount) {
      return new Response(JSON.stringify({
        ...report, wrote: false,
        aborted: `REFUSED: ${rows.length} fetched rows < ${storedCount} stored -- fetch looks short, nothing written`,
      }, null, 2), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!apply) {
      return new Response(JSON.stringify({ ...report, wrote: false, dry_run: true }, null, 2),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: applied, error: applyErr } = await supa.rpc('repull_month_adjustments_apply', {
      p_user: userId, p_month: month, p_rows: rows, p_min_rows: storedCount,
    });
    if (applyErr) throw new Error(`apply failed (nothing committed): ${applyErr.message}`);

    return new Response(JSON.stringify({ ...report, wrote: true, applied }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({
      error: e?.message || String(e), wrote: false, elapsed_ms: Date.now() - started,
    }, null, 2), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
