// READ-ONLY PROBE. Returns Amazon's raw AdjustmentEventList for a date range.
//
// WHY THIS EXISTS. financial_events_cache.raw_event is NULL on all 122,737 rows
// -- createCacheEntry never set it -- so AdjustmentType, SellerSKU, Quantity,
// the posted time and crucially the SIGN of the amount were all discarded at
// ingest. fetch-profit-loss applies Math.abs() to REVERSAL_REIMBURSEMENT, and
// the P&L RPCs then ABS() it again and add it to income. Whether that is right
// cannot be answered from stored data, only from the live payload.
//
// It matters because the stake is large and the evidence conflicts. The column
// holds 781 rows and +$12,764.37 all-time; flipping the sign is a $25,528.74
// swing. But InventorySprint already agrees with InventoryLab to 0.20% on 2026
// Amazon-only US-only net ($449,288.50 vs $448,406.42), so a blanket flip would
// move us ~$4,468 BELOW InventoryLab and turn a 0.20% match into about 1.0% the
// other way. Reasoning alone cannot settle it. The raw AdjustmentType and sign
// can.
//
// THIS FUNCTION WRITES NOTHING. No insert, no update, no upsert, anywhere. It
// reads seller_authorizations to get a refresh token and otherwise only calls
// Amazon and returns what came back. Keep it that way: the moment it writes, it
// stops being safe to run against production to answer a question.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) throw new Error(`LWA token failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = req.headers.get('authorization') || '';
  const internal = req.headers.get('x-internal-secret') || '';
  if (!(auth.includes(SERVICE_ROLE) || (INTERNAL_SECRET && internal === INTERNAL_SECRET))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const userId: string = body.user_id;
    const postedAfter: string = body.posted_after || '2026-10-18T00:00:00Z';
    const postedBefore: string = body.posted_before || '2026-10-22T00:00:00Z';
    if (!userId) throw new Error('user_id required');

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: authRows } = await supa
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', userId);
    const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (!authData?.refresh_token) throw new Error('no seller authorization');

    const accessToken = await getLWAAccessToken(authData.refresh_token);

    // Page through the window collecting ONLY AdjustmentEventList.
    const adjustments: any[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    const otherEventCounts: Record<string, number> = {};

    do {
      pages++;
      const params = new URLSearchParams({ MaxResultsPerPage: '100' });
      if (nextToken) {
        params.set('NextToken', nextToken);
      } else {
        params.set('PostedAfter', postedAfter);
        params.set('PostedBefore', postedBefore);
      }
      const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params.toString()}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2500));
        pages--;
        continue;
      }
      if (!res.ok) throw new Error(`finances ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const ev = json.payload?.FinancialEvents;
      for (const [k, v] of Object.entries(ev || {})) {
        if (Array.isArray(v) && v.length) otherEventCounts[k] = (otherEventCounts[k] || 0) + v.length;
      }
      adjustments.push(...(ev?.AdjustmentEventList || []));
      nextToken = json.payload?.NextToken || null;
      if (nextToken) await new Promise((r) => setTimeout(r, 300));
    } while (nextToken && pages < 250);

    // Flatten to exactly what the question needs: type, SKU, qty, posted
    // timestamp and the SIGN as Amazon sent it -- before any abs().
    const flat = adjustments.flatMap((event: any, ei: number) =>
      (event.AdjustmentItemList || []).map((item: any, ii: number) => ({
        event_index: ei,
        item_index: ii,
        adjustment_type: event.AdjustmentType ?? null,
        posted_date: event.PostedDate ?? null,
        amazon_order_id: event.AmazonOrderId ?? null,
        // The signed amount, exactly as Amazon sent it.
        amount_raw: item.TotalAmount?.CurrencyAmount ?? null,
        currency: item.TotalAmount?.CurrencyCode ?? null,
        sign: (() => {
          const n = Number(item.TotalAmount?.CurrencyAmount);
          return Number.isFinite(n) ? (n > 0 ? 'positive' : n < 0 ? 'NEGATIVE' : 'zero') : 'unparsable';
        })(),
        seller_sku: item.SellerSKU ?? null,
        fn_sku: item.FnSKU ?? null,
        asin: item.ASIN ?? null,
        quantity: item.Quantity ?? item.QuantityShipped ?? null,
        product_description: item.ProductDescription ?? null,
        // Every remaining key, so a field we did not think to ask for is still
        // visible once rather than needing a second deploy.
        item_keys: Object.keys(item),
        event_keys: Object.keys(event),
      })),
    );

    // Totals per AdjustmentType, keeping signed and absolute apart -- that
    // difference is the entire question.
    const byType: Record<string, { items: number; signed_total: number; abs_total: number; negatives: number; positives: number }> = {};
    for (const f of flat) {
      const t = String(f.adjustment_type ?? '(null)');
      const n = Number(f.amount_raw) || 0;
      byType[t] ??= { items: 0, signed_total: 0, abs_total: 0, negatives: 0, positives: 0 };
      byType[t].items++;
      byType[t].signed_total = Math.round((byType[t].signed_total + n) * 100) / 100;
      byType[t].abs_total = Math.round((byType[t].abs_total + Math.abs(n)) * 100) / 100;
      if (n < 0) byType[t].negatives++;
      if (n > 0) byType[t].positives++;
    }

    return new Response(JSON.stringify({
      wrote_nothing: true,
      window: { posted_after: postedAfter, posted_before: postedBefore },
      pages,
      adjustment_events: adjustments.length,
      adjustment_items: flat.length,
      other_event_lists_seen: otherEventCounts,
      by_adjustment_type: byType,
      // summary_only keeps a multi-month sweep's payload small enough to read
      // back through pg_net without truncation.
      items: body.summary_only ? [] : flat,
      clawback_items: flat.filter((f: any) =>
        String(f.adjustment_type ?? '').toUpperCase().includes('COMPENSATED_CLAWBACK')),
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e), wrote_nothing: true }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
