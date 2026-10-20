import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { gunzip } from "https://deno.land/x/compress@v0.4.5/gzip/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalizeReportHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/^"+|"+$/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeReportHeader);
  return headers.findIndex((h) => normalizedAliases.includes(normalizeReportHeader(h)));
}

function parseReportLines(reportText: string): { lines: string[]; headers: string[] } {
  const normalizedText = reportText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedText.split('\n').map((l) => l.replace(/\u0000/g, '').trimEnd()).filter((l) => l.length > 0);
  const headers = (lines[0] || '').split('\t').map((h) => h.trim());
  return { lines, headers };
}

async function downloadReportText(documentUrl: string, compressionAlgorithm?: string): Promise<string> {
  const resp = await fetch(documentUrl);
  if (!resp.ok) throw new Error(`Failed to download report: ${resp.status}`);
  if ((compressionAlgorithm || '').toUpperCase() === 'GZIP') {
    const compressed = new Uint8Array(await resp.arrayBuffer());
    return new TextDecoder().decode(gunzip(compressed));
  }
  return await resp.text();
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
  return hmacSha256(kService, 'aws4_request');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`LWA token error: ${response.status}`);
  return (await response.json()).access_token;
}

async function callSpApi(method: string, path: string, accessToken: string, queryParams: Record<string, string> = {}, body?: string, maxRetries = 3): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const host = 'sellingpartnerapi-na.amazon.com';

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

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest));
    const requestHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${requestHash}`;
    const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, 'execute-api');
    const sigHmac = createHmac('sha256', signingKey as any); sigHmac.update(stringToSign);
    const signature = sigHmac.digest('hex');

    const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
    const resp = await fetch(url, {
      method,
      headers: { ...headers, 'Authorization': `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
      ...(body ? { body } : {}),
    });

    if (resp.ok) return await resp.json();
    const errText = await resp.text();
    if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
      const wait = Math.min(30000, 5000 * Math.pow(2, attempt - 1));
      console.warn(`[ghost-cleanup] ${resp.status}, retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`SP-API ${resp.status}: ${errText}`);
  }
  throw new Error('SP-API max retries exceeded');
}

// Marketplace ID → code mapping
const MARKETPLACE_MAP: Record<string, string> = {
  'ATVPDKIKX0DER': 'US',
  'A2EUQ1WTGCTBG2': 'CA',
  'A1AM78C64UM0Y8': 'MX',
  'A2Q3Y263D00KWC': 'BR',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth: support both JWT-authenticated and cron (service role) calls
    let userId: string | null = null;
    const authHeader = req.headers.get('authorization') || '';

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const isCron = body.cron === true;

    if (!isCron) {
      // JWT-based call from admin
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      userId = user.id;
    }

    // Get target users: single user (button click) or all users with authorizations (cron)
    let targetUserIds: string[] = [];
    if (userId) {
      targetUserIds = [userId];
    } else {
      // Cron: get all users with active seller authorizations
      const { data: auths } = await supabase
        .from('seller_authorizations')
        .select('user_id')
        .not('refresh_token', 'is', null);
      targetUserIds = [...new Set((auths || []).map((a: any) => a.user_id))];
    }

    console.log(`[ghost-cleanup] Processing ${targetUserIds.length} users`);
    const results: any[] = [];

    for (const uid of targetUserIds) {
      try {
        const userResult = await processUser(supabase, uid);
        results.push({ user_id: uid, ...userResult });
      } catch (err: any) {
        console.error(`[ghost-cleanup] User ${uid} error:`, (err as Error).message);
        results.push({ user_id: uid, error: (err as Error).message });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[ghost-cleanup] Fatal error:', error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function processUser(supabase: any, userId: string) {
  // Get all seller authorizations for this user
  const { data: authRows } = await supabase
    .from('seller_authorizations')
    .select('refresh_token, marketplace_id, seller_id')
    .eq('user_id', userId)
    .not('refresh_token', 'is', null);

  if (!authRows?.length) return { skipped: 'no_auth' };

  // Prefer US, then fallback
  const usAuth = authRows.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER');
  const auth = usAuth || authRows[0];

  const accessToken = await getLwaAccessToken(auth.refresh_token);

  // Request GET_MERCHANT_LISTINGS_ALL_DATA report
  console.log(`[ghost-cleanup] Requesting merchant listings report for user ${userId}`);
  const marketplaceId = auth.marketplace_id || 'ATVPDKIKX0DER';

  const createResp = await callSpApi('POST', '/reports/2021-06-30/reports', accessToken, {}, JSON.stringify({
    reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
    marketplaceIds: [marketplaceId],
  }));

  const reportId = createResp.reportId;
  console.log(`[ghost-cleanup] Report ID: ${reportId}`);

  // Poll for completion (max 5 min)
  let status = 'IN_QUEUE';
  let polls = 0;
  let reportDocumentId: string | null = null;

  while (status !== 'DONE' && status !== 'FATAL' && status !== 'CANCELLED' && polls < 60) {
    await new Promise(r => setTimeout(r, 5000));
    const statusResp = await callSpApi('GET', `/reports/2021-06-30/reports/${reportId}`, accessToken);
    status = statusResp.processingStatus;
    reportDocumentId = statusResp.reportDocumentId || null;
    polls++;
    if (polls % 10 === 0) console.log(`[ghost-cleanup] Poll ${polls}: ${status}`);
  }

  if (status !== 'DONE' || !reportDocumentId) {
    throw new Error(`Report not ready: ${status} after ${polls} polls`);
  }

  // Download and parse report
  const docResp = await callSpApi('GET', `/reports/2021-06-30/documents/${reportDocumentId}`, accessToken);
  const reportText = await downloadReportText(docResp.url, docResp.compressionAlgorithm);
  const { lines, headers } = parseReportLines(reportText);

  const skuIndex = findHeaderIndex(headers, ['seller-sku', 'seller sku', 'sku']);
  const asinIndex = findHeaderIndex(headers, ['asin1', 'asin']);
  const statusIndex = findHeaderIndex(headers, ['status']);

  if (skuIndex === -1 || asinIndex === -1) {
    throw new Error('Could not find SKU/ASIN columns in report');
  }

  // Build set of active SKUs from report
  const activeCatalogSkus = new Set<string>();
  const activeAsinSkuPairs = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const sku = (cols[skuIndex] || '').trim();
    const asin = (cols[asinIndex] || '').trim();
    const rowStatus = statusIndex !== -1 ? (cols[statusIndex] || '').trim().toLowerCase() : 'active';
    if (!sku) continue;
    // Include Active and Inactive (still in catalog). Exclude truly deleted items.
    if (rowStatus !== 'deleted') {
      activeCatalogSkus.add(sku);
      if (asin) activeAsinSkuPairs.add(`${asin}|${sku}`);
    }
  }

  console.log(`[ghost-cleanup] Report has ${activeCatalogSkus.size} active SKUs for user ${userId}`);

  // Get all inventory rows for this user
  let allInventory: any[] = [];
  let page = 0;
  while (true) {
    const { data: batch } = await supabase
      .from('inventory')
      .select('id, asin, sku, listing_status, available, reserved, last_inventory_sync_at')
      .eq('user_id', userId)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch?.length) break;
    allInventory = allInventory.concat(batch);
    if (batch.length < 1000) break;
    page++;
  }

  console.log(`[ghost-cleanup] ${allInventory.length} inventory rows for user ${userId}`);

  // Find ghost listings: in inventory but NOT in Amazon catalog report
  //
  // THE STOCK GATE, and why absence from the catalog report is not proof of
  // death. The report is the Listings/MerchantListings view, and it LAGS a
  // newly created listing. The FBA inventory API does not. So a SKU that is
  // missing from the report while Amazon is actively reporting units for it is
  // a report lag, not a dead listing -- and tombstoning it is a one-way door,
  // because fn_protect_ghost_tombstone then refuses every ordinary write and
  // only source = 'force_relist' can reopen it.
  //
  // Lived case, 2026-09-03: B00LFXMBKI / 6DA-X5B-Y5SO was created at 17:52 and
  // this function tombstoned it at 18:00:35, eight minutes later, purely
  // because the catalog report had not caught up. It stayed tombstoned for
  // seven weeks. Amazon held 145 fulfillable units the whole time and the ASIN
  // sold 52; the row showed available 0, which removed it from Inventory
  // Valuation (understating it by $5,075), from the repricer's view, and from
  // the FBA shipment builder, so restocking it needed a manual sync. The
  // refresh queue meanwhile reported success on every 3-hourly run because
  // rescue-inventory-asin was declining to write and nobody read the reason.
  //
  // The freshness requirement matters as much as the quantity: a stale nonzero
  // `available` left over from months ago would otherwise make a genuinely
  // dead listing permanently un-tombstonable. Only stock Amazon confirmed
  // recently counts as evidence it is alive.
  const STOCK_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const ghostItems: any[] = [];
  const heldBackForStock: any[] = [];
  for (const inv of allInventory) {
    if (!inv.sku) continue;
    // Skip already-marked items
    if (inv.listing_status === 'NOT_IN_CATALOG' || inv.listing_status === 'DELETED') continue;
    if (!activeCatalogSkus.has(inv.sku)) {
      const units = (inv.available ?? 0) + (inv.reserved ?? 0);
      const syncedAt = inv.last_inventory_sync_at ? Date.parse(inv.last_inventory_sync_at) : NaN;
      const stockIsFresh = Number.isFinite(syncedAt) &&
        (Date.now() - syncedAt) <= STOCK_EVIDENCE_MAX_AGE_MS;
      if (units > 0 && stockIsFresh) {
        heldBackForStock.push(inv);
        continue;
      }
      ghostItems.push(inv);
    }
  }

  console.log(`[ghost-cleanup] Found ${ghostItems.length} ghost listings for user ${userId}`);
  if (heldBackForStock.length > 0) {
    // Loud on purpose: each of these is a row the old code would have locked.
    console.log(
      `[ghost-cleanup] HELD BACK ${heldBackForStock.length} absent-from-report rows that Amazon ` +
      `still reports stock for (catalog report lag, not dead listings): ` +
      heldBackForStock.slice(0, 20).map((g: any) =>
        `${g.asin}/${g.sku}(${(g.available ?? 0)}+${(g.reserved ?? 0)})`).join(' '),
    );
  }

  // Mark ghost items as NOT_IN_CATALOG
  let markedCount = 0;
  let assignmentsDisabled = 0;

  for (let i = 0; i < ghostItems.length; i += 50) {
    const chunk = ghostItems.slice(i, i + 50);
    const ids = chunk.map((g: any) => g.id);
    const asins = [...new Set(chunk.map((g: any) => g.asin))];

    // Update inventory listing_status
    const { error: updateErr } = await supabase
      .from('inventory')
      .update({ listing_status: 'NOT_IN_CATALOG', updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('user_id', userId);

    if (updateErr) {
      console.error(`[ghost-cleanup] Update error:`, updateErr.message);
    } else {
      markedCount += chunk.length;
    }

    // Disable repricer assignments for ghost ASINs — but ONLY if no other
    // active inventory row exists for the same ASIN with stock
    if (asins.length > 0) {
      const ghostIds = new Set(ids);
      const asinsToDisable: string[] = [];

      for (const asin of asins) {
        // Check if there's another inventory row for this ASIN that is NOT a ghost
        const hasActiveRow = (allInventory as any[]).some(
          (inv: any) =>
            inv.asin === asin &&
            !ghostIds.has(inv.id) &&
            inv.listing_status !== 'NOT_IN_CATALOG' &&
            inv.listing_status !== 'DELETED' &&
            (inv.available > 0 || inv.reserved > 0 || inv.inbound > 0)
        );
        if (!hasActiveRow) {
          asinsToDisable.push(asin);
        } else {
          console.log(`[ghost-cleanup] Skipping assignment disable for ${asin} — active inventory row exists`);
        }
      }

      if (asinsToDisable.length > 0) {
        const { data: disabledData } = await supabase
          .from('repricer_assignments')
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: 'cleanup',
            last_disabled_reason: 'Ghost listing cleanup (NOT_IN_CATALOG)',
            last_disabled_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .in('asin', asinsToDisable)
          .eq('is_enabled', true)
          .select('id');
        assignmentsDisabled += disabledData?.length || 0;
      }
    }
  }

  console.log(`[ghost-cleanup] User ${userId}: marked ${markedCount} as NOT_IN_CATALOG, disabled ${assignmentsDisabled} assignments`);

  return {
    total_inventory: allInventory.length,
    active_in_catalog: activeCatalogSkus.size,
    ghosts_found: ghostItems.length,
    marked_not_in_catalog: markedCount,
    assignments_disabled: assignmentsDisabled,
    ghost_skus: ghostItems.slice(0, 20).map((g: any) => ({ sku: g.sku, asin: g.asin, status: g.listing_status })),
    // Surfaced in the response, not just the log, so a caller can see what the
    // stock gate protected without digging through function logs.
    held_back_for_stock: heldBackForStock.length,
    held_back_skus: heldBackForStock.slice(0, 20).map((g: any) => ({
      sku: g.sku, asin: g.asin,
      available: g.available ?? 0, reserved: g.reserved ?? 0,
      last_inventory_sync_at: g.last_inventory_sync_at,
    })),
  };
}
