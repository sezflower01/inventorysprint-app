import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID') || Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || Deno.env.get('LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${errorText}`);
  }
  return (await response.json()).access_token;
}

async function callSpApiRaw(
  method: string, path: string, accessToken: string,
  queryString: string,
): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const headers: Record<string, string> = {
    'host': host, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken,
  };
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const requestHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  return await fetch(url, {
    method, headers: { ...headers, 'Authorization': authorizationHeader },
  });
}

interface VerifyResult {
  asin: string;
  sku: string;
  db_before: { available: number; reserved: number; inbound: number };
  live: { available: number; reserved: number; inbound: number };
  // skipped_fbm_owned: FBA snapshot read 0/0/0 on a row sync-fbm-cleanup owns.
  // Kept distinct from 'unchanged' so the report shows WHY nothing was written.
  action: 'corrected' | 'unchanged' | 'not_found' | 'error' | 'skipped_fbm_owned';
  error?: string;
  delta?: { available: number; reserved: number; inbound: number };
}

interface InventoryRow {
  id: string;
  asin: string;
  sku: string;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  source: string | null;
  last_inventory_sync_at: string | null;
  listing_status: string | null;
}

const FULL_CATALOG_PAGE_SIZE = 500;

function buildInventoryRowsQuery(supabase: any, userId: string, mode: string) {
  let query = supabase
    .from('inventory')
    .select('id, asin, sku, available, reserved, inbound, source, last_inventory_sync_at, listing_status')
    .eq('user_id', userId)
    .not('listing_status', 'in', '("NOT_IN_CATALOG","DELETED")');

  if (mode === 'suspicious') {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    query = query
      .or(`last_inventory_sync_at.is.null,last_inventory_sync_at.lt.${staleThreshold},source.is.null,source.neq.live_api`)
      .order('last_inventory_sync_at', { ascending: true, nullsFirst: true });
  } else if (mode === 'in_stock') {
    query = query
      .or('available.gt.0,reserved.gt.0,inbound.gt.0')
      .order('last_inventory_sync_at', { ascending: true, nullsFirst: true });
  } else {
    query = query.order('id', { ascending: true });
  }

  return query;
}

async function fetchInventoryRowsToVerify(
  supabase: any,
  userId: string,
  mode: string,
  effectiveLimit: number | null,
): Promise<InventoryRow[]> {
  const isFullCatalogMode = mode === 'full_catalog' || mode === 'all';

  if (!isFullCatalogMode) {
    const { data, error } = await buildInventoryRowsQuery(supabase, userId, mode).limit(effectiveLimit ?? 50);
    if (error) throw error;
    return (data || []) as InventoryRow[];
  }

  const rows: InventoryRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await buildInventoryRowsQuery(supabase, userId, mode)
      .range(from, from + FULL_CATALOG_PAGE_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...(data as InventoryRow[]));
    console.log(`[BULK-VERIFY] Loaded inventory page ${Math.floor(from / FULL_CATALOG_PAGE_SIZE) + 1}: ${data.length} rows`);

    if (data.length < FULL_CATALOG_PAGE_SIZE) break;
    from += FULL_CATALOG_PAGE_SIZE;
  }

  return rows;
}

// SP-API getInventorySummaries supports multiple sellerSkus via repeated params
// but has a limit. We'll use nextToken pagination with batches of SKUs.
async function fetchInventoryBatch(
  skus: string[], marketplaceId: string, accessToken: string
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  
  // The API doesn't support multiple sellerSkus params well, so we paginate with nextToken
  // Instead, call once per SKU but with proper retry + backoff
  // Actually the API supports comma-separated or repeated sellerSkus param
  // Let's use the "nextToken" approach: fetch all inventory and filter
  
  // Better approach: use granularity endpoint without sellerSkus filter to get ALL inventory
  // then match locally. This is 1 API call instead of 213.
  
  let nextToken: string | null = null;
  let pageCount = 0;
  const maxPages = 50;
  
  do {
    const params: Record<string, string> = {
      marketplaceIds: marketplaceId,
      details: 'true',
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
    };
    if (nextToken) {
      params.nextToken = nextToken;
    }
    
    // Build query string with sorted params (required for AWS signing)
    const sortedParams = Object.keys(params).sort();
    const queryString = sortedParams.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    
    const response = await callSpApiRaw('GET', '/fba/inventory/v1/summaries', accessToken, queryString);
    
    if (response.status === 429) {
      // Rate limited - wait and retry
      console.warn(`[BULK-VERIFY] Rate limited on page ${pageCount + 1}, waiting 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SP-API ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    const summaries = data?.payload?.inventorySummaries || [];
    
    for (const s of summaries) {
      const sku = s.sellerSku;
      if (sku) {
        const d = s?.inventoryDetails || s || {};
        const inboundReceiving = d?.inboundReceivingQuantity ?? s?.inboundReceivingQuantity ?? 0;
        const inboundShipped = d?.inboundShippedQuantity ?? s?.inboundShippedQuantity ?? 0;
        result[sku] = {
          available: d?.fulfillableQuantity ?? s?.totalFulfillableQuantity ?? 0,
          reserved: d?.reservedQuantity?.totalReservedQuantity ?? s?.reservedQuantity?.totalReservedQuantity ?? 0,
          inbound: inboundReceiving + inboundShipped,
        };
      }
    }
    
    nextToken = data?.pagination?.nextToken || null;
    pageCount++;
    
    console.log(`[BULK-VERIFY] Fetched page ${pageCount}: ${summaries.length} items (total so far: ${Object.keys(result).length})`);
    
    // Small delay between pages to be respectful
    if (nextToken) {
      await new Promise(r => setTimeout(r, 300));
    }
  } while (nextToken && pageCount < maxPages);
  
  return result;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const requestedMode = typeof body?.mode === 'string' ? body.mode : 'suspicious';
    const mode = requestedMode;
    const isFullCatalogMode = mode === 'full_catalog' || mode === 'all';
    const requestedLimit = typeof body?.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : null;
    const dryRun = typeof body?.dry_run === 'boolean'
      ? body.dry_run
      : typeof body?.dryRun === 'boolean'
        ? body.dryRun
        : true;
    const user_id = body?.user_id;
    const effectiveLimit = isFullCatalogMode ? null : Math.min(requestedLimit ?? 50, 1000);

    // Auth
    const authHeader = req.headers.get('Authorization');
    const internalHeader = req.headers.get('x-internal-secret');
    const configuredInternalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

    let userId: string | null = null;

    if (internalHeader && configuredInternalSecret && internalHeader === configuredInternalSecret) {
      if (!user_id) {
        return new Response(JSON.stringify({ error: 'Missing user_id for internal call' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user_id;
    } else {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user.id;
    }

    const marketplaceId = 'ATVPDKIKX0DER'; // US

    console.log(`[BULK-VERIFY] Starting: mode=${mode}, limit=${effectiveLimit ?? 'ALL'}, dry_run=${dryRun}, user=${userId}`);

    const rows = await fetchInventoryRowsToVerify(supabase, userId, mode, effectiveLimit);
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({
        summary: { total: 0, corrected: 0, unchanged: 0, not_found: 0, errors: 0 },
        results: [], dry_run: dryRun,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`[BULK-VERIFY] Found ${rows.length} rows to verify`);

    // Get access token once
    const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN')!;
    const accessToken = await getLwaAccessToken(refreshToken);

    // Fetch ALL inventory from SP-API in one paginated call (instead of 1 call per SKU)
    console.log(`[BULK-VERIFY] Fetching all inventory summaries from SP-API...`);
    const liveInventoryMap = await fetchInventoryBatch([], marketplaceId, accessToken);
    console.log(`[BULK-VERIFY] Got ${Object.keys(liveInventoryMap).length} SKUs from SP-API`);

    const results: VerifyResult[] = [];
    let promotedCount = 0;      // orphaned created_listings promoted into inventory
    let orphanCandidates = 0;   // live SKUs Amazon returned that we had no row for
    let promotedAwaitingReceipt = 0; // FBA-registered listings with no inventory record yet
    const updateBatch: { id: string; asin: string; available: number; reserved: number; inbound: number; listing_status: string; prev_available: number; prev_reserved: number }[] = [];
    const protectBatch: string[] = []; // IDs of unchanged items to tag as live_api for protection

    for (const row of rows) {
      const dbBefore = {
        available: row.available || 0,
        reserved: row.reserved || 0,
        inbound: row.inbound || 0,
      };

      const live = liveInventoryMap[row.sku] || null;

      if (!live) {
        // SKU missing from the bulk SP-API snapshot is not authoritative enough to zero stock.
        // This happens intermittently in scheduled full-catalog runs and was causing 0/0/0 wipes
        // until manual per-SKU Live Update repaired the row. Keep DB quantities unchanged here.
        results.push({
          asin: row.asin, sku: row.sku, db_before: dbBefore,
          live: dbBefore,
          action: 'not_found',
        });
        continue;
      }

      // ⚠️ AN FBA SNAPSHOT READING 0/0/0 IS NOT AUTHORITATIVE FOR AN FBM ROW.
      //
      // Same principle as the `if (!live)` guard above, one case further on.
      // inventory.available is a SINGLE field shared by both fulfilment
      // channels, and this function only ever reads the FBA Inventory API --
      // there is no FBM concept anywhere in this file. A SKU that was once FBA
      // keeps its FBA record (that is what the fnsku is) even after every unit
      // moves to merchant-fulfilled, so Amazon correctly returns 0/0/0 for the
      // FBA side while the seller genuinely holds stock.
      //
      // Without this guard the FBA writers win by sheer frequency:
      // bulk-live-verify, refresh-stale-inventory and inventory-refresh-worker
      // run constantly, sync-fbm-cleanup runs every 4 hours. So the FBM sync
      // would write the real quantity and have it zeroed again within minutes.
      //
      // The damage is not just a wrong number. available = 0 forces
      // listing_status = INACTIVE below, INACTIVE is in auto-assign-bulk's
      // bad-status list, and auto-assign-bulk then disables the repricer
      // assignment as a "broken/deleted assignment". Confirmed live on
      // 2026-08-24, ASIN B001GQ2DB6 / SKU CM-BEP5-6YOO: the assignment was
      // enabled at 22:45:18.28 for stock_detected and disabled at 22:45:18.59
      // -- 310 milliseconds later -- so 5 real FBM units went unrepriced for
      // over a week.
      //
      // source = 'amazon_sync_fbm' is written ONLY by sync-fbm-cleanup's FBM
      // branch, so it is a reliable marker that the FBM sync owns this row.
      // A genuine FBA zero still zeroes normally: those rows carry
      // 'amazon_sync' or 'live_api', not 'amazon_sync_fbm'.
      const rowIsFbmOwned = String(row.source || '') === 'amazon_sync_fbm';
      const liveFbaIsAllZero = (live.available + live.reserved + live.inbound) === 0;
      if (rowIsFbmOwned && liveFbaIsAllZero) {
        console.log(`[BULK-VERIFY] FBM_ZERO_GUARD: keeping DB quantities for ${row.asin}/${row.sku} (FBM-owned row, FBA snapshot is 0/0/0)`);
        results.push({
          asin: row.asin, sku: row.sku, db_before: dbBefore,
          live: dbBefore,
          action: 'skipped_fbm_owned',
        });
        continue;
      }

      const delta = {
        available: live.available - dbBefore.available,
        reserved: live.reserved - dbBefore.reserved,
        inbound: live.inbound - dbBefore.inbound,
      };

      const changed = delta.available !== 0 || delta.reserved !== 0 || delta.inbound !== 0;

      if (!dryRun) {
        const totalLive = live.available + live.reserved + live.inbound;
        if (changed) {
          // Match rescue-inventory-asin: always set INACTIVE when zero stock
          updateBatch.push({
            id: row.id,
            asin: row.asin,
            available: live.available,
            reserved: live.reserved,
            inbound: live.inbound,
            listing_status: totalLive > 0 ? 'ACTIVE' : 'INACTIVE',
            prev_available: dbBefore.available,
            prev_reserved: dbBefore.reserved,
          });
        } else {
          // CRITICAL: Even unchanged items need source='live_api' + fresh timestamp
          // so sync-inventory-report respects the 2-hour protection window
          // and doesn't overwrite verified data with stale report data.
          protectBatch.push(row.id);
        }
      }

      results.push({
        asin: row.asin, sku: row.sku, db_before: dbBefore, live, delta,
        action: changed ? 'corrected' : 'unchanged',
      });
    }

    // Apply updates
    if (updateBatch.length > 0 && !dryRun) {
      console.log(`[BULK-VERIFY] Applying ${updateBatch.length} corrections...`);
      const restockAsins: string[] = [];

      for (let i = 0; i < updateBatch.length; i++) {
        const u = updateBatch[i];
        const nowIso = new Date().toISOString();
        await supabase
          .from('inventory')
          .update({
            available: u.available,
            reserved: u.reserved,
            inbound: u.inbound,
            listing_status: u.listing_status,
            source: 'live_api',
            last_inventory_sync_at: nowIso,
            last_summaries_at: nowIso,
          })
          .eq('id', u.id);

        // Track restock events (stock recovered from zero) — matches rescue-inventory-asin logic
        const prevSellable = (u.prev_available || 0) + (u.prev_reserved || 0);
        const newSellable = u.available + u.reserved;
        if (prevSellable === 0 && newSellable > 0) {
          restockAsins.push(u.asin);
        }
      }

      // Re-enable repricer assignments for restocked ASINs (matches rescue-inventory-asin)
      if (restockAsins.length > 0) {
        console.log(`[BULK-VERIFY] Restocked ASINs detected: ${restockAsins.length}, re-enabling assignments...`);
        for (const asin of restockAsins) {
          const { data: reEnabled } = await supabase
            .from('repricer_assignments')
            .update({ is_enabled: true })
            .eq('user_id', userId)
            .eq('asin', asin)
            .eq('is_enabled', false)
            .select('asin, marketplace');
          if (reEnabled?.length) {
            console.log(`[BULK-VERIFY] Re-enabled ${reEnabled.length} assignment(s) for ${asin}`);
          }
        }
      }

      console.log(`[BULK-VERIFY] All ${updateBatch.length} corrections applied`);

    }

    // Promotion runs on EVERY non-dry run, not only when corrections were
    // applied. It was originally nested inside
    // `if (updateBatch.length > 0 && !dryRun)` — so the first execution
    // promoted 8 rows (12 corrections that run) and every execution after
    // it promoted nothing, because a steady-state catalogue needs no
    // corrections and the whole block was skipped. Finding orphans has
    // nothing to do with whether existing rows drifted.
    if (!dryRun) {
      // ── PROMOTE ORPHANED created_listings ──────────────────────────────
      //
      // A listing can exist in created_listings and never reach inventory,
      // and until now nothing ever noticed. Measured 2026-09-01: 594 such
      // rows, spanning 2025-11-30 to that same day -- ten months of steady
      // accumulation. They render on the Synced Inventory page (which merges
      // created_listings in for display) showing 0/0/0 and a blank Last
      // Synced, indistinguishable from genuinely out-of-stock inventory. No
      // sync, no refresh queue, no repricer.
      //
      // WHY THIS FUNCTION IS THE RIGHT PLACE. sync-inventory-report uses the
      // REPORT (GET_FBA_MYI_ALL_INVENTORY_DATA), which omits SKUs with no
      // stock -- so a live listing awaiting its first shipment can never
      // appear through it. This function uses the SUMMARIES API
      // (/fba/inventory/v1/summaries), which returns every FBA SKU including
      // zero-quantity ones. It already holds the answer; it simply never
      // acted on SKUs it had no row for.
      //
      // WHY AMAZON DECIDES, NOT US. created_listings has no status column and
      // its `units` field is what the user typed when planning the listing,
      // not what Amazon holds -- 586 of the 594 orphans have units > 0 while
      // having no FBA presence at all. So a planned-but-never-shipped listing
      // is indistinguishable from a live one in our data. Presence in the
      // summaries response is the only trustworthy signal, and it is used
      // here as the sole criterion: in the response means real, absent means
      // leave alone. Promoting all 594 on `units > 0` would have poured
      // hundreds of phantom SKUs into the repricer and into COGS resolution.
      try {
        const liveSkus = Object.keys(liveInventoryMap);

        // EVERY inventory SKU for this user, not just the rows this run verified.
        // fetchInventoryRowsToVerify applies effectiveLimit, so building the known
        // set from `rows` would mark every SKU outside that window as unknown and
        // insert a DUPLICATE for any that also had a created_listings entry.
        const knownSkus = new Set<string>();
        {
          let from = 0;
          const PAGE = 1000;
          for (;;) {
            const { data, error } = await supabase
              .from('inventory')
              .select('sku')
              .eq('user_id', userId)
              .range(from, from + PAGE - 1);
            // Abort rather than continue with a partial known-set: a short read
            // here would make real inventory look orphaned and duplicate it.
            if (error) throw new Error(`known-sku scan failed: ${error.message}`);
            for (const r of data || []) if (r?.sku) knownSkus.add(r.sku);
            if ((data?.length || 0) < PAGE) break;
            from += PAGE;
          }
        }
        const unknownLiveSkus = liveSkus.filter((sku) => !knownSkus.has(sku));

        if (unknownLiveSkus.length > 0) {
          console.log(`[BULK-VERIFY] ${unknownLiveSkus.length} live SKU(s) have no inventory row — checking created_listings`);

          // Chunked: an unbounded .in() becomes a query string long enough for
          // Deno to reject the URL outright. Cost a 10-day outage in
          // check-seller-watchlist on 2026-09-01; not repeating it here.
          const CHUNK = 150;
          const orphanRows: any[] = [];
          for (let i = 0; i < unknownLiveSkus.length; i += CHUNK) {
            const batch = unknownLiveSkus.slice(i, i + CHUNK);
            const { data, error } = await supabase
              .from('created_listings')
              .select('asin, sku, title, image_url, price, cost, amount, units, fnsku')
              .eq('user_id', userId)
              .in('sku', batch);
            if (error) {
              console.warn('[BULK-VERIFY] created_listings lookup failed:', error.message);
              break;
            }
            if (data) orphanRows.push(...data);
          }

          const nowIso2 = new Date().toISOString();
          let promoted = 0;
          for (const cl of orphanRows) {
            const live = liveInventoryMap[cl.sku];
            if (!live) continue;
            const { error: insErr } = await supabase.from('inventory').insert({
              user_id: userId,
              asin: cl.asin,
              sku: cl.sku,
              fnsku: cl.fnsku ?? null,
              title: cl.title ?? null,
              image_url: cl.image_url ?? null,
              price: cl.price ?? null,
              // inventory.cost is PER UNIT. created_listings.cost is the LOT
              // TOTAL and `amount` is the unit cost -- verified 2026-09-05:
              // cost / units equals amount on 6,876 of 6,889 multi-unit
              // listings. Writing cl.cost here put a whole purchase order into
              // a per-unit field, so B0G2YNN87D carried $2,136.34 per unit
              // instead of $21.58 and a two-unit sale reported -$2,157.92 COGS
              // against $81.95 of revenue.
              //
              // Falls back to cost/units rather than to cl.cost: a wrong unit
              // cost that is merely missing is recoverable, one inflated 99x
              // silently poisons every profit and ROI figure that touches it.
              cost: cl.amount ?? (cl.units && cl.units > 0 && cl.cost
                ? Number((cl.cost / cl.units).toFixed(4))
                : null),
              available: live.available,
              reserved: live.reserved,
              inbound: live.inbound,
              // NOT 'created_listing': that source is excluded from
              // enqueue_full_inventory_refresh by design, which would leave
              // the row just as invisible as before. Amazon confirmed this
              // SKU, so it is ordinary synced inventory.
              source: 'live_api',
              listing_status: 'ACTIVE',
              last_inventory_sync_at: nowIso2,
              last_summaries_at: nowIso2,
            });
            if (insErr) {
              // Most likely a unique-constraint race with another sync. Not
              // fatal, and not worth aborting the rest of the promotion.
              console.warn(`[BULK-VERIFY] promote ${cl.sku} failed: ${insErr.message}`);
              continue;
            }
            promoted++;
          }
          console.log(`[BULK-VERIFY] Promoted ${promoted} orphaned listing(s) into inventory`);
          promotedCount = promoted;
          orphanCandidates = unknownLiveSkus.length;
        }

        // ── FBA-REGISTERED BUT NEVER RECEIVED ───────────────────────────
        //
        // The pass above can only promote SKUs the Summaries API returned,
        // and Summaries reports INVENTORY. A listing enrolled in FBA that has
        // never had a shipment received has no inventory record at all, so
        // neither the report nor the summaries can ever see it. It stays
        // invisible for exactly as long as it sits unstocked -- which is
        // precisely the window in which the seller most needs to see it.
        //
        // Measured 2026-09-01: 12 such listings holding $4,966.75 of planned
        // inventory, one of them the ASIN that started this investigation.
        //
        // THE FNSKU IS AMAZON'S OWN CONFIRMATION. Amazon assigns one only
        // when it enrols a SKU in FBA, so holding one is proof the listing is
        // real. No getListingsItem call is needed to establish what we were
        // already told. (The other 574 orphans have no FNSKU, were never
        // enrolled, and are correctly left alone -- promoting on `units > 0`
        // would have swept all of them in.)
        //
        // Quantities are zero because they genuinely are zero. The row exists
        // so the listing is visible, queued for refresh, and picked up the
        // moment stock arrives.
        //
        // Risk accepted: a SKU enrolled and later deleted still carries an
        // FNSKU here, so a dead listing can be promoted. It renders as 0/0/0
        // and clean-ghost-listings already removes inventory rows Amazon no
        // longer recognises.
        // PAGINATED. Supabase caps an unranged select at 1,000 rows, and this
        // account has 2,212 listings carrying an FNSKU -- the first attempt
        // silently read only the first page and promoted nothing, because the
        // twelve that mattered sat beyond it. A cap that returns a short list
        // instead of an error is the same shape of bug as the unbounded .in()
        // that took check-seller-watchlist down for ten days.
        const fnskuOrphans: any[] = [];
        let fnskuErr: any = null;
        {
          let from = 0;
          const PAGE = 1000;
          for (;;) {
            const { data, error } = await supabase
              .from('created_listings')
              .select('asin, sku, title, image_url, price, cost, amount, units, fnsku')
              .eq('user_id', userId)
              .not('fnsku', 'is', null)
              .range(from, from + PAGE - 1);
            if (error) { fnskuErr = error; break; }
            if (data) fnskuOrphans.push(...data);
            if ((data?.length || 0) < PAGE) break;
            from += PAGE;
          }
        }

        if (fnskuErr) {
          console.warn('[BULK-VERIFY] fnsku orphan lookup failed:', fnskuErr.message);
        } else if (fnskuOrphans.length) {
          const nowIso3 = new Date().toISOString();
          let awaitingPromoted = 0;
          for (const cl of fnskuOrphans) {
            if (knownSkus.has(cl.sku)) continue;          // already tracked
            if (liveInventoryMap[cl.sku]) continue;       // handled by the pass above
            const { error: insErr } = await supabase.from('inventory').insert({
              user_id: userId,
              asin: cl.asin,
              sku: cl.sku,
              fnsku: cl.fnsku,
              title: cl.title ?? null,
              image_url: cl.image_url ?? null,
              price: cl.price ?? null,
              // inventory.cost is PER UNIT. created_listings.cost is the LOT
              // TOTAL and `amount` is the unit cost -- verified 2026-09-05:
              // cost / units equals amount on 6,876 of 6,889 multi-unit
              // listings. Writing cl.cost here put a whole purchase order into
              // a per-unit field, so B0G2YNN87D carried $2,136.34 per unit
              // instead of $21.58 and a two-unit sale reported -$2,157.92 COGS
              // against $81.95 of revenue.
              //
              // Falls back to cost/units rather than to cl.cost: a wrong unit
              // cost that is merely missing is recoverable, one inflated 99x
              // silently poisons every profit and ROI figure that touches it.
              cost: cl.amount ?? (cl.units && cl.units > 0 && cl.cost
                ? Number((cl.cost / cl.units).toFixed(4))
                : null),
              available: 0,
              reserved: 0,
              inbound: 0,
              source: 'live_api',
              listing_status: 'ACTIVE',
              last_inventory_sync_at: nowIso3,
              last_summaries_at: nowIso3,
            });
            if (insErr) {
              console.warn(`[BULK-VERIFY] promote-awaiting ${cl.sku} failed: ${insErr.message}`);
              continue;
            }
            knownSkus.add(cl.sku);
            awaitingPromoted++;
          }
          if (awaitingPromoted > 0) {
            console.log(`[BULK-VERIFY] Promoted ${awaitingPromoted} FBA-registered listing(s) awaiting first receipt`);
          }
          promotedAwaitingReceipt = awaitingPromoted;
        }
      } catch (promoteErr: any) {
        // Never let promotion failure lose the verification work above.
        console.warn('[BULK-VERIFY] orphan promotion failed:', promoteErr?.message);
      }
    }

    // Protect unchanged items: tag as live_api so sync-inventory-report won't overwrite
    if (protectBatch.length > 0 && !dryRun) {
      console.log(`[BULK-VERIFY] Protecting ${protectBatch.length} unchanged items with live_api tag...`);
      const PROTECT_BATCH_SIZE = 200;
      for (let i = 0; i < protectBatch.length; i += PROTECT_BATCH_SIZE) {
        const batch = protectBatch.slice(i, i + PROTECT_BATCH_SIZE);
        const nowIso = new Date().toISOString();
        await supabase
          .from('inventory')
          .update({
            source: 'live_api',
            last_inventory_sync_at: nowIso,
            last_summaries_at: nowIso,
          })
          .in('id', batch);
      }
      console.log(`[BULK-VERIFY] Protected ${protectBatch.length} unchanged items`);
    }

    const summary = {
      total: results.length,
      corrected: results.filter(r => r.action === 'corrected').length,
      unchanged: results.filter(r => r.action === 'unchanged').length,
      not_found: results.filter(r => r.action === 'not_found').length,
      errors: results.filter(r => r.action === 'error').length,
      // Orphan promotion, reported rather than left to be inferred from the
      // database afterwards. The first run of this feature returned a summary
      // with no sign of whether it had promoted anything, which made the one
      // question it exists to answer unanswerable from its own output.
      orphan_candidates: orphanCandidates,  // live SKUs Amazon returned with no inventory row
      promoted: promotedCount,              // of those, how many matched created_listings and were inserted
      promoted_awaiting_receipt: promotedAwaitingReceipt, // FBA-enrolled, no inventory record yet
    };

    console.log(`[BULK-VERIFY] Complete: ${JSON.stringify(summary)} dry_run=${dryRun}`);

    return new Response(JSON.stringify({ summary, results, dry_run: dryRun }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error(`[BULK-VERIFY] Error:`, (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
