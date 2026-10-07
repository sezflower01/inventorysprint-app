import { createClient } from 'npm:@supabase/supabase-js@2.57.2';
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');

    // Auth: internal secret OR service role OR authenticated user
    const authHeader = req.headers.get('Authorization');
    const internalSecretHeader = req.headers.get('x-internal-secret');
    
    let userId: string | null = null;
    let body: any = {};
    
    // Check internal secret for cron/background jobs
    if (internalSecretHeader && internalSecret && internalSecretHeader === internalSecret) {
      console.log('[BACKFILL] Authenticated via internal secret');
      body = await req.json().catch(() => ({}));
      userId = body.user_id || null;
    } else if (authHeader?.startsWith('Bearer ')) {
      // User JWT authentication
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } }
      });
      
      const { data: { user }, error: authError } = await userClient.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user.id;
      body = await req.json().catch(() => ({}));
    } else {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: 'user_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[BACKFILL] Starting snapshot backfill for user ${userId}`);

    // Use service role for data operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Optional: limit to specific order IDs or ASINs
    const targetOrderIds: string[] = body.order_ids || [];
    const targetAsins: string[] = body.asins || [];
    const startDate = typeof body.start_date === 'string' ? body.start_date.trim() : '';
    const endDate = typeof body.end_date === 'string' ? body.end_date.trim() : '';
    const limit = body.limit || 1000; // Increased default limit

    // Step 1: Find pending orders without snapshots
    // Query sales_orders - include all unsettled orders (sold_price = 0 or null)
    let ordersQuery = supabase
      .from('sales_orders')
      .select(`
        id,
        order_id,
        asin,
        estimated_price,
        marketplace,
        order_status,
        seller_sku
      `)
      .eq('user_id', userId)
      .or('sold_price.is.null,sold_price.eq.0')
      .not('asin', 'eq', 'PENDING')
      .not('asin', 'eq', 'UNKNOWN')
      .limit(limit);

    // Apply optional filters
    if (targetOrderIds.length > 0) {
      ordersQuery = ordersQuery.in('order_id', targetOrderIds);
    }
    if (targetAsins.length > 0) {
      ordersQuery = ordersQuery.in('asin', targetAsins);
    }
    if (startDate) {
      ordersQuery = ordersQuery.gte('order_date', startDate);
    }
    if (endDate) {
      ordersQuery = ordersQuery.lte('order_date', endDate);
    }

    const { data: pendingOrders, error: ordersError } = await ordersQuery;

    if (ordersError) {
      console.error('[BACKFILL] Error fetching pending orders:', ordersError);
      return new Response(JSON.stringify({ error: ordersError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      console.log('[BACKFILL] No pending orders found');
      return new Response(JSON.stringify({ 
        processed: 0, 
        inserted: 0, 
        skipped: 0,
        message: 'No pending orders to backfill' 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[BACKFILL] Found ${pendingOrders.length} pending orders to check`);

    // Step 2: Get existing snapshots for these orders
    const orderIds = [...new Set(pendingOrders.map(o => o.order_id))];
    
    const { data: existingSnapshots, error: snapshotsError } = await supabase
      .from('order_price_snapshots')
      .select('order_id, asin')
      .eq('user_id', userId)
      .in('order_id', orderIds);

    if (snapshotsError) {
      console.error('[BACKFILL] Error fetching existing snapshots:', snapshotsError);
    }

    const existingSet = new Set(
      (existingSnapshots || []).map(s => `${s.order_id}:${s.asin}`)
    );

    // Filter to orders missing snapshots
    const ordersMissingSnapshots = pendingOrders.filter(
      o => !existingSet.has(`${o.order_id}:${o.asin}`)
    );

    console.log(`[BACKFILL] ${ordersMissingSnapshots.length} orders missing snapshots`);

    if (ordersMissingSnapshots.length === 0) {
      return new Response(JSON.stringify({ 
        processed: pendingOrders.length, 
        inserted: 0, 
        skipped: pendingOrders.length,
        message: 'All pending orders already have snapshots' 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 3: Get inventory prices for fallback (by SKU first, then ASIN)
    const asins = [...new Set(ordersMissingSnapshots.map(o => o.asin))];
    const skus = [...new Set(ordersMissingSnapshots.map(o => o.seller_sku).filter(Boolean))];
    
    // Fetch inventory by SKU (SKU-first approach)
    const { data: inventoryBySku, error: invSkuError } = await supabase
      .from('inventory')
      .select('asin, sku, price, amazon_price')
      .eq('user_id', userId)
      .in('sku', skus.length > 0 ? skus : ['__none__']);

    if (invSkuError) {
      console.error('[BACKFILL] Error fetching inventory by SKU:', invSkuError);
    }

    // Fetch inventory by ASIN (fallback)
    const { data: inventoryByAsin, error: invAsinError } = await supabase
      .from('inventory')
      .select('asin, price, amazon_price')
      .eq('user_id', userId)
      .in('asin', asins);

    if (invAsinError) {
      console.error('[BACKFILL] Error fetching inventory by ASIN:', invAsinError);
    }

    // Build price maps - SKU takes priority
    const skuPriceMap = new Map<string, number>();
    for (const inv of inventoryBySku || []) {
      const price = inv.amazon_price || inv.price;
      if (price && price > 0) {
        skuPriceMap.set(inv.sku, price);
      }
    }

    const asinPriceMap = new Map<string, number>();
    for (const inv of inventoryByAsin || []) {
      const price = inv.amazon_price || inv.price;
      if (price && price > 0 && !asinPriceMap.has(inv.asin)) {
        asinPriceMap.set(inv.asin, price);
      }
    }

    // Step 4: Build snapshot inserts
    const snapshotsToInsert: Array<{
      user_id: string;
      order_id: string;
      asin: string;
      snapshot_price: number;
      snapshot_item_price: number;
      snapshot_shipping_price: number;
      snapshot_source: string;
      currency_code: string;
      marketplace_id: string;
    }> = [];

    let skippedNoPrice = 0;

    for (const order of ordersMissingSnapshots) {
      let snapshotPrice = 0;
      let snapshotSource = '';

      // Priority 1: estimated_price from sales_orders
      const estimatedPrice = Number(order.estimated_price || 0);
      if (estimatedPrice > 0) {
        snapshotPrice = estimatedPrice;
        snapshotSource = 'backfill_estimated';
      } else {
        // Priority 2: SKU-specific inventory price
        const skuPrice = order.seller_sku ? skuPriceMap.get(order.seller_sku) : undefined;
        if (skuPrice && skuPrice > 0) {
          snapshotPrice = skuPrice;
          snapshotSource = 'backfill_inventory_sku';
        } else {
          // Priority 3: ASIN inventory price
          const asinPrice = asinPriceMap.get(order.asin);
          if (asinPrice && asinPrice > 0) {
            snapshotPrice = asinPrice;
            snapshotSource = 'backfill_inventory_asin';
          }
        }
      }

      // Skip if no valid price found
      if (snapshotPrice <= 0) {
        skippedNoPrice++;
        continue;
      }

      // The marketplace decides marketplace_id. It does NOT decide the
      // currency of the amount being stored.
      //
      // This block used to set currency_code from the marketplace -- "a CA
      // order sells in CAD" -- and stamp it onto a price read out of
      // inventory, which is a single USD pool shared by all four
      // marketplaces. fetch-live-orders then read currency_code, believed the
      // amount was already native, and skipped the USD->CAD conversion. Order
      // 702-5492481-4068251 was stored as 20.75 "CAD", shown as $14.56 after
      // the page converted it back, and actually sold for CA$34.13 (~US$24).
      // Across 180 days the non-US estimates were +30% (CA), +1630% (MX) and
      // +422% (BR) against settled prices, while US was +0.3%.
      //
      // So currency_code now records the currency of the AMOUNT, which for an
      // inventory-derived price is USD regardless of the marketplace.
      const marketplace = order.marketplace || 'US';
      let marketplaceId = 'ATVPDKIKX0DER';
      if (marketplace === 'MX' || marketplace === 'Mexico') {
        marketplaceId = 'A1AM78C64UM0Y8';
      } else if (marketplace === 'CA' || marketplace === 'Canada') {
        marketplaceId = 'A2EUQ1WTGCTBG2';
      } else if (marketplace === 'BR' || marketplace === 'Brazil') {
        marketplaceId = 'A2Q3Y263D00KWC';
      }
      // snapshotSource says where the number came from, and that is what
      // decides its currency. Every source this backfill reads is a USD
      // inventory/estimate figure; if a marketplace-native source is ever
      // added here it must set this explicitly rather than inheriting USD.
      const currencyCode = 'USD';

      snapshotsToInsert.push({
        user_id: userId,
        order_id: order.order_id,
        asin: order.asin,
        snapshot_price: snapshotPrice,
        snapshot_item_price: snapshotPrice,
        snapshot_shipping_price: 0,
        snapshot_source: snapshotSource,
        currency_code: currencyCode,
        // Both columns, same answer. They disagreed on the rows that caused
        // this bug (currency USD, currency_code CAD) and the reader happened
        // to consult the wrong one.
        currency: currencyCode,
        marketplace_id: marketplaceId,
      });
    }

    console.log(`[BACKFILL] Prepared ${snapshotsToInsert.length} snapshots, skipped ${skippedNoPrice} (no price)`);

    // Step 5: Upsert snapshots (do not overwrite existing)
    let insertedCount = 0;
    if (snapshotsToInsert.length > 0) {
      // Batch insert in chunks of 100
      const chunkSize = 100;
      for (let i = 0; i < snapshotsToInsert.length; i += chunkSize) {
        const chunk = snapshotsToInsert.slice(i, i + chunkSize);
        const { data: insertedData, error: insertError } = await supabase
          .from('order_price_snapshots')
          .upsert(chunk, {
            onConflict: 'user_id,order_id,asin',
            ignoreDuplicates: true, // Do not overwrite existing
          })
          .select('id');

        if (insertError) {
          console.error('[BACKFILL] Error inserting snapshots batch:', insertError);
          // Continue with other batches
        } else {
          insertedCount += insertedData?.length || chunk.length;
        }
      }
      console.log(`[BACKFILL] ✓ Inserted ${insertedCount} snapshots`);
    }

    const result = {
      processed: pendingOrders.length,
      inserted: insertedCount,
      skipped: existingSet.size + skippedNoPrice,
      skippedNoPrice,
      skippedExisting: existingSet.size,
      message: `Backfilled ${insertedCount} missing snapshots`,
    };

    console.log('[BACKFILL] Complete:', result);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[BACKFILL] Unexpected error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
