import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Reconcile Sales Prices
 *
 * Matches sales_orders rows to authoritative settled amounts from financial_events_cache
 * and corrects inflated prices (from inventory_refresh, estimated_price, etc.).
 *
 * Strategy:
 * 1. Group FEC shipment events by order_id → settled total per order
 * 2. Group sales_orders by order_id → current total per order
 * 3. For orders where price_source is unreliable AND SO total ≠ FEC total:
 *    - Single-item order: set sold_price = FEC sales amount
 *    - Multi-item order: distribute FEC total proportionally by quantity
 * 4. Write audit trail to sales_reconciliation_audit
 *
 * Parameters:
 * - dryRun: boolean (default true) — preview changes without writing
 * - startDate: ISO date (optional) — limit to orders on/after this date
 * - endDate: ISO date (optional) — limit to orders on/before this date
 */

const UNRELIABLE_SOURCES = new Set([
  'inventory_refresh',
  'inventory_refresh_forced',
  'estimated_price',
  'inventory',
  'cleared_estimated',
  'pricing_api_mx',
  'pricing_api_ca',
  'pricing_api_br',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Support both user auth and internal secret (for admin/cron usage)
  const internalSecret = req.headers.get('x-internal-secret');
  const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
  const authHeader = req.headers.get('Authorization');

  let userId: string;

  if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
    // Internal call — require user_id in body
    try {
      const body = await req.clone().json();
      if (!body.user_id) {
        return new Response(JSON.stringify({ error: 'user_id required for internal calls' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = body.user_id;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } else if (authHeader) {
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    userId = user.id;
  } else {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  let dryRun = true;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let maxCorrections = 2000; // limit per invocation to avoid CPU timeout

  try {
    const body = await req.json();
    dryRun = body.dryRun !== false; // default true for safety
    startDate = body.startDate || null;
    endDate = body.endDate || null;
    if (body.maxCorrections && Number(body.maxCorrections) > 0) {
      maxCorrections = Math.min(Number(body.maxCorrections), 5000);
    }
  } catch { /* defaults */ }

  const runId = crypto.randomUUID();
  console.log(`[reconcile] Run ${runId} for user ${userId}, dryRun=${dryRun}, range=${startDate}..${endDate}`);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // ── Step 1: Fetch FEC shipment data grouped by order ──
    const fecOrderMap = new Map<string, { total: number; itemCount: number; eventDate: string }>();
    const FEC_PAGE = 1000;
    for (let from = 0; from < 500000; from += FEC_PAGE) {
      let q = supabase
        .from('financial_events_cache')
        .select('amazon_order_id, sales, event_date')
        .eq('user_id', userId)
        .eq('event_type', 'shipment')
        .not('amazon_order_id', 'is', null)
        .neq('amazon_order_id', '')
        .order("id", { ascending: true })
        .range(from, from + FEC_PAGE - 1);

      if (startDate) q = q.gte('event_date', startDate);
      if (endDate) q = q.lte('event_date', endDate);

      const { data: fecPage, error: fecErr } = await q;
      if (fecErr) { console.error('[reconcile] FEC fetch error:', fecErr); break; }
      if (!fecPage || fecPage.length === 0) break;

      for (const row of fecPage) {
        const orderId = String(row.amazon_order_id).trim();
        if (!orderId) continue;
        const salesAmt = Math.abs(Number(row.sales || 0));
        const existing = fecOrderMap.get(orderId);
        if (existing) {
          existing.total += salesAmt;
          existing.itemCount += 1;
        } else {
          fecOrderMap.set(orderId, {
            total: salesAmt,
            itemCount: 1,
            eventDate: String(row.event_date || '').slice(0, 10),
          });
        }
      }
      if (fecPage.length < FEC_PAGE) break;
    }

    console.log(`[reconcile] FEC: ${fecOrderMap.size} unique orders loaded`);

    // ── Step 2: Fetch sales_orders with unreliable prices ──
    const SO_PAGE = 1000;
    // Group SO rows by order_id for comparison
    const soOrderMap = new Map<string, Array<{
      id: string; order_id: string; asin: string; seller_sku: string;
      quantity: number; sold_price: number; total_sale_amount: number;
      estimated_price: number; price_source: string | null; order_status: string;
    }>>();

    for (let from = 0; from < 500000; from += SO_PAGE) {
      let q = supabase
        .from('sales_orders')
        .select('id, order_id, asin, seller_sku, quantity, sold_price, total_sale_amount, estimated_price, price_source, order_status, order_date')
        .eq('user_id', userId)
        .not('order_id', 'like', '%-REFUND')
        // Include PENDING asin rows — they can still be matched by order_id to FEC
        .or('price_source.neq.reconciled_fec,price_source.is.null')
        .order('order_date', { ascending: true })
        .range(from, from + SO_PAGE - 1);

      if (startDate) q = q.gte('order_date', startDate);
      if (endDate) q = q.lte('order_date', endDate);

      const { data: soPage, error: soErr } = await q;
      if (soErr) { console.error('[reconcile] SO fetch error:', soErr); break; }
      if (!soPage || soPage.length === 0) break;

      for (const row of soPage) {
        const orderId = String(row.order_id || '').trim();
        if (!orderId) continue;
        const items = soOrderMap.get(orderId) || [];
        items.push({
          id: row.id,
          order_id: orderId,
          asin: String(row.asin || '').trim(),
          seller_sku: String(row.seller_sku || '').trim(),
          quantity: Math.max(1, Number(row.quantity || 0)),
          sold_price: Number(row.sold_price || 0),
          total_sale_amount: Number(row.total_sale_amount || 0),
          estimated_price: Number(row.estimated_price || 0),
          price_source: row.price_source || null,
          order_status: String(row.order_status || '').toLowerCase(),
        });
        soOrderMap.set(orderId, items);
      }
      if (soPage.length < SO_PAGE) break;
    }

    console.log(`[reconcile] SO: ${soOrderMap.size} unique orders loaded`);

    // ── Step 3: Compare and build corrections ──
    let matched = 0;
    let corrected = 0;
    let skippedAlreadyCorrect = 0;
    let skippedNoFec = 0;
    let skippedReliable = 0;

    const corrections: Array<{
      soId: string; orderId: string; asin: string; sellerSku: string;
      prevSoldPrice: number; newSoldPrice: number;
      prevTotalSale: number; newTotalSale: number;
      prevPriceSource: string | null; quantity: number;
      fecSettled: number; fecEventDate: string;
      correctionType: string;
    }> = [];

    for (const [orderId, soItems] of soOrderMap) {
      const fecData = fecOrderMap.get(orderId);
      if (!fecData) {
        skippedNoFec += soItems.length;
        continue;
      }

      matched += soItems.length;

      // Check if ANY item in this order has unreliable pricing
      const hasUnreliable = soItems.some(item =>
        UNRELIABLE_SOURCES.has(item.price_source || '') || !item.price_source
      );

      if (!hasUnreliable) {
        skippedReliable += soItems.length;
        continue;
      }

      // Calculate current SO total for this order
      const soTotal = soItems.reduce((sum, item) => {
        const price = item.total_sale_amount > 0 ? item.total_sale_amount :
          item.sold_price > 0 ? item.sold_price * item.quantity :
          item.estimated_price > 0 ? item.estimated_price * item.quantity : 0;
        return sum + price;
      }, 0);

      const fecTotal = fecData.total;

      // Skip if already within 5% tolerance (already correct)
      if (soTotal > 0 && Math.abs(soTotal - fecTotal) / Math.max(soTotal, fecTotal) < 0.05) {
        skippedAlreadyCorrect += soItems.length;
        continue;
      }

      // Calculate total quantity for proportional distribution
      const totalQty = soItems.reduce((sum, item) => sum + item.quantity, 0);

      if (soItems.length === 1) {
        // Single-item order: direct assignment
        const item = soItems[0];
        const newUnitPrice = fecTotal / item.quantity;

        corrections.push({
          soId: item.id,
          orderId,
          asin: item.asin,
          sellerSku: item.seller_sku,
          prevSoldPrice: item.sold_price,
          newSoldPrice: Number(newUnitPrice.toFixed(2)),
          prevTotalSale: item.total_sale_amount,
          newTotalSale: Number(fecTotal.toFixed(2)),
          prevPriceSource: item.price_source,
          quantity: item.quantity,
          fecSettled: fecTotal,
          fecEventDate: fecData.eventDate,
          correctionType: 'single_item',
        });
      } else {
        // Multi-item order: distribute FEC total proportionally by quantity
        let distributed = 0;
        for (let i = 0; i < soItems.length; i++) {
          const item = soItems[i];
          let itemShare: number;
          if (i === soItems.length - 1) {
            // Last item gets remainder to avoid rounding errors
            itemShare = fecTotal - distributed;
          } else {
            itemShare = (item.quantity / totalQty) * fecTotal;
            itemShare = Number(itemShare.toFixed(2));
          }
          distributed += itemShare;

          const newUnitPrice = itemShare / item.quantity;

          corrections.push({
            soId: item.id,
            orderId,
            asin: item.asin,
            sellerSku: item.seller_sku,
            prevSoldPrice: item.sold_price,
            newSoldPrice: Number(newUnitPrice.toFixed(2)),
            prevTotalSale: item.total_sale_amount,
            newTotalSale: Number(itemShare.toFixed(2)),
            prevPriceSource: item.price_source,
            quantity: item.quantity,
            fecSettled: fecTotal,
            fecEventDate: fecData.eventDate,
            correctionType: soItems.length > 1 ? 'multi_item_proportional' : 'single_item',
          });
        }
      }
    }

    corrected = corrections.length;
    console.log(`[reconcile] Results: matched=${matched}, corrected=${corrected}, skippedReliable=${skippedReliable}, skippedAlreadyCorrect=${skippedAlreadyCorrect}, skippedNoFec=${skippedNoFec}`);

    if (dryRun) {
      // Sample some corrections for preview
      const sample = corrections.slice(0, 20).map(c => ({
        order_id: c.orderId,
        asin: c.asin,
        prev_price: c.prevSoldPrice,
        new_price: c.newSoldPrice,
        prev_source: c.prevPriceSource,
        correction_type: c.correctionType,
        fec_settled: c.fecSettled,
      }));

      return new Response(JSON.stringify({
        success: true,
        dryRun: true,
        runId,
        summary: {
          fecOrdersLoaded: fecOrderMap.size,
          soOrdersLoaded: soOrderMap.size,
          matched,
          corrected,
          skippedReliable,
          skippedAlreadyCorrect,
          skippedNoFec,
        },
        sample,
        message: `Would correct ${corrected} rows. Run with dryRun=false to apply.`,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Step 4: Apply corrections in batches (capped to avoid CPU timeout) ──
    const totalEligible = corrections.length;
    const cappedCorrections = corrections.slice(0, maxCorrections);
    const BATCH = 50;
    let applied = 0;
    let failed = 0;

    for (let i = 0; i < cappedCorrections.length; i += BATCH) {
      const batch = cappedCorrections.slice(i, i + BATCH);

      // Update each row
      for (const c of batch) {
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            sold_price: c.newSoldPrice,
            total_sale_amount: c.newTotalSale,
            price_source: 'reconciled_fec',
            estimated_price: null,
          })
          .eq('id', c.soId);

        if (updateErr) {
          console.error(`[reconcile] Update failed for ${c.soId}:`, updateErr);
          failed++;
        } else {
          applied++;
        }
      }

      // Write audit records
      const auditRows = batch.map(c => ({
        user_id: userId,
        order_id: c.orderId,
        asin: c.asin,
        seller_sku: c.sellerSku,
        reconciliation_run_id: runId,
        previous_sold_price: c.prevSoldPrice,
        new_sold_price: c.newSoldPrice,
        previous_total_sale_amount: c.prevTotalSale,
        new_total_sale_amount: c.newTotalSale,
        previous_price_source: c.prevPriceSource,
        new_price_source: 'reconciled_fec',
        fec_settled_amount: c.fecSettled,
        fec_event_date: c.fecEventDate,
        correction_type: c.correctionType,
        quantity: c.quantity,
      }));

      const { error: auditErr } = await supabase
        .from('sales_reconciliation_audit')
        .insert(auditRows);

      if (auditErr) {
        console.error(`[reconcile] Audit write error:`, auditErr);
      }

      if (i % 500 === 0 && i > 0) {
        console.log(`[reconcile] Progress: ${applied}/${cappedCorrections.length} applied`);
      }
    }

    const remaining = totalEligible - cappedCorrections.length;
    console.log(`[reconcile] Complete: applied=${applied}, failed=${failed}, remaining=${remaining}`);

    return new Response(JSON.stringify({
      success: true,
      dryRun: false,
      runId,
      summary: {
        fecOrdersLoaded: fecOrderMap.size,
        soOrdersLoaded: soOrderMap.size,
        matched,
        totalCorrections: totalEligible,
        applied,
        failed,
        remaining,
        skippedReliable,
        skippedAlreadyCorrect,
        skippedNoFec,
      },
      message: remaining > 0
        ? `Applied ${applied} corrections (${remaining} remaining — click Apply Fix again to continue).`
        : `Reconciliation complete. Applied ${applied} corrections, ${failed} failures.`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[reconcile] Fatal error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message || 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
