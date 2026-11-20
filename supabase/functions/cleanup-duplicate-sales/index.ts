import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * One-time cleanup: Remove duplicate sales_orders rows where the same order-item
 * is stored twice — once with a real ASIN (B0...) and once with a SKU/ISBN.
 *
 * Detection logic:
 * - Same order_id + same quantity + price difference < $1
 * - Two distinct asin values
 * - Keep the row with a valid ASIN pattern (B0[A-Z0-9]{8}), delete the other
 * - For ambiguous pairs (neither is B0...), keep the first alphabetically
 *
 * Supports dry_run mode (default: true).
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Auth: require admin or internal secret
  const internalSecret = req.headers.get('x-internal-secret');
  const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
  const authHeader = req.headers.get('authorization')?.replace('Bearer ', '');

  let userId: string | null = null;

  if (internalSecret && internalSecret === expectedSecret) {
    // Internal call — get user_id from body
  } else if (authHeader) {
    const { data: { user }, error } = await supabase.auth.getUser(authHeader);
    if (error || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
    userId = user.id;
  } else {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default true
  if (body.user_id && !userId) userId = body.user_id;

  if (!userId) {
    return new Response(JSON.stringify({ error: 'user_id required' }), { status: 400, headers: corsHeaders });
  }

  console.log(`[CLEANUP_DUPES] Starting for user ${userId}, dryRun=${dryRun}`);

  const isRealAsin = (val: string): boolean => /^B0[A-Z0-9]{8}$/i.test(val);

  // Fetch all non-cancelled, non-refund rows
  const PAGE = 1000;
  const allRows: any[] = [];
  for (let from = 0; from < 500000; from += PAGE) {
    const { data, error } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, quantity, sold_price')
      .eq('user_id', userId)
      .not('order_id', 'like', '%-REFUND')
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[CLEANUP_DUPES] Fetch error:', (error as Error).message);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...data);
  }

  console.log(`[CLEANUP_DUPES] Loaded ${allRows.length} rows`);

  // Group by order_id + quantity to find potential duplicates
  const groups = new Map<string, any[]>();
  for (const row of allRows) {
    const key = `${row.order_id}::${row.quantity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const idsToDelete: string[] = [];
  const auditLog: any[] = [];

  for (const [, group] of groups) {
    if (group.length !== 2) continue;
    const [a, b] = group;
    if (a.asin === b.asin) continue; // same asin = not this type of duplicate

    const priceDiff = Math.abs((a.sold_price || 0) - (b.sold_price || 0));
    if (priceDiff > 1.0) continue;

    const aIsReal = isRealAsin(a.asin || '');
    const bIsReal = isRealAsin(b.asin || '');

    let keep: any, drop: any;
    if (aIsReal && !bIsReal) {
      keep = a; drop = b;
    } else if (bIsReal && !aIsReal) {
      keep = b; drop = a;
    } else {
      // Ambiguous — keep first alphabetically
      if ((a.asin || '') <= (b.asin || '')) {
        keep = a; drop = b;
      } else {
        keep = b; drop = a;
      }
    }

    idsToDelete.push(drop.id);
    auditLog.push({
      order_id: a.order_id,
      kept_asin: keep.asin,
      dropped_asin: drop.asin,
      kept_price: keep.sold_price,
      dropped_price: drop.sold_price,
    });
  }

  console.log(`[CLEANUP_DUPES] Found ${idsToDelete.length} duplicate rows to delete`);

  if (!dryRun && idsToDelete.length > 0) {
    // Delete in batches of 100
    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += 100) {
      const batch = idsToDelete.slice(i, i + 100);
      const { error: delError, count } = await supabase
        .from('sales_orders')
        .delete()
        .in('id', batch);
      if (delError) {
        console.error(`[CLEANUP_DUPES] Delete error at batch ${i}:`, delError.message);
      } else {
        deleted += count || batch.length;
      }
    }
    console.log(`[CLEANUP_DUPES] ✅ Deleted ${deleted} duplicate rows`);
  }

  return new Response(JSON.stringify({
    dry_run: dryRun,
    total_rows_scanned: allRows.length,
    duplicates_found: idsToDelete.length,
    deleted: dryRun ? 0 : idsToDelete.length,
    sample_duplicates: auditLog.slice(0, 20),
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
