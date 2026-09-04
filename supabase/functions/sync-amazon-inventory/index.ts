import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Retry helper for network/DNS errors
async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Fetch attempt ${attempt + 1}/${maxRetries} for ${url}`);
      const response = await fetch(url, options);
      return response;
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);
      
      if (errorMessage.includes('dns error') || 
          errorMessage.includes('name resolution') ||
          errorMessage.includes('client error')) {
        
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          console.log(`DNS/Network error, retrying in ${delayMs}ms...`, errorMessage);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
      
      throw error;
    }
  }
  
  throw lastError || new Error('All retry attempts failed');
}

// AWS SigV4 signing functions
function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function getLwaAccessToken(
  refreshToken: string,
  clientIdOverride?: string | null,
  clientSecretOverride?: string | null,
): Promise<string> {
  const clientId = clientIdOverride || Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = clientSecretOverride || Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA client credentials');
  }

  if (!refreshToken) {
    throw new Error('Missing refresh token');
  }

  const response = await fetchWithRetry('https://api.amazon.com/auth/o2/token', {
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
    console.error('LWA token error:', errorText);
    throw new Error(`LWA token error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(path: string, accessToken: string, queryParams: Record<string, string> = {}): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('Missing AWS credentials');
  }

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const queryString = new URLSearchParams(queryParams).toString();
  const canonicalUri = path;
  const canonicalQueryString = queryString;
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalRequest);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const requestHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${queryString ? '?' + queryString : ''}`;
  
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      'Authorization': authorizationHeader,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('SP-API Error:', errorText);
    throw new Error(`SP-API request failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Fetch catalog item to get creation date and BSR
async function fetchCatalogItem(asin: string, accessToken: string, marketplaceId: string): Promise<{ createdDate: string | null; bsr: number | null }> {
  try {
    const result = await callSpApi(
      `/catalog/2022-04-01/items/${asin}`,
      accessToken,
      {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,salesRanks'
      }
    );
    
    // Extract creation date from summaries
    const summaries = result?.summaries || [];
    const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];
    
    // Extract BSR from salesRanks
    const salesRanks = result?.salesRanks || [];
    let bsr: number | null = null;
    
    // Find the display group sales rank (primary BSR)
    for (const rankSet of salesRanks) {
      if (rankSet.marketplaceId === marketplaceId) {
        // Prefer displayGroupRanks (main category BSR)
        if (rankSet.displayGroupRanks && rankSet.displayGroupRanks.length > 0) {
          bsr = rankSet.displayGroupRanks[0].rank;
          break;
        }
        // Fallback to classificationRanks (subcategory BSR)
        if (!bsr && rankSet.classificationRanks && rankSet.classificationRanks.length > 0) {
          bsr = rankSet.classificationRanks[0].rank;
        }
      }
    }
    
    return {
      createdDate: summary?.createdDate || null,
      bsr
    };
  } catch (error: any) {
    console.error(`Failed to fetch catalog item ${asin}:`, (error as Error).message);
    return { createdDate: null, bsr: null };
  }
}

// Fetch listing status for a SKU
async function fetchListingStatus(sellerId: string, sku: string, accessToken: string, marketplaceId: string): Promise<string> {
  try {
    const encodedSku = encodeURIComponent(sku);
    const result = await callSpApi(
      `/listings/2021-08-01/items/${sellerId}/${encodedSku}`,
      accessToken,
      {
        marketplaceIds: marketplaceId,
        includedData: 'summaries'
      }
    );
    
    // Extract status from summaries
    const summaries = result?.summaries || [];
    const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];
    
    // Status can be: ACTIVE, INACTIVE, INCOMPLETE, BUYABLE, DISCOVERABLE
    return summary?.status || 'unknown';
  } catch (error: any) {
    // 404 means listing doesn't exist or was deleted
    if ((error as Error).message?.includes('404')) {
      return 'NOT_FOUND';
    }
    console.error(`Failed to fetch listing status for SKU ${sku}:`, (error as Error).message);
    return 'unknown';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse body once up front so both the internal-call auth check and the
    // optional params below can use it.
    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch {
      // No body or invalid JSON — treat as empty
    }
    const fetchCreationDates = requestBody?.fetchCreationDates === true;

    // Auth: either a real user JWT, OR internal-secret + body.user_id (used
    // by amazon-oauth-callback's background sync for brand-new users, who
    // have no user session available server-side).
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedInternalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    let user: { id: string };

    if (internalSecret && expectedInternalSecret && internalSecret === expectedInternalSecret && requestBody?.user_id) {
      user = { id: requestBody.user_id };
      console.log(`[INTERNAL] Syncing Amazon inventory for user: ${user.id}`);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        throw new Error('No authorization header');
      }

      const { data: { user: fetchedUser }, error: authError } = await supabase.auth.getUser(
        authHeader.replace('Bearer ', '')
      );

      if (authError || !fetchedUser) {
        throw new Error('Unauthorized');
      }
      user = fetchedUser;
    }

    console.log(`Syncing Amazon inventory for user: ${user.id} (fetchCreationDates: ${fetchCreationDates})`);

    // Prefer per-user encrypted SP-API credentials (saved via the SP-API Connection page).
    // Fall back to global env vars only if the user has not connected their own account.
    let refreshToken: string | null = null;
    let lwaClientId: string | null = null;
    let lwaClientSecret: string | null = null;
    let sellerId: string | null = null;
    let marketplaceId: string = Deno.env.get('SPAPI_MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    let credSource = 'env';

    try {
      const { data: decRows, error: decErr } = await supabase.rpc(
        'get_spapi_credentials_decrypted',
        { p_user_id: user.id }
      );
      if (decErr) {
        console.warn(`[sync-amazon-inventory] decrypt error for ${user.id}: ${decErr.message}`);
      }
      const c = (decRows as any[])?.[0];
      if (c?.refresh_token) {
        refreshToken = c.refresh_token;
        lwaClientId = c.lwa_client_id || null;
        lwaClientSecret = c.lwa_client_secret || null;
        credSource = 'user';
        // Prefer the seller's own seller_id / marketplace if present
        if (c.seller_id) sellerId = c.seller_id;
        // Common column names — guard against either shape
        const userMarketplace = c.marketplace_id || c.default_marketplace_id;
        if (userMarketplace) marketplaceId = userMarketplace;
      }
    } catch (e: any) {
      console.warn(`[sync-amazon-inventory] per-user cred lookup failed: ${e?.message || e}`);
    }

    // Fallback to global env credentials
    if (!refreshToken) refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN') || null;
    if (!lwaClientId) lwaClientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID') || null;
    if (!lwaClientSecret) lwaClientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || null;
    if (!sellerId) sellerId = Deno.env.get('SPAPI_SELLER_ID') || null;

    if (!refreshToken) {
      throw new Error('No SP-API refresh token found. Reconnect your Amazon account in Tools → Amazon Connection.');
    }
    if (!sellerId) {
      throw new Error('No SP-API seller ID found. Reconnect your Amazon account in Tools → Amazon Connection.');
    }

    console.log(`[sync-amazon-inventory] Using ${credSource} credentials, marketplace=${marketplaceId}`);

    const accessToken = await getLwaAccessToken(refreshToken, lwaClientId, lwaClientSecret);
    const globalSellerId = sellerId;
    const globalMarketplaceId = marketplaceId;

    // Get inventory summaries from FBA Inventory API with full pagination
    // (marketplaceId already resolved above from per-user creds or env fallback)
    let nextToken: string | undefined;
    let allItems: any[] = [];
    let pageCount = 0;
    const maxPages = 200; // Safety limit (50 items/page => up to 10k items)

    do {
      const queryParams: Record<string, string> = {
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
        details: 'true'
      };

      if (nextToken) {
        queryParams.nextToken = nextToken;
      }

      console.log(`Fetching inventory page ${pageCount + 1} (nextToken: ${nextToken ? 'yes' : 'none'})`);
      
      const inventoryData = await callSpApi(
        '/fba/inventory/v1/summaries',
        accessToken,
        queryParams
      );

      const items = inventoryData?.payload?.inventorySummaries || [];
      allItems = allItems.concat(items);
      
      nextToken = inventoryData?.payload?.pagination?.nextToken;
      pageCount++;
      
      console.log(`Page ${pageCount}: fetched ${items.length} items, total so far: ${allItems.length}, hasMore: ${!!nextToken}`);
      
      // Small delay between pages to avoid rate limiting
      if (nextToken) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } while (nextToken && pageCount < maxPages);

    console.log(`Pagination complete. Total items fetched: ${allItems.length} across ${pageCount} pages`);

    // Process and upsert items into inventory table
    // KEY FIX: Use SKU (not ASIN) to determine existing vs new records
    // This allows multiple SKUs per ASIN (e.g., different conditions/offers)
    let processed = 0;
    let creationDatesUpdated = 0;
    let skipped = 0;
    const batchSize = 100;
    const now = new Date().toISOString();

    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize);
      
      // Filter out items with empty SKU - we can't upsert without a valid SKU
      const validItems = batch.filter(item => item.sellerSku && item.sellerSku.trim() !== '');
      const skippedInBatch = batch.length - validItems.length;
      skipped += skippedInBatch;
      
      if (skippedInBatch > 0) {
        console.log(`Skipped ${skippedInBatch} items with empty SKU in this batch`);
      }
      
      if (validItems.length === 0) continue;
      
      // Check which SKUs already exist (keyed by user_id + sku, NOT asin)
      const batchSkus = validItems.map(item => item.sellerSku).filter(Boolean);
      const { data: existingRecords } = await supabase
        .from('inventory')
        .select('sku, listing_status')
        .eq('user_id', user.id)
        .in('sku', batchSkus);
      
      const existingBySku = new Map((existingRecords || []).map(r => [r.sku, r]));
      
      // Separate into new records and existing records
      const newRecords: any[] = [];
      const updateRecords: any[] = [];
      
      for (const item of validItems) {
        const sku = item.sellerSku;
        const existing = existingBySku.get(sku);
        const currentListingStatus = String(existing?.listing_status || '').toUpperCase();
        const isManuallyRemovedGhost = currentListingStatus === 'NOT_IN_CATALOG' || currentListingStatus === 'DELETED';
        const inboundQty = (item.inventoryDetails?.inboundReceivingQuantity || 0) +
                           (item.inventoryDetails?.inboundShippedQuantity || 0);
        
        const available = item.inventoryDetails?.fulfillableQuantity || 0;
        const reserved = item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0;
        const unfulfilled = item.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity || 0;
        
        // Auto-determine status based on FBA inventory presence
        // IMPORTANT: The FBA Inventory API can lag after a listing is removed from catalog.
        // If the row was explicitly marked NOT_IN_CATALOG/DELETED by verification, do NOT
        // resurrect it from this inventory-only sync. Let the full listing/report sync revive
        // it only if Amazon explicitly reports the SKU again.
        const derivedStatus = 'ACTIVE';

        if (isManuallyRemovedGhost) {
          console.log(`[sync-amazon-inventory] Skipping manually removed ghost SKU ${sku} (status=${currentListingStatus})`);
          continue;
        }
        
        if (existing) {
          // Only update quantity fields for existing records (keyed by SKU)
          updateRecords.push({
            asin: item.asin || '',
            sku: sku,
            fnsku: item.fnSku || null,
            available: available,
            reserved: reserved,
            inbound: inboundQty,
            unfulfilled: unfulfilled,
            listing_status: derivedStatus,
            last_inventory_sync_at: now,
            last_summaries_at: now,
          });
        } else {
          // Full record for new items (new SKU, even if ASIN already exists)
          newRecords.push({
            user_id: user.id,
            asin: item.asin || '',
            sku: sku,
            fnsku: item.fnSku || null,
            title: item.productName || 'Unknown Product',
            available: available,
            reserved: reserved,
            inbound: inboundQty,
            unfulfilled: unfulfilled,
            source: 'amazon_sync',
            listing_status: derivedStatus,
            last_inventory_sync_at: now,
            last_summaries_at: now,
          });
        }
      }
      
      // Insert new records using upsert with conflict on (user_id, sku)
      if (newRecords.length > 0) {
        const { error: upsertError } = await supabase
          .from('inventory')
          .upsert(newRecords, { 
            onConflict: 'user_id,sku',
            ignoreDuplicates: false 
          });
        
        if (upsertError) {
          console.error('Upsert error for new records:', upsertError);
        } else {
          processed += newRecords.length;
        }
      }
      
      // Update existing records by SKU (to preserve user-edited fields like cost)
      for (const record of updateRecords) {
        const { error: updateError } = await supabase
          .from('inventory')
          .update({
            asin: record.asin,
            fnsku: record.fnsku,
            available: record.available,
            reserved: record.reserved,
            inbound: record.inbound,
            unfulfilled: record.unfulfilled,
            listing_status: record.listing_status,
            last_inventory_sync_at: record.last_inventory_sync_at,
            last_summaries_at: record.last_inventory_sync_at,
          })
          .eq('user_id', user.id)
          .eq('sku', record.sku)
          .not('listing_status', 'in', '("NOT_IN_CATALOG","DELETED")');
        
        if (updateError) {
          console.error(`Update error for SKU ${record.sku}:`, updateError);
        } else {
          processed++;
        }
      }

      console.log(`Batch progress: ${processed}/${allItems.length} items (${newRecords.length} new, ${updateRecords.length} updated, ${skipped} skipped)`);
    }

    // ALWAYS fetch listing status for items with unknown status (critical for repricer)
    // Also fetch creation dates and BSR when fetchCreationDates is true
    let bsrUpdated = 0;
    let statusUpdated = 0;
    
    console.log('Checking for items with unknown listing status...');
    
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // First, get ASINs with recent sales to prioritize them
    const { data: recentSalesAsins } = await supabase
      .from('sales_orders')
      .select('asin')
      .eq('user_id', user.id)
      .gte('order_date', thirtyDaysAgo)
      .neq('asin', 'PENDING');
    
    const salesAsinSet = new Set((recentSalesAsins || []).map(r => r.asin));
    console.log(`Found ${salesAsinSet.size} unique ASINs with recent sales`);
    
    // Priority 1: Items with unknown/null status (ALWAYS process these)
    const { data: unknownStatusItems } = await supabase
      .from('inventory')
      .select('id, asin, sku, listing_created_at, bsr, last_bsr_sync_at, listing_status')
      .eq('user_id', user.id)
      .or('listing_status.eq.unknown,listing_status.is.null')
      .limit(100);
    
    // Priority 2: Items needing BSR update (only if fetchCreationDates is true)
    let bsrItems: any[] = [];
    if (fetchCreationDates) {
      const { data } = await supabase
        .from('inventory')
        .select('id, asin, sku, listing_created_at, bsr, last_bsr_sync_at, listing_status')
        .eq('user_id', user.id)
        .or(`listing_created_at.is.null,bsr.is.null,last_bsr_sync_at.is.null,last_bsr_sync_at.lt.${oneDayAgo}`)
        .not('listing_status', 'in', '(unknown)')
        .limit(50);
      bsrItems = data || [];
    }
    
    // Combine and deduplicate by ID
    const allItemsToUpdate = [...(unknownStatusItems || [])];
    const processedIds = new Set(allItemsToUpdate.map(i => i.id));
    for (const item of bsrItems) {
      if (!processedIds.has(item.id)) {
        allItemsToUpdate.push(item);
        processedIds.add(item.id);
      }
    }
    
    if (allItemsToUpdate.length > 0) {
      // Sort items: prioritize unknown status first, then those with recent sales
      const sortedItems = allItemsToUpdate.sort((a, b) => {
        // First priority: unknown status items
        const aUnknown = !a.listing_status || a.listing_status === 'unknown' ? 1 : 0;
        const bUnknown = !b.listing_status || b.listing_status === 'unknown' ? 1 : 0;
        if (aUnknown !== bUnknown) return bUnknown - aUnknown;
        
        // Second priority: items with sales
        const aHasSales = salesAsinSet.has(a.asin) ? 1 : 0;
        const bHasSales = salesAsinSet.has(b.asin) ? 1 : 0;
        return bHasSales - aHasSales;
      }).slice(0, 75); // Process up to 75 items per sync
      
      console.log(`Processing ${sortedItems.length} items for status/BSR updates (prioritizing unknown status)`);
      
      for (const item of sortedItems) {
        try {
          const updateData: any = {};
          const needsStatus = !item.listing_status || item.listing_status === 'unknown';
          const needsBsr = fetchCreationDates && (!item.bsr || !item.last_bsr_sync_at || item.last_bsr_sync_at < oneDayAgo);
          
          // Fetch listing status for items with unknown status
          if (needsStatus) {
            const listingStatus = await fetchListingStatus(globalSellerId, item.sku, accessToken, marketplaceId);
            if (listingStatus && listingStatus !== 'unknown') {
              updateData.listing_status = listingStatus;
              statusUpdated++;
            }
          }
          
          // Fetch catalog data (creation date + BSR) when requested
          if (needsBsr) {
            const catalogData = await fetchCatalogItem(item.asin, accessToken, marketplaceId);
            updateData.last_bsr_sync_at = now;
            
            if (catalogData.createdDate && !item.listing_created_at) {
              updateData.listing_created_at = catalogData.createdDate;
              creationDatesUpdated++;
            }
            
            if (catalogData.bsr !== null) {
              updateData.bsr = catalogData.bsr;
              bsrUpdated++;
            }
          }
          
          if (Object.keys(updateData).length > 0) {
            await supabase
              .from('inventory')
              .update(updateData)
              .eq('id', item.id);
          }
          
          // Rate limit: 400ms between API calls
          await new Promise(resolve => setTimeout(resolve, 400));
        } catch (error: any) {
          console.error(`Error fetching data for ${item.asin}:`, (error as Error).message);
        }
      }
      
      console.log(`Updated: ${creationDatesUpdated} creation dates, ${bsrUpdated} BSR values, ${statusUpdated} statuses`);
    } else {
      console.log('All items have valid listing status');
    }

    // ─── Multi-Marketplace Assignment Sync (CA, MX, BR) ───
    // Amazon NA uses unified FBA inventory — the FBA Inventory API for BR/MX returns
    // 0 items because stock is in US warehouses. Instead, we check which SKUs have
    // active listings in international marketplaces via the Listings API and create
    // repricer assignments for them.
    const internationalMarketplaces: Record<string, string> = {
      'A2EUQ1WTGCTBG2': 'CA',
      'A1AM78C64UM0Y8': 'MX',
      'A2Q3Y263D00KWC': 'BR',
    };
    let intlAssignmentsCreated = 0;

    try {
      // Check which marketplaces this user has authorized
      const { data: authorizations } = await supabase
        .from('seller_authorizations')
        .select('marketplace_id')
        .eq('user_id', user.id);

      const authorizedIntlMarketplaces = (authorizations || [])
        .map(a => a.marketplace_id)
        .filter(mid => mid in internationalMarketplaces);

      if (authorizedIntlMarketplaces.length > 0) {
        console.log(`Checking international listings for: ${authorizedIntlMarketplaces.map(m => internationalMarketplaces[m]).join(', ')}`);

        // Get all US inventory SKUs with stock (candidates for intl listings)
        const candidateItems = allItems.filter(item => {
          const sku = item.sellerSku;
          if (!sku || !sku.trim()) return false;
          const available = item.inventoryDetails?.fulfillableQuantity || 0;
          const reserved = item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0;
          const inboundQty = (item.inventoryDetails?.inboundReceivingQuantity || 0) +
                             (item.inventoryDetails?.inboundShippedQuantity || 0);
          return (available + reserved + inboundQty) > 0;
        });

        console.log(`${candidateItems.length} US items with stock, checking listings in intl marketplaces`);

        for (const mktId of authorizedIntlMarketplaces) {
          const mktLabel = internationalMarketplaces[mktId];
          try {
            // Get existing repricer assignments for this marketplace
            const candidateSkus = candidateItems.map(i => i.sellerSku);
            const { data: existingAssignments } = await supabase
              .from('repricer_assignments')
              .select('sku')
              .eq('user_id', user.id)
              .eq('marketplace', mktLabel)
              .in('sku', candidateSkus.slice(0, 500));

            const existingIntlSkus = new Set((existingAssignments || []).map(r => r.sku));

            // Filter to items that don't have an assignment yet
            const needsCheck = candidateItems.filter(i => !existingIntlSkus.has(i.sellerSku));

            if (needsCheck.length === 0) {
              console.log(`${mktLabel}: all items already have assignments`);
              continue;
            }

            // Check listing status via Listings API for items without assignments
            // Process in batches to respect rate limits (max 30 per marketplace per sync)
            const toCheck = needsCheck.slice(0, 30);
            const newAssignments: any[] = [];

            for (const item of toCheck) {
              try {
                const listingStatus = await fetchListingStatus(globalSellerId, item.sellerSku, accessToken, mktId);
                
                // Create assignment if listing is active/buyable in this marketplace
                if (listingStatus === 'ACTIVE' || listingStatus === 'BUYABLE' || listingStatus === 'DISCOVERABLE') {
                  newAssignments.push({
                    user_id: user.id,
                    asin: item.asin || '',
                    sku: item.sellerSku,
                    marketplace: mktLabel,
                    is_enabled: false,
                  });
                  console.log(`${mktLabel}: ${item.sellerSku} (${item.asin}) → ${listingStatus} ✓`);
                }
                
                // Rate limit: 400ms between Listings API calls
                await new Promise(r => setTimeout(r, 400));
              } catch (checkErr: any) {
                console.error(`${mktLabel}: error checking ${item.sellerSku}:`, checkErr.message);
              }
            }

            if (newAssignments.length > 0) {
              for (let b = 0; b < newAssignments.length; b += 100) {
                const chunk = newAssignments.slice(b, b + 100);
                const { error: upsertErr } = await supabase
                  .from('repricer_assignments')
                  .upsert(chunk, { onConflict: 'user_id,sku,marketplace', ignoreDuplicates: true });

                if (upsertErr) {
                  console.error(`${mktLabel} assignment upsert error:`, upsertErr);
                } else {
                  intlAssignmentsCreated += chunk.length;
                }
              }
              console.log(`${mktLabel}: created ${newAssignments.length} repricer assignments`);
            } else {
              console.log(`${mktLabel}: no active listings found for unchecked items`);
            }

            // Rate limit between marketplaces
            await new Promise(r => setTimeout(r, 500));
          } catch (mktErr: any) {
            console.error(`Error syncing ${mktLabel}:`, mktErr.message);
          }
        }
      } else {
        console.log('No international marketplace authorizations found, skipping');
      }
    } catch (intlErr: any) {
      console.error('International marketplace sync error:', intlErr.message);
    }

    // Enrich missing titles after sync
    let titlesEnriched = 0;
    let assignmentBackfillCreated = 0;
    let assignmentBackfillReenabled = 0;
    try {
      console.log('Calling enrich-missing-titles to fix placeholder titles...');
      const enrichResponse = await fetch(`${supabaseUrl}/functions/v1/enrich-missing-titles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify({ internal: true, user_id: user.id, limit: 50 })
      });
      
      if (enrichResponse.ok) {
        const enrichResult = await enrichResponse.json();
        titlesEnriched = enrichResult.enriched || 0;
        console.log(`Title enrichment complete: ${titlesEnriched} titles updated`);
      } else {
        console.warn('Title enrichment failed:', await enrichResponse.text());
      }
    } catch (enrichError: any) {
      console.warn('Title enrichment error:', enrichError.message);
    }

    try {
      console.log('Calling auto-assign-bulk to backfill missing US assignments...');
      const assignResponse = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ user_id: user.id, marketplace: 'US' })
      });

      if (assignResponse.ok) {
        const assignResult = await assignResponse.json();
        assignmentBackfillCreated = assignResult.created || 0;
        assignmentBackfillReenabled = assignResult.reenabled || 0;
        console.log(`Assignment backfill complete: created=${assignmentBackfillCreated}, reenabled=${assignmentBackfillReenabled}`);
      } else {
        console.warn('Assignment backfill failed:', await assignResponse.text());
      }
    } catch (assignError: any) {
      console.warn('Assignment backfill error:', assignError.message);
    }

    // Brands are a PROJECTION of inventory, so they are refreshed where
    // inventory changes rather than on a schedule of their own -- anywhere
    // else and the two drift.
    //
    // Nothing called this before today. refresh_user_brands() is SECURITY
    // INVOKER and needs auth.uid(), which a service-role job does not have, so
    // every brand list in the database had been filled by hand. That is why a
    // new account looked as though it needed someone else's brands: its own
    // were derivable from its own stock all along, and simply never derived.
    //
    // Non-fatal on purpose. A failed brand refresh must not fail an inventory
    // sync that otherwise succeeded; the next sync retries it.
    try {
      const { data: brandRows, error: brandErr } = await supabase
        .rpc('refresh_user_brands_for', { p_user: user.id });
      if (brandErr) {
        console.warn('Brand refresh failed:', brandErr.message);
      } else {
        console.log(`Brand refresh complete: ${brandRows ?? 0} rows`);
      }
    } catch (brandError: any) {
      console.warn('Brand refresh error:', brandError.message);
    }

    // Trigger full merchant listings sync to capture ALL active listings (FBA + FBM)
    // This ensures the inventory table includes items the FBA Inventory API doesn't return
    let merchantListingsCount = 0;
    try {
      console.log('Triggering sync-inventory-report to capture all active listings...');
      const reportResponse = await fetch(`${supabaseUrl}/functions/v1/sync-inventory-report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({ fullSync: true })
      });

      if (reportResponse.ok) {
        const reportResult = await reportResponse.json();
        merchantListingsCount = (reportResult.fbmUpdated || 0) + (reportResult.fbmInserted || 0);
        console.log(`Merchant listings sync complete: ${merchantListingsCount} items processed`);
      } else {
        console.warn('Merchant listings sync failed:', await reportResponse.text());
      }
    } catch (reportError: any) {
      console.warn('Merchant listings sync error:', reportError.message);
    }

    console.log(`Sync complete: ${processed}/${allItems.length} US items processed, ${skipped} skipped, ${intlAssignmentsCreated} intl assignments created, ${assignmentBackfillCreated} US assignments backfilled, ${merchantListingsCount} merchant listings synced`);

    return new Response(
      JSON.stringify({
        success: true,
        totalItems: allItems.length,
        processed,
        skipped,
        creationDatesUpdated,
        bsrUpdated,
        statusUpdated,
        titlesEnriched,
        intlAssignmentsCreated,
        assignmentBackfillCreated,
        assignmentBackfillReenabled,
        merchantListingsCount,
        pages: pageCount
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
