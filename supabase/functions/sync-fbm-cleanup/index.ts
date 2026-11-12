import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { gunzip } from "https://deno.land/x/compress@v0.4.5/gzip/mod.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { requireInternalCall } from "../_shared/internal-call-auth.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');
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

  if (!response.ok) throw new Error(`LWA token error: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  method: string, path: string, accessToken: string,
  queryParams: Record<string, string> = {}, body?: string, maxRetries = 3
): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('Missing AWS credentials');

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const queryString = new URLSearchParams(queryParams).toString();
    const payloadHash = body
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))).map(b => b.toString(16).padStart(2, '0')).join('')
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const headers: Record<string, string> = { 'host': host, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken };
    if (body) headers['content-type'] = 'application/json';

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');
    const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))).map(b => b.toString(16).padStart(2, '0')).join('');
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${requestHash}`;
    const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
    const signature = getAwsSignature(stringToSign, signingKey);
    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
    const response = await fetch(url, { method, headers: { ...headers, 'Authorization': authorizationHeader }, ...(body ? { body } : {}) });
    if (response.ok) return await response.json();

    const errorText = await response.text();
    if (response.status === 429 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 5000 * Math.pow(2, attempt - 1)));
      continue;
    }
    if (response.status === 503 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 10000 * attempt));
      continue;
    }
    throw new Error(`SP-API request failed: ${response.status} - ${errorText}`);
  }
  throw new Error('SP-API request failed after max retries');
}

function normalizeReportHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/^"+|"+$/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeReportHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeReportHeader(header)));
}

function parseReportLines(reportText: string): { lines: string[]; headers: string[] } {
  const normalizedText = reportText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedText.split('\n').map((line) => line.replace(/\u0000/g, '').trimEnd()).filter((line) => line.length > 0);
  const headers = (lines[0] || '').split('\t').map((header) => header.trim());
  return { lines, headers };
}

async function downloadReportText(documentUrl: string, compressionAlgorithm?: string): Promise<string> {
  const reportResponse = await fetch(documentUrl);
  if (!reportResponse.ok) throw new Error(`Failed to download report: ${reportResponse.status}`);
  if ((compressionAlgorithm || '').toUpperCase() === 'GZIP') {
    const compressedData = new Uint8Array(await reportResponse.arrayBuffer());
    const decompressed = gunzip(compressedData);
    return new TextDecoder().decode(decompressed);
  }
  return await reportResponse.text();
}

interface ExistingRecord {
  id: string;
  asin: string;
  sku: string;
  listing_status?: string | null;
  source?: string | null;
}

interface AuthoritativeFbaState {
  listingStatus: string;
  source: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Scheduled job only -- there is no user-facing path here, and this function
  // writes. Its pg_cron job sends x-internal-secret (verified against cron.job
  // before this check was added, because a check a job cannot satisfy kills
  // the job while pg_cron still reports success -- the trap in CLAUDE.md).
  //
  // verify_jwt stays FALSE in config.toml on purpose: pg_cron sends no
  // Authorization header, so the platform gateway would reject the call before
  // this function ran. That is exactly why the check has to live here.
  {
    const refusal = requireInternalCall(req, corsHeaders, 'sync-fbm-cleanup');
    if (refusal) return refusal;
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    let {
      user_id: userId,
      refresh_token: refreshToken,
      marketplace_id: marketplaceId,
      existing_records_map: existingRecordsMapArr,
      authoritative_fba_state: authoritativeFbaStateArr,
      fba_reported_skus: fbaReportedSkus,
      all_inserts: allInserts,
      non_destructive_sync: nonDestructiveSync,
      triggered_by: triggeredBy,
    } = body as {
      user_id: string;
      refresh_token?: string;
      marketplace_id?: string;
      existing_records_map?: Array<{ id: string; asin: string; sku: string; listing_status?: string | null; source?: string | null }>;
      authoritative_fba_state?: Array<{ sku: string; listingStatus: string; source: string }>;
      fba_reported_skus?: string[];
      all_inserts?: any[];
      non_destructive_sync?: boolean;
      triggered_by?: string;
    };

    if (!userId) throw new Error('Missing user_id');

    // Standalone mode: when called without parent FBA context, bootstrap
    // refresh token + existing inventory map directly from the DB so this
    // function can run independently from a dedicated cron / fan-out.
    const isStandalone = !fbaReportedSkus || !existingRecordsMapArr;
    if (isStandalone) {
      console.log(`[FBM_SYNC] Standalone mode for user=${userId}`);
      // Default to US marketplace (FBM listings tool is US-only)
      if (!marketplaceId) marketplaceId = 'ATVPDKIKX0DER';
      if (!refreshToken) {
        const { data: auth } = await supabase
          .from('seller_authorizations')
          .select('refresh_token')
          .eq('user_id', userId)
          .eq('marketplace_id', marketplaceId)
          .eq('is_active', true)
          .maybeSingle();
        refreshToken = auth?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN') || '';
      }
      if (!refreshToken) throw new Error('No SP-API refresh token for user');

      // Load ALL existing inventory rows for this user (paged) to build map
      existingRecordsMapArr = [];
      let _from = 0;
      while (true) {
        const { data: page } = await supabase
          .from('inventory')
          .select('id, asin, sku, listing_status, source')
          .eq('user_id', userId)
          .range(_from, _from + 999);
        if (!page?.length) break;
        for (const r of page) existingRecordsMapArr.push(r as any);
        if (page.length < 1000) break;
        _from += 1000;
      }
      authoritativeFbaStateArr = [];
      fbaReportedSkus = []; // standalone: no FBA cleanup pass
      nonDestructiveSync = nonDestructiveSync ?? true;
    }

    // Open observability run
    const runStart = Date.now();
    const { data: runRow } = await supabase.from('fbm_sync_runs').insert({
      user_id: userId,
      triggered_by: triggeredBy || (isStandalone ? 'standalone' : 'sync-inventory-report'),
      status: 'running',
    }).select('id').single();
    const runId = runRow?.id || null;

    const accessToken = await getLwaAccessToken(refreshToken!);
    const now = new Date().toISOString();
    const batchSize = 200;

    // Rebuild maps from serialized data
    const existingRecordsMap = new Map<string, ExistingRecord>();
    for (const r of (existingRecordsMapArr || [])) {
      existingRecordsMap.set(r.sku, r);
    }
    const authoritativeFbaStateBySku = new Map<string, AuthoritativeFbaState>();
    for (const s of (authoritativeFbaStateArr || [])) {
      authoritativeFbaStateBySku.set(s.sku, { listingStatus: s.listingStatus, source: s.source });
    }
    const fbaReportedSkuSet = new Set(fbaReportedSkus || []);

    // ============================================================
    // FBM Sync: GET_MERCHANT_LISTINGS_ALL_DATA
    // ============================================================
    let fbmUpdatedCount = 0;
    let fbmInsertedCount = 0;
    const fbmReportedSkus = new Set<string>();

    try {
      await waitForApiToken(supabase, 'reports_create_api');
      const fbmCreateResponse = await callSpApi('POST', '/reports/2021-06-30/reports', accessToken, {}, JSON.stringify({
        reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
        marketplaceIds: [marketplaceId],
      }));

      const fbmReportId = fbmCreateResponse.reportId;
      console.log(`[FBM_SYNC] FBM report requested, ID: ${fbmReportId}`);

      let fbmStatus = 'IN_QUEUE';
      let fbmPolls = 0;
      let fbmReportDocumentId: string | null = null;

      while (fbmStatus !== 'DONE' && fbmStatus !== 'FATAL' && fbmStatus !== 'CANCELLED' && fbmPolls < 60) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        await waitForApiToken(supabase, 'reports_poll_api');
        const statusResponse = await callSpApi('GET', `/reports/2021-06-30/reports/${fbmReportId}`, accessToken);
        fbmStatus = statusResponse.processingStatus;
        fbmReportDocumentId = statusResponse.reportDocumentId || null;
        fbmPolls++;
      }

      if (fbmStatus === 'DONE' && fbmReportDocumentId) {
        await waitForApiToken(supabase, 'reports_poll_api');
        const fbmDocResponse = await callSpApi('GET', `/reports/2021-06-30/documents/${fbmReportDocumentId}`, accessToken);
        const fbmText = await downloadReportText(fbmDocResponse.url, fbmDocResponse.compressionAlgorithm);
        const { lines: fbmLines, headers: fbmHeaders } = parseReportLines(fbmText);

        if (fbmLines.length > 1) {
          const mlSkuIndex = findHeaderIndex(fbmHeaders, ['seller-sku', 'seller sku', 'sku']);
          const mlAsinIndex = findHeaderIndex(fbmHeaders, ['asin1', 'asin']);
          const mlTitleIndex = findHeaderIndex(fbmHeaders, ['item-name', 'item name', 'product-name', 'product name', 'title']);
          const mlPriceIndex = findHeaderIndex(fbmHeaders, ['price', 'your-price']);
          const mlQuantityIndex = findHeaderIndex(fbmHeaders, ['quantity', 'available']);
          const mlFulfillmentIndex = findHeaderIndex(fbmHeaders, ['fulfillment-channel', 'fulfillment channel']);
          const mlImageIndex = findHeaderIndex(fbmHeaders, ['image-url', 'image url']);
          const mlStatusIndex = findHeaderIndex(fbmHeaders, ['status']);

          if (mlSkuIndex !== -1 && mlAsinIndex !== -1) {
            const fbmRows: Array<{ sku: string; asin: string; title: string; price: number | null; qty: number; image_url: string | null; isFba: boolean; reportStatus: string }> = [];

            for (let i = 1; i < fbmLines.length; i++) {
              const cols = fbmLines[i].split('\t');
              if (cols.length < 3) continue;
              const sku = (cols[mlSkuIndex] || '').trim();
              const asin = (cols[mlAsinIndex] || '').trim();
              const fulfillment = mlFulfillmentIndex !== -1 ? (cols[mlFulfillmentIndex] || '').trim() : '';
              const reportStatus = mlStatusIndex !== -1 ? (cols[mlStatusIndex] || '').trim() : '';
              if (!sku || !asin) continue;

              fbmRows.push({
                sku, asin,
                title: mlTitleIndex !== -1 ? ((cols[mlTitleIndex] || '').trim() || 'Unknown Product') : 'Unknown Product',
                price: mlPriceIndex !== -1 ? (parseFloat(cols[mlPriceIndex]) || null) : null,
                qty: mlQuantityIndex !== -1 ? (parseInt(cols[mlQuantityIndex]) || 0) : 0,
                image_url: mlImageIndex !== -1 ? ((cols[mlImageIndex] || '').trim() || null) : null,
                isFba: fulfillment.toUpperCase().includes('AMAZON'),
                reportStatus: reportStatus.toLowerCase(),
              });
            }

            console.log(`[FBM_SYNC] Parsed ${fbmRows.length} rows (FBA: ${fbmRows.filter(r => r.isFba).length}, FBM: ${fbmRows.filter(r => !r.isFba).length})`);

            for (const row of fbmRows) fbmReportedSkus.add(row.sku);

            const fbmUpdates: any[] = [];
            const fbmInserts: any[] = [];

            for (const row of fbmRows) {
              const existing = existingRecordsMap.get(row.sku);
              const existingListingStatus = String(existing?.listing_status || '').toUpperCase();
              const isTombstonedGhost = existingListingStatus === 'NOT_IN_CATALOG' || existingListingStatus === 'DELETED';
              const authoritativeFbaState = row.isFba ? authoritativeFbaStateBySku.get(row.sku) : null;
              let listingStatus: string;
              if (row.reportStatus === 'active') listingStatus = 'ACTIVE';
              else if (row.reportStatus === 'inactive' || row.reportStatus === 'incomplete') listingStatus = 'INACTIVE';
              else listingStatus = (row.qty > 0 || row.isFba) ? 'ACTIVE' : 'INACTIVE';
              if (authoritativeFbaState) listingStatus = authoritativeFbaState.listingStatus;

              if (isTombstonedGhost) {
                console.log(`[FBM_SYNC] Preserving tombstoned ghost ${row.asin}/${row.sku} (status=${existingListingStatus}) — skipping FBM overwrite`);
                continue;
              }

              if (existing) {
                if (row.isFba) {
                  fbmUpdates.push({
                    id: existing.id, sku: row.sku, asin: row.asin, title: row.title,
                    ...(row.image_url ? { image_url: row.image_url } : {}),
                    listing_status: listingStatus, isFba: true,
                  });
                } else {
                  fbmUpdates.push({
                    id: existing.id, sku: row.sku, asin: row.asin, title: row.title,
                    price: row.price,
                    ...(row.image_url ? { image_url: row.image_url } : {}),
                    available: row.qty, listing_status: listingStatus, isFba: false,
                  });
                }
              } else {
                fbmInserts.push({
                  user_id: userId, asin: row.asin, sku: row.sku, fnsku: null,
                  title: row.title, price: row.isFba ? null : row.price,
                  image_url: row.image_url,
                  available: row.isFba ? 0 : row.qty, reserved: 0, inbound: 0, unfulfilled: 0,
                  source: row.isFba ? (authoritativeFbaState?.source || 'amazon_sync') : 'amazon_sync_fbm',
                  listing_status: listingStatus, last_inventory_sync_at: now,
                });
              }
            }

            // Bulk upsert FBA metadata
            const fbaMetadataUpdates = fbmUpdates.filter(u => u.isFba).map(upd => ({
              id: upd.id, user_id: userId, asin: upd.asin, sku: upd.sku, title: upd.title,
              ...(upd.image_url ? { image_url: upd.image_url } : {}),
              listing_status: upd.listing_status, last_inventory_sync_at: now,
            }));
            const fbmStockUpdates = fbmUpdates.filter(u => !u.isFba).map(upd => ({
              id: upd.id, user_id: userId, asin: upd.asin, sku: upd.sku, title: upd.title,
              price: upd.price,
              ...(upd.image_url ? { image_url: upd.image_url } : {}),
              fnsku: null, available: upd.available, reserved: 0, inbound: 0,
              listing_status: upd.listing_status, source: 'amazon_sync_fbm', last_inventory_sync_at: now,
            }));

            for (let i = 0; i < fbaMetadataUpdates.length; i += batchSize) {
              const batch = fbaMetadataUpdates.slice(i, i + batchSize);
              const { error } = await supabase.from('inventory').upsert(batch, { onConflict: 'id' });
              if (!error) fbmUpdatedCount += batch.length;
              else console.error('[FBM_SYNC] FBA metadata batch error:', (error as Error).message);
            }
            for (let i = 0; i < fbmStockUpdates.length; i += batchSize) {
              const batch = fbmStockUpdates.slice(i, i + batchSize);
              const { error } = await supabase.from('inventory').upsert(batch, { onConflict: 'id' });
              if (!error) fbmUpdatedCount += batch.length;
              else console.error('[FBM_SYNC] FBM stock batch error:', (error as Error).message);
            }
            for (let i = 0; i < fbmInserts.length; i += batchSize) {
              const batch = fbmInserts.slice(i, i + batchSize);
              const { error } = await supabase.from('inventory').upsert(batch, { onConflict: 'user_id,sku', ignoreDuplicates: false });
              if (!error) fbmInsertedCount += batch.length;
              else {
                for (const item of batch) {
                  const { error: singleErr } = await supabase.from('inventory').upsert(item, { onConflict: 'user_id,sku', ignoreDuplicates: false });
                  if (!singleErr) fbmInsertedCount++;
                }
              }
            }
          }
        }
      } else {
        console.warn(`[FBM_SYNC] FBM report not completed (status=${fbmStatus})`);
      }
    } catch (fbmErr) {
      console.error('[FBM_SYNC] FBM sync failed (continuing):', fbmErr);
    }

    // ============================================================
    // Cleanup: Remove deleted listings
    // ============================================================
    let deletedFromInventory = 0;
    let deletedFromRepricer = 0;

    try {
      // In standalone mode we cannot trust the absence of an FBA SKU from the
      // FBM report (this report only lists merchant listings + a duplicated FBA
      // mirror). To avoid mass-deleting real FBA rows, restrict the orphan
      // check to FBM rows when standalone.
      const amazonReportedSkus = new Set<string>([...fbaReportedSkuSet, ...fbmReportedSkus]);
      console.log(`[FBM_SYNC] Total reported SKUs for cleanup: ${amazonReportedSkus.size} (standalone=${isStandalone})`);

      const localSkusToCheck: { id: string; sku: string; asin: string }[] = [];
      let checkFrom = 0;
      while (true) {
        const { data: batch } = await supabase.from('inventory').select('id, sku, asin, source, listing_status').eq('user_id', userId).range(checkFrom, checkFrom + 999);
        if (!batch?.length) break;
        for (const r of batch) {
          const listingStatus = String(r.listing_status || '').toUpperCase();
          const sourceMatch = isStandalone
            ? r.source === 'amazon_sync_fbm'
            : (r.source === 'amazon_sync' || r.source === 'amazon_sync_fbm');
          if (sourceMatch && listingStatus !== 'NOT_IN_CATALOG' && listingStatus !== 'DELETED') {
            localSkusToCheck.push({ id: r.id, sku: r.sku, asin: r.asin });
          }
        }
        if (batch.length < 1000) break;
        checkFrom += 1000;
      }

      const orphanedItems = localSkusToCheck.filter(item => !amazonReportedSkus.has(item.sku));

      if (nonDestructiveSync && orphanedItems.length > 0) {
        console.warn(`[FBM_SYNC] NON-DESTRUCTIVE GUARD: ${orphanedItems.length} missing SKUs would be deleted — preserving for review`);
      } else if (orphanedItems.length > 0 && orphanedItems.length < localSkusToCheck.length * 0.5) {
        console.log(`[FBM_SYNC] Found ${orphanedItems.length} deleted listings to clean up`);
        const orphanedSkus = orphanedItems.map(i => i.sku);
        const orphanedIds = orphanedItems.map(i => i.id);

        for (let i = 0; i < orphanedSkus.length; i += 100) {
          const batch = orphanedSkus.slice(i, i + 100);
          const { data: deleted } = await supabase.from('repricer_assignments').delete().eq('user_id', userId).in('sku', batch).select('id');
          deletedFromRepricer += deleted?.length || 0;
        }
        // SOFT-DELETE: tombstone instead of physical delete so the user can
        // review ghost ASINs later (Show Ghost ASINs in Synced Inventory).
        const nowIso = new Date().toISOString();
        for (let i = 0; i < orphanedIds.length; i += 100) {
          const batch = orphanedIds.slice(i, i + 100);
          const { error: delErr } = await supabase
            .from('inventory')
            .update({
              listing_status: 'DELETED',
              ghost_reason: 'fbm_orphaned_in_amazon_report',
              ghosted_at: nowIso,
              ghost_source: 'sync-fbm-cleanup',
              deleted_reason: 'SKU no longer present in Amazon FBM merchant listings report',
            })
            .in('id', batch);
          if (!delErr) deletedFromInventory += batch.length;
        }
        console.log(`[FBM_SYNC] Soft-deleted: ${deletedFromInventory} inventory rows tombstoned, ${deletedFromRepricer} repricer assignments removed`);
      } else if (orphanedItems.length >= localSkusToCheck.length * 0.5) {
        console.warn(`[FBM_SYNC] SAFETY: ${orphanedItems.length}/${localSkusToCheck.length} items would be deleted — skipping (>50%)`);
      }
    } catch (cleanupErr: any) {
      console.warn('[FBM_SYNC] Cleanup failed (continuing):', cleanupErr.message);
    }

    // ============================================================
    // Enrich FBM items missing images via Catalog API
    // ============================================================
    let enrichedCount = 0;
    try {
      const { data: fbmMissingImages } = await supabase.from('inventory').select('id, asin').eq('user_id', userId).eq('source', 'amazon_sync_fbm').is('image_url', null).limit(100);

      if (fbmMissingImages && fbmMissingImages.length > 0) {
        console.log(`[FBM_SYNC] Enriching ${fbmMissingImages.length} FBM items missing images`);
        for (let i = 0; i < fbmMissingImages.length; i += 5) {
          const batch = fbmMissingImages.slice(i, i + 5);
          for (const item of batch) {
            try {
              const catalogResponse = await callSpApi('GET', `/catalog/2022-04-01/items/${item.asin}`, accessToken, {
                marketplaceIds: marketplaceId, includedData: 'images,summaries',
              });
              let imageUrl: string | null = null;
              let title: string | null = null;
              if (catalogResponse.images) {
                for (const imageSet of catalogResponse.images) {
                  if (imageSet.images?.length > 0) {
                    const mainImage = imageSet.images.find((img: any) => img.variant === 'MAIN') || imageSet.images[0];
                    if (mainImage?.link) { imageUrl = mainImage.link; break; }
                  }
                }
              }
              if (catalogResponse.summaries?.length > 0) title = catalogResponse.summaries[0].itemName || null;
              if (imageUrl || title) {
                const updateData: any = {};
                if (imageUrl) updateData.image_url = imageUrl;
                if (title) updateData.title = title;
                await supabase.from('inventory').update(updateData).eq('id', item.id);
                enrichedCount++;
              }
            } catch (catalogErr: any) {
              console.warn(`[FBM_SYNC] Could not enrich ASIN ${item.asin}:`, catalogErr.message);
            }
          }
          if (i + 5 < fbmMissingImages.length) await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[FBM_SYNC] Enriched ${enrichedCount} FBM items`);
      }
    } catch (enrichErr) {
      console.warn('[FBM_SYNC] FBM enrichment failed (continuing):', enrichErr);
    }

    if (runId) {
      await supabase.from('fbm_sync_runs').update({
        status: 'success',
        finished_at: new Date().toISOString(),
        elapsed_ms: Date.now() - runStart,
        fbm_rows: fbmReportedSkus.size,
        inserts: fbmInsertedCount,
        updates: fbmUpdatedCount,
        deletions: deletedFromInventory,
        enriched: enrichedCount,
      }).eq('id', runId);
    }

    return new Response(JSON.stringify({
      fbmUpdatedCount, fbmInsertedCount, deletedFromInventory, deletedFromRepricer, enrichedCount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[FBM_SYNC] Error:', error);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const sb = createClient(supabaseUrl, supabaseKey);
      await sb.from('fbm_sync_runs').insert({
        user_id: '00000000-0000-0000-0000-000000000000',
        status: 'error',
        triggered_by: 'unknown',
        finished_at: new Date().toISOString(),
        error_message: (error as Error).message?.slice(0, 500),
      });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
