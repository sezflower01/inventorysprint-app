import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getListingUnitCost } from "../_shared/cost-contract.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Built via fromCharCode rather than a regex escape literal — this source
// file is passed through a transport that silently strips a literal
// backslash-u escape sequence, corrupting any \uXXXX written directly.
const BOM_CHAR = String.fromCharCode(0xFEFF);
const NUL_CHAR = String.fromCharCode(0);

// ============================================================================
// Resumable, time-budgeted state machine (rewritten 2026-07-31).
//
// The previous version ran the entire sync (FBA report create+poll, download+
// parse, up to 500 ASINs of external catalog/pricing enrichment, a per-record
// inventory-quantity-update loop, a backfill loop, then the WHOLE thing again
// for an FBM merchant-listings report, then an outer per-record enrichment
// pass) as ONE continuous EdgeRuntime.waitUntil() background execution.
//
// Live-captured proof (2026-07-31): a real run for this account stalled at
// 2200/3672 records into the per-record quantity-update loop after ~140s of
// continuous execution, with no error ever thrown — neither the 'completed'
// nor 'failed' write ever ran. This matches 759 historical rows stuck
// 'in_progress' forever with no completion or failure ever recorded, and
// zero successful completions since 2026-05-05. The Supabase edge runtime
// silently kills a waitUntil-continued execution around ~150s wall-clock;
// several individual phases here (the quantity-update loop alone, the FBM
// report's own up-to-5-minute poll, etc.) can each independently exceed that
// on a large catalog.
//
// Fix: every phase persists its cursor to `fnsku_sync_history` /
// `fnsku_sync_report_rows` and checks a wall-clock deadline (TIME_BUDGET_MS
// from invocation start, well under the observed ~150s ceiling). If a phase
// isn't finished when the deadline hits, it fires a non-blocking HTTP call to
// this same function with {resume:true, syncRecordId, ...} and returns
// immediately — mirroring the "kick off waitUntil, respond immediately"
// pattern already used for the very first invocation, just recursively.
// ============================================================================

const TIME_BUDGET_MS = 100_000; // ~50s safety margin under the observed ~150s kill
const POLL_MAX_ATTEMPTS = 60; // unchanged from original: up to 5 minutes (5s * 60) total across invocations
const MAX_ENRICH = 500; // unchanged cap on unique ASINs enriched via SP-API per sync
const ENRICH_ASINS_PER_CHUNK = 25;
const APPLY_BATCH = 150;
const BACKFILL_PAGE = 200;
const OUTER_ENRICH_BATCH = 15;

async function checkpoint(supabase: any, syncRecordId: string | undefined, phase: string, extra?: Record<string, any>) {
  if (!syncRecordId) return;
  try {
    await supabase.from('fnsku_sync_history').update({
      phase,
      last_heartbeat_at: new Date().toISOString(),
      ...extra,
    }).eq('id', syncRecordId);
  } catch (e) {
    console.warn(`[checkpoint] failed to write phase=${phase}:`, e);
  }
}

function normalizeReportHeader(value: string): string {
  const withoutBom = value.startsWith(BOM_CHAR) ? value.slice(1) : value;
  return withoutBom
    .replace(/^"+|"+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeReportHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeReportHeader(header)));
}

function parseReportText(reportText: string): { lines: string[]; headers: string[] } {
  const withoutBom = reportText.startsWith(BOM_CHAR) ? reportText.slice(1) : reportText;
  const normalizedText = withoutBom
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = normalizedText
    .split('\n')
    .map((line) => line.split(NUL_CHAR).join('').trimEnd())
    .filter((line) => line.length > 0);

  const headers = (lines[0] || '').split('\t').map((header) => header.trim());
  return { lines, headers };
}

// AWS SigV4 signing helpers
async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return await hmacSha256(kService, 'aws4_request');
}

async function getAwsSignature(
  method: string,
  path: string,
  queryParams: string,
  headers: Record<string, string>,
  payload: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
    .join('\n') + '\n';

  const signedHeaders = Object.keys(headers)
    .sort()
    .map(k => k.toLowerCase())
    .join(';');

  const payloadHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const canonicalRequestHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = Array.from(
    new Uint8Array(await hmacSha256(signingKey, stringToSign))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Normalize Amazon condition strings to consistent display format
function normalizeCondition(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, '');

  const conditionMap: Record<string, string> = {
    'new': 'NEW',
    'newitem': 'NEW',
    'newoem': 'NEW',
    'usedlikenew': 'USED - LIKE NEW',
    'usedverygood': 'USED - VERY GOOD',
    'usedgood': 'USED - GOOD',
    'usedacceptable': 'USED - ACCEPTABLE',
    'collectiblelikenew': 'COLLECTIBLE - LIKE NEW',
    'collectibleverygood': 'COLLECTIBLE - VERY GOOD',
    'collectiblegood': 'COLLECTIBLE - GOOD',
    'collectibleacceptable': 'COLLECTIBLE - ACCEPTABLE',
    'refurbished': 'RENEWED',
    'renewed': 'RENEWED',
    'club': 'CLUB',
  };

  return conditionMap[normalized] || raw.toUpperCase();
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing LWA credentials');
  }

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

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LWA token error response:', errorText);
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
  method = 'GET',
  body = ''
): Promise<any> {
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;

  const host = 'sellingpartnerapi-na.amazon.com';
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'content-type': 'application/json',
  };

  const authHeader = await getAwsSignature(
    method,
    path,
    queryString,
    headers,
    body,
    awsAccessKeyId,
    awsSecretAccessKey,
    region
  );

  const response = await fetch(url, {
    method,
    headers: { ...headers, 'authorization': authHeader },
    body: method === 'POST' ? body : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`SP-API error ${response.status} for ${path}:`, text.slice(0, 500));
    throw new Error(`SP-API error ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

const getTotalStock = (row: { available?: number; reserved?: number; inbound?: number; unfulfilled?: number } | null | undefined) =>
  (row?.available || 0) + (row?.reserved || 0) + (row?.inbound || 0) + (row?.unfulfilled || 0);

const ZERO_CONFIRMATION_WINDOW_MINUTES = 45;
async function hasRecentZeroConfirmation(supabase: any, userId: string, sku: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - ZERO_CONFIRMATION_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('inventory_history')
    .select('available, reserved, inbound, captured_at, source')
    .eq('user_id', userId)
    .eq('sku', sku)
    .gte('captured_at', cutoff)
    .in('source', ['amazon_sync', 'live_api'])
    .order('captured_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error(`Failed to check zero confirmation history for ${sku}:`, error);
    return false;
  }

  return (data || []).some((row: any) => ((row.available || 0) + (row.reserved || 0) + (row.inbound || 0)) === 0);
}

interface Ctx {
  supabase: any;
  supabaseUrl: string;
  serviceKey: string;
  syncRecordId: string;
  userId: string;
  sellerId: string;
  marketplaceId: string;
  refreshToken: string;
  accessToken: string;
}

type PhaseResult = { done: boolean; nextPhase?: string };

// Fire a non-blocking continuation call to this same function and return —
// mirrors the original "kick off background work, respond immediately"
// pattern, just recursively at the phase level instead of only at the top.
// A single failed dispatch here would silently kill the whole chain — exactly
// the class of bug this rewrite exists to fix — so this retries a couple of
// times with a short backoff before giving up. Even then it doesn't leave a
// silent corpse: the fnsku-sync-timeout-sweep cron catches anything that
// truly never resumes and marks it 'timed_out' within ~12 minutes.
async function selfContinue(ctx: Ctx, phase: string) {
  const payload = JSON.stringify({
    resume: true,
    syncRecordId: ctx.syncRecordId,
    user_id: ctx.userId,
    seller_id: ctx.sellerId,
    marketplace_id: ctx.marketplaceId,
    refresh_token: ctx.refreshToken,
    phase,
  });
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(`${ctx.supabaseUrl}/functions/v1/sync-fnsku-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.serviceKey}` },
        body: payload,
      });
      if (resp.ok) {
        const body = await resp.json().catch(() => null);
        if (body?.ok === false) {
          console.error(`[selfContinue] continuation rejected (attempt ${attempt}):`, body);
        } else {
          return;
        }
      } else {
        console.error(`[selfContinue] continuation HTTP ${resp.status} (attempt ${attempt})`);
      }
    } catch (e) {
      console.error(`[selfContinue] dispatch error (attempt ${attempt}):`, e);
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  console.error(`[selfContinue] giving up after ${maxAttempts} attempts for phase=${phase}, syncRecordId=${ctx.syncRecordId}`);
}

// ---------------------------------------------------------------------------
// Report create + poll (shared logic for both FBA and FBM reports)
// ---------------------------------------------------------------------------
async function phaseReportPoll(ctx: Ctx, deadline: number, reportKind: 'fba' | 'fbm', row: any): Promise<PhaseResult> {
  const reportType = reportKind === 'fba' ? 'GET_FBA_MYI_ALL_INVENTORY_DATA' : 'GET_MERCHANT_LISTINGS_ALL_DATA';
  let reportId: string | null = row.report_id || null;
  let attempts: number = row.poll_attempts || 0;

  if (!reportId) {
    const createResponse = await callSpApi(
      '/reports/2021-06-30/reports',
      ctx.accessToken,
      {},
      'POST',
      JSON.stringify({ reportType, marketplaceIds: [ctx.marketplaceId] })
    );
    reportId = createResponse.reportId;
    attempts = 0;
    await checkpoint(ctx.supabase, ctx.syncRecordId, `${reportKind}_report_requested`, { report_id: reportId, poll_attempts: 0 });
  }

  while (attempts < POLL_MAX_ATTEMPTS) {
    if (Date.now() >= deadline) {
      return { done: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempts++;

    const statusResponse = await callSpApi(`/reports/2021-06-30/reports/${reportId}`, ctx.accessToken);
    const reportStatus = statusResponse.processingStatus;
    await checkpoint(ctx.supabase, ctx.syncRecordId, `${reportKind}_polling_attempt_${attempts}`, { poll_attempts: attempts });

    if (reportStatus === 'DONE') {
      await checkpoint(ctx.supabase, ctx.syncRecordId, `${reportKind}_report_done`);
      return { done: true, nextPhase: reportKind === 'fba' ? 'fba_downloading_parsing' : 'fbm_downloading_parsing' };
    }
    if (reportStatus === 'FATAL' || reportStatus === 'CANCELLED') {
      throw new Error(`Amazon ${reportKind.toUpperCase()} report failed with status: ${reportStatus}`);
    }
  }

  throw new Error(`${reportKind.toUpperCase()} report generation timed out after ${POLL_MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Download + parse a completed report, persist rows to fnsku_sync_report_rows
// ---------------------------------------------------------------------------
async function phaseDownloadParseFba(ctx: Ctx, row: any): Promise<PhaseResult> {
  const reportResponse = await callSpApi(`/reports/2021-06-30/reports/${row.report_id}`, ctx.accessToken);
  const documentResponse = await callSpApi(`/reports/2021-06-30/documents/${reportResponse.reportDocumentId}`, ctx.accessToken);
  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_downloading');

  const reportData = await fetch(documentResponse.url);
  const reportText = await reportData.text();
  const lines = reportText.split('\n');
  const headers = lines[0].split('\t');

  const asinIndex = headers.indexOf('asin');
  const fnskuIndex = headers.indexOf('fnsku');
  const skuIndex = headers.indexOf('sku');
  const conditionIndex = headers.indexOf('condition');
  const titleIndex = headers.indexOf('product-name');
  const quantityIndex = headers.indexOf('afn-total-quantity');
  const availableIndex = headers.indexOf('afn-warehouse-quantity');
  const reservedIndex = headers.indexOf('afn-reserved-quantity');
  const inboundShippedIndex = headers.indexOf('afn-inbound-shipped-quantity');
  const inboundReceivingIndex = headers.indexOf('afn-inbound-receiving-quantity');
  const unfulfillableIndex = headers.indexOf('afn-unsellable-quantity');

  if (asinIndex === -1 || fnskuIndex === -1) {
    throw new Error('Report missing required columns (asin, fnsku)');
  }

  const bySku: Record<string, any> = {};
  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split('\t');
    const asin = columns[asinIndex];
    const fnsku = columns[fnskuIndex];
    const sku = skuIndex !== -1 ? columns[skuIndex] : null;
    if (!asin || !fnsku || !sku) continue;

    const rawCondition = conditionIndex !== -1 ? columns[conditionIndex] : null;
    const condition = normalizeCondition(rawCondition);
    const title = titleIndex !== -1 ? columns[titleIndex] : 'Unknown Product';
    const units = parseInt((quantityIndex !== -1 ? columns[quantityIndex] : '0') || '0', 10) || 0;
    const available = availableIndex !== -1 ? parseInt(columns[availableIndex] || '0', 10) || 0 : 0;
    const reserved = reservedIndex !== -1 ? parseInt(columns[reservedIndex] || '0', 10) || 0 : 0;
    const inboundShipped = inboundShippedIndex !== -1 ? parseInt(columns[inboundShippedIndex] || '0', 10) || 0 : 0;
    const inboundReceiving = inboundReceivingIndex !== -1 ? parseInt(columns[inboundReceivingIndex] || '0', 10) || 0 : 0;
    const inbound = inboundShipped + inboundReceiving;
    const unfulfilled = unfulfillableIndex !== -1 ? parseInt(columns[unfulfillableIndex] || '0', 10) || 0 : 0;

    if (!bySku[sku]) {
      bySku[sku] = { asin, sku, fnsku, condition, title, units, available, reserved, inbound, unfulfilled };
    } else {
      bySku[sku].units += units;
      bySku[sku].available += available;
      bySku[sku].reserved += reserved;
      bySku[sku].inbound += inbound;
      bySku[sku].unfulfilled += unfulfilled;
    }
  }

  const entries = Object.values(bySku) as any[];
  console.log(`[fba_parse] ${entries.length} FNSKU/SKU rows parsed`);

  // Upsert the FNSKU map (fast, small rows, unchanged from original).
  const fnskuMapBatch = entries.map((r) => ({
    seller_id: ctx.sellerId, marketplace_id: ctx.marketplaceId,
    asin: r.asin, seller_sku: r.sku, fnsku: r.fnsku, condition: r.condition,
  }));
  const upsertBatchSize = 500;
  let processedRows = 0;
  for (let i = 0; i < fnskuMapBatch.length; i += upsertBatchSize) {
    const batch = fnskuMapBatch.slice(i, i + upsertBatchSize);
    const { error } = await ctx.supabase.from('fnsku_map').upsert(batch, { onConflict: 'seller_id,marketplace_id,asin,fnsku' });
    if (!error) processedRows += batch.length;
  }

  // Determine which SKUs already exist in inventory (is_new).
  const allSkus = entries.map((e) => e.sku);
  const existingSkuSet = new Set<string>();
  for (let i = 0; i < allSkus.length; i += upsertBatchSize) {
    const batch = allSkus.slice(i, i + upsertBatchSize);
    const { data } = await ctx.supabase.from('inventory').select('sku').eq('user_id', ctx.userId).in('sku', batch);
    (data || []).forEach((r: any) => existingSkuSet.add(r.sku));
  }

  const stagingRows = entries.map((r) => ({
    sync_id: ctx.syncRecordId, user_id: ctx.userId, report_type: 'fba',
    asin: r.asin, sku: r.sku, fnsku: r.fnsku, condition: r.condition, title: r.title,
    units: r.units, available: r.available, reserved: r.reserved, inbound: r.inbound, unfulfilled: r.unfulfilled,
    is_new: !existingSkuSet.has(r.sku),
  }));
  for (let i = 0; i < stagingRows.length; i += upsertBatchSize) {
    const batch = stagingRows.slice(i, i + upsertBatchSize);
    const { error } = await ctx.supabase.from('fnsku_sync_report_rows').insert(batch);
    if (error) console.error('Error persisting fba staging rows:', error);
  }

  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_map_upserted', { processed_rows: processedRows });
  return { done: true, nextPhase: 'fba_enriching' };
}

async function phaseDownloadParseFbm(ctx: Ctx, row: any): Promise<PhaseResult> {
  const reportResponse = await callSpApi(`/reports/2021-06-30/reports/${row.report_id}`, ctx.accessToken);
  const documentResponse = await callSpApi(`/reports/2021-06-30/documents/${reportResponse.reportDocumentId}`, ctx.accessToken);
  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fbm_downloading');

  const fbmReportData = await fetch(documentResponse.url);
  const fbmReportText = await fbmReportData.text();
  const { lines: fbmLines, headers: fbmHeaders } = parseReportText(fbmReportText);

  const mlSkuIndex = findHeaderIndex(fbmHeaders, ['seller-sku', 'seller sku', 'sku']);
  const mlAsinIndex = findHeaderIndex(fbmHeaders, ['asin1', 'asin']);
  const mlTitleIndex = findHeaderIndex(fbmHeaders, ['item-name', 'item name', 'product-name', 'product name', 'title']);
  const mlPriceIndex = findHeaderIndex(fbmHeaders, ['price', 'your-price']);
  const mlQuantityIndex = findHeaderIndex(fbmHeaders, ['quantity', 'available']);
  const mlFulfillmentIndex = findHeaderIndex(fbmHeaders, ['fulfillment-channel', 'fulfillment channel']);
  const mlImageIndex = findHeaderIndex(fbmHeaders, ['image-url', 'image url']);

  // Exclude SKUs already synced as FBA in THIS run (matches original intent:
  // dedupe against the just-parsed FBA report, not just whatever pre-existed).
  const existingFbaSkus = new Set<string>();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data } = await ctx.supabase.from('fnsku_sync_report_rows').select('sku').eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba')
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (!data || data.length === 0) break;
      data.forEach((r: any) => existingFbaSkus.add(r.sku));
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }

  const fbmListings: any[] = [];
  for (let i = 1; i < fbmLines.length; i++) {
    const cols = fbmLines[i].split('\t');
    if (cols.length < 3) continue;
    const asin = cols[mlAsinIndex]?.trim();
    const sku = cols[mlSkuIndex]?.trim();
    const fulfillmentChannel = cols[mlFulfillmentIndex]?.trim() || '';
    if (!asin || !sku) continue;
    if (fulfillmentChannel.includes('AMAZON') || existingFbaSkus.has(sku)) continue;

    fbmListings.push({
      asin, sku,
      title: cols[mlTitleIndex]?.trim() || 'Unknown Product',
      price: parseFloat(cols[mlPriceIndex]) || null,
      quantity: parseInt(cols[mlQuantityIndex]) || 0,
      image_url: cols[mlImageIndex]?.trim() || null,
    });
  }
  console.log(`[fbm_parse] ${fbmListings.length} FBM-only listings found`);

  const existingSkuSet = new Set<string>();
  const batchSize = 500;
  const fbmSkus = fbmListings.map((l) => l.sku);
  for (let i = 0; i < fbmSkus.length; i += batchSize) {
    const batch = fbmSkus.slice(i, i + batchSize);
    const { data } = await ctx.supabase.from('inventory').select('sku').eq('user_id', ctx.userId).in('sku', batch);
    (data || []).forEach((r: any) => existingSkuSet.add(r.sku));
  }

  const stagingRows = fbmListings.map((l) => ({
    sync_id: ctx.syncRecordId, user_id: ctx.userId, report_type: 'fbm',
    asin: l.asin, sku: l.sku, fnsku: null, condition: null, title: l.title,
    units: l.quantity, available: l.quantity, reserved: 0, inbound: 0, unfulfilled: 0,
    is_new: !existingSkuSet.has(l.sku),
    enriched: true, // FBM never goes through the SP-API catalog/pricing enrichment phase
    enrichment_title: null, enrichment_image_url: l.image_url, enrichment_price: l.price,
  }));
  for (let i = 0; i < stagingRows.length; i += batchSize) {
    const batch = stagingRows.slice(i, i + batchSize);
    const { error } = await ctx.supabase.from('fnsku_sync_report_rows').insert(batch);
    if (error) console.error('Error persisting fbm staging rows:', error);
  }

  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fbm_parsed', { cursor_offset: null, cursor_total: null });
  return { done: true, nextPhase: 'fbm_applying' };
}

// ---------------------------------------------------------------------------
// FBA enrichment: SP-API catalog + pricing lookups, capped at MAX_ENRICH
// unique ASINs, chunked so each invocation only enriches a bounded slice.
// ---------------------------------------------------------------------------
async function phaseEnrichFba(ctx: Ctx, deadline: number, row: any): Promise<PhaseResult> {
  // cursor_total tracks how many distinct ASINs we've committed to enrich
  // (capped at MAX_ENRICH); cursor_offset tracks how many of those are done.
  let total = row.cursor_total;
  let offset = row.cursor_offset || 0;

  if (total === null || total === undefined) {
    // Paginated — an unbounded select() silently caps at PostgREST's default
    // 1000 rows, which would undercount in-stock ASINs (and therefore skip
    // real enrichment) for any catalog bigger than that.
    const inStockAsins = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data: eligible } = await ctx.supabase
        .from('fnsku_sync_report_rows')
        .select('asin, available, reserved, inbound, unfulfilled')
        .eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba').eq('enriched', false)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (!eligible || eligible.length === 0) break;
      for (const r of eligible) {
        if (getTotalStock(r) > 0) inStockAsins.add(r.asin);
        if (inStockAsins.size >= MAX_ENRICH) break;
      }
      if (eligible.length < pageSize || inStockAsins.size >= MAX_ENRICH) break;
    }
    total = inStockAsins.size;
    offset = 0;
    await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_enrichment_start', { cursor_total: total, cursor_offset: 0, enrichment_total: total, enrichment_processed: 0 });

    // Mark zero-stock rows (never enriched) and any beyond the cap as skipped
    // up front isn't necessary here — the loop below marks-as-it-goes and a
    // final sweep (once offset reaches total) marks everything else skipped.
  }

  if (total === 0) {
    await markRemainingFbaRowsSkipped(ctx);
    await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_enrichment_done', { enrichment_processed: 0 });
    return { done: true, nextPhase: 'fba_applying' };
  }

  while (offset < total) {
    if (Date.now() >= deadline) {
      await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_enrichment_progress', { cursor_offset: offset, enrichment_processed: offset });
      return { done: false };
    }

    // Pull the next chunk of distinct un-enriched, in-stock ASINs.
    const { data: candidateRows } = await ctx.supabase
      .from('fnsku_sync_report_rows')
      .select('asin, available, reserved, inbound, unfulfilled')
      .eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba').eq('enriched', false)
      .limit(2000);
    const asinsInChunk: string[] = [];
    const seen = new Set<string>();
    for (const r of candidateRows || []) {
      if (getTotalStock(r) <= 0) continue;
      if (seen.has(r.asin)) continue;
      seen.add(r.asin);
      asinsInChunk.push(r.asin);
      if (asinsInChunk.length >= ENRICH_ASINS_PER_CHUNK) break;
    }
    if (asinsInChunk.length === 0) break;

    let quotaHit = false;
    for (const asin of asinsInChunk) {
      if (Date.now() >= deadline) break;
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await waitForApiToken(ctx.supabase, 'catalog_api');
        const catalogData = await callSpApi(`/catalog/2022-04-01/items/${asin}`, ctx.accessToken, { marketplaceIds: ctx.marketplaceId, includedData: 'images,summaries' });
        const enrichedTitle = catalogData?.summaries?.[0]?.itemName || null;
        const imageUrl = catalogData?.images?.[0]?.images?.[0]?.link || null;

        let price: number | null = null;
        try {
          await waitForApiToken(ctx.supabase, 'pricing_api');
          const pricingData = await callSpApi(`/products/pricing/v0/items/${asin}/offers`, ctx.accessToken, { MarketplaceId: ctx.marketplaceId, ItemCondition: 'New' });
          const summary = pricingData?.payload?.Summary;
          const buyBox = (summary?.BuyBoxPrices || [])[0];
          if (buyBox) price = buyBox?.LandedPrice?.Amount ?? buyBox?.ListingPrice?.Amount ?? null;
          else {
            const lowest = (summary?.LowestPrices || [])[0];
            if (lowest) price = lowest?.LandedPrice?.Amount ?? lowest?.ListingPrice?.Amount ?? null;
          }
        } catch (pricingError) {
          console.error('Pricing API error for ASIN', asin, pricingError);
        }

        await ctx.supabase.from('fnsku_sync_report_rows')
          .update({ enriched: true, enrichment_title: enrichedTitle, enrichment_image_url: imageUrl, enrichment_price: price })
          .eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba').eq('asin', asin);
        offset++;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Error enriching ASIN', asin, msg);
        if (msg.includes('429')) {
          console.warn('SP-API quota exceeded during enrichment; stopping further product data fetches');
          quotaHit = true;
          break;
        }
        // Non-quota error: mark this ASIN enriched-with-no-data so the cursor
        // moves past it instead of retrying forever.
        await ctx.supabase.from('fnsku_sync_report_rows')
          .update({ enriched: true })
          .eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba').eq('asin', asin);
        offset++;
      }
    }
    await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_enrichment_progress', { cursor_offset: offset, enrichment_processed: offset });
    if (quotaHit) break;
  }

  await markRemainingFbaRowsSkipped(ctx);
  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_enrichment_done', { enrichment_processed: offset });
  return { done: true, nextPhase: 'fba_applying' };
}

// Any FBA row never enriched (zero-stock, or beyond the MAX_ENRICH cap, or
// skipped after a quota hit) is marked enriched=true with no SP-API data so
// downstream phases treat it as "no enrichment available" (falls back to
// created_listings / defaults) instead of the cursor looping on it forever.
async function markRemainingFbaRowsSkipped(ctx: Ctx) {
  const { error } = await ctx.supabase
    .from('fnsku_sync_report_rows')
    .update({ enriched: true })
    .eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba').eq('enriched', false);
  if (error) console.error('Error marking remaining fba rows as skipped:', error);
}

// ---------------------------------------------------------------------------
// Apply phase: insert NEW inventory/created_listings rows, update EXISTING
// inventory rows with fresh quantities. Shared logic for FBA and FBM.
// ---------------------------------------------------------------------------
async function phaseApply(ctx: Ctx, deadline: number, reportKind: 'fba' | 'fbm'): Promise<PhaseResult> {
  const batchSize = 500;
  let totalNewInserted = 0;
  let totalExistingUpdated = 0;

  while (Date.now() < deadline) {
    const { data: batch, error } = await ctx.supabase
      .from('fnsku_sync_report_rows')
      .select('*')
      .eq('sync_id', ctx.syncRecordId).eq('report_type', reportKind).eq('applied', false)
      .limit(APPLY_BATCH);
    if (error) { console.error(`Error fetching ${reportKind} apply batch:`, error); break; }
    if (!batch || batch.length === 0) break;

    const newRows = batch.filter((r: any) => r.is_new);
    const existingRows = batch.filter((r: any) => !r.is_new);

    if (newRows.length > 0) {
      const asins = [...new Set(newRows.map((r: any) => r.asin))];
      const skus = newRows.map((r: any) => r.sku);
      const createdListingsByAsin: Record<string, any> = {};
      const createdListingsBySku: Record<string, any> = {};
      for (let i = 0; i < asins.length; i += batchSize) {
        const { data: cl } = await ctx.supabase.from('created_listings').select('asin, sku, title, image_url, price, cost, units, amount').eq('user_id', ctx.userId).in('asin', asins.slice(i, i + batchSize));
        (cl || []).forEach((rec: any) => {
          if (!createdListingsByAsin[rec.asin] || rec.cost) createdListingsByAsin[rec.asin] = rec;
          if (rec.sku) createdListingsBySku[rec.sku] = rec;
        });
      }

      const inventoryInsertRows = newRows.map((r: any) => {
        const fromCreatedListings = createdListingsBySku[r.sku] || createdListingsByAsin[r.asin];
        const title = r.enrichment_title || fromCreatedListings?.title || r.title || 'Unknown Product';
        const imageUrl = r.enrichment_image_url || fromCreatedListings?.image_url || null;
        const price = r.enrichment_price ?? fromCreatedListings?.price ?? null;
        const unitCost = fromCreatedListings ? getListingUnitCost(fromCreatedListings) : null;
        const stockQty = Math.max(0, Number(r.available || 0) + Number(r.reserved || 0) + Number(r.inbound || 0));
        return {
          user_id: ctx.userId, asin: r.asin, sku: r.sku, fnsku: r.fnsku,
          title, image_url: imageUrl, price: typeof price === 'number' ? price : null,
          cost: unitCost, amount: unitCost !== null ? unitCost * stockQty : null,
          units: r.units, available: r.available, reserved: r.reserved, inbound: r.inbound, unfulfilled: r.unfulfilled,
          supplier_links: [], source: reportKind === 'fba' ? 'amazon_sync' : 'amazon_sync_fbm',
        };
      });
      const { error: insErr } = await ctx.supabase.from('inventory').insert(inventoryInsertRows);
      if (insErr) console.error(`Error inserting new ${reportKind} inventory rows:`, insErr);
      else totalNewInserted += inventoryInsertRows.length;

      // Backfill created_listings for anything not already tracked there.
      const existingClAsins = new Set<string>();
      for (let i = 0; i < asins.length; i += batchSize) {
        const { data: cl } = await ctx.supabase.from('created_listings').select('asin').eq('user_id', ctx.userId).in('asin', asins.slice(i, i + batchSize));
        (cl || []).forEach((r: any) => existingClAsins.add(r.asin));
      }
      const newClRows = newRows
        .filter((r: any) => !existingClAsins.has(r.asin))
        .map((r: any, idx: number) => ({
          user_id: ctx.userId, asin: r.asin,
          sku: r.sku || `AMZSYNC-${r.asin.substring(0, 6)}-${idx}`,
          fnsku: r.fnsku, title: r.enrichment_title || r.title, image_url: r.enrichment_image_url,
          price: r.enrichment_price, cost: null, units: null, amount: null, supplier_links: [],
        }));
      if (newClRows.length > 0) {
        const { error: clErr } = await ctx.supabase.from('created_listings').insert(newClRows);
        if (clErr) console.error('Error inserting new created_listings rows:', clErr);
      }
    }

    if (existingRows.length > 0) {
      const skus = existingRows.map((r: any) => r.sku);
      const previousBySku: Record<string, any> = {};
      for (let i = 0; i < skus.length; i += batchSize) {
        const { data: existing } = await ctx.supabase.from('inventory').select('sku, available, reserved, inbound, unfulfilled').eq('user_id', ctx.userId).in('sku', skus.slice(i, i + batchSize));
        (existing || []).forEach((r: any) => { previousBySku[r.sku] = r; });
      }

      for (const r of existingRows) {
        if (reportKind === 'fbm') {
          const { error: updErr } = await ctx.supabase.from('inventory').update({
            source: 'amazon_sync_fbm', available: r.available, reserved: 0, inbound: 0, fnsku: null,
          }).eq('user_id', ctx.userId).eq('sku', r.sku);
          if (!updErr) totalExistingUpdated++;
          continue;
        }

        const previousRow = previousBySku[r.sku];
        const incomingTotal = getTotalStock(r);
        const previousTotal = getTotalStock(previousRow);
        const suspiciousZero = incomingTotal === 0 && previousTotal > 0 && !(await hasRecentZeroConfirmation(ctx.supabase, ctx.userId, r.sku));
        if (suspiciousZero) {
          console.warn(`Blocking suspicious zero overwrite for SKU ${r.sku} / ASIN ${r.asin} (previous=${previousTotal}, incoming=0)`);
          continue;
        }
        const { error: updErr } = await ctx.supabase.from('inventory').update({
          units: r.units, available: r.available, reserved: r.reserved, inbound: r.inbound, unfulfilled: r.unfulfilled,
          fnsku: r.fnsku, last_inventory_sync_at: new Date().toISOString(),
        }).eq('user_id', ctx.userId).eq('sku', r.sku);
        if (!updErr) totalExistingUpdated++;
      }
    }

    const ids = batch.map((r: any) => r.id);
    await ctx.supabase.from('fnsku_sync_report_rows').update({ applied: true }).in('id', ids);
    await checkpoint(ctx.supabase, ctx.syncRecordId, `${reportKind}_apply_progress`, {});
    console.log(`[${reportKind}_apply] batch done: new=${totalNewInserted} updated=${totalExistingUpdated}`);
  }

  const { count: remaining } = await ctx.supabase
    .from('fnsku_sync_report_rows')
    .select('id', { count: 'exact', head: true })
    .eq('sync_id', ctx.syncRecordId).eq('report_type', reportKind).eq('applied', false);

  if (remaining && remaining > 0) return { done: false };

  await checkpoint(ctx.supabase, ctx.syncRecordId, `${reportKind}_apply_done`);
  return { done: true, nextPhase: reportKind === 'fba' ? 'fba_backfilling' : 'completed' };
}

// ---------------------------------------------------------------------------
// Backfill phase: existing inventory rows missing image/price/unit cost,
// filled in from created_listings where possible. Paginated via cursor_offset.
// ---------------------------------------------------------------------------
async function phaseBackfill(ctx: Ctx, deadline: number, row: any): Promise<PhaseResult> {
  const batchSize = 500;
  let offset = row.cursor_offset || 0;

  while (Date.now() < deadline) {
    const { data: page, error } = await ctx.supabase
      .from('inventory')
      .select('id, asin, image_url, price, amount, available, reserved, inbound')
      .eq('user_id', ctx.userId)
      .or('image_url.is.null,price.is.null,price.eq.0,amount.is.null,amount.eq.0')
      .eq('unit_cost_manual', false)
      .order("id", { ascending: true })
      .range(offset, offset + BACKFILL_PAGE - 1);
    if (error) { console.error('Error fetching backfill page:', error); break; }
    if (!page || page.length === 0) break;

    const asins = [...new Set(page.map((r: any) => r.asin))];
    const clByAsin: Record<string, any> = {};
    for (let i = 0; i < asins.length; i += batchSize) {
      const { data: cl } = await ctx.supabase.from('created_listings').select('asin, image_url, price, cost, units, amount').eq('user_id', ctx.userId).in('asin', asins.slice(i, i + batchSize));
      (cl || []).forEach((rec: any) => { if (!clByAsin[rec.asin] || rec.cost) clByAsin[rec.asin] = rec; });
    }

    for (const invRecord of page) {
      const clData = clByAsin[invRecord.asin];
      if (!clData) continue;
      const updateData: any = {};
      if (!invRecord.image_url && clData.image_url) updateData.image_url = clData.image_url;
      if ((!invRecord.price || invRecord.price === 0) && clData.price && clData.price > 0) updateData.price = clData.price;
      const backfillUnitCost = getListingUnitCost(clData);
      if (backfillUnitCost !== null) {
        const stockQty = Math.max(0, (invRecord.available || 0) + (invRecord.reserved || 0) + (invRecord.inbound || 0));
        updateData.cost = backfillUnitCost;
        updateData.amount = backfillUnitCost * stockQty;
        updateData.units = stockQty;
      }
      if (Object.keys(updateData).length > 0) {
        await ctx.supabase.from('inventory').update(updateData).eq('id', invRecord.id);
      }
    }

    offset += page.length;
    await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_backfill_progress', { cursor_offset: offset });
    if (page.length < BACKFILL_PAGE) {
      await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_backfill_done', { cursor_offset: null, cursor_total: null });
      return { done: true, nextPhase: 'fbm_report_requested' };
    }
  }
  await checkpoint(ctx.supabase, ctx.syncRecordId, 'fba_backfill_progress', { cursor_offset: offset });
  return { done: false };
}

// ---------------------------------------------------------------------------
// Outer enrichment: fills in title/image/price/unit_cost for any inventory
// record still incomplete after the sync. Runs AFTER the sync is already
// marked 'completed' (this is a nice-to-have, not part of the core signal),
// so a stall here can never leave the sync itself looking stuck.
// ---------------------------------------------------------------------------
async function phaseOuterEnrich(ctx: Ctx, deadline: number, row: any): Promise<PhaseResult> {
  let offset = row.cursor_offset || 0;

  while (Date.now() < deadline) {
    const { data: page, error } = await ctx.supabase
      .from('inventory')
      .select('*')
      .eq('user_id', ctx.userId)
      .eq('source', 'amazon_sync')
      .or('image_url.is.null,price.is.null,price.eq.0,unit_cost.is.null,unit_cost.eq.0')
      .order("id", { ascending: true })
      .range(offset, offset + OUTER_ENRICH_BATCH - 1);
    if (error) {
      console.error('Error fetching outer-enrichment page:', error);
      await checkpoint(ctx.supabase, ctx.syncRecordId, 'outer_enrichment_done', { cursor_offset: null });
      return { done: true };
    }
    if (!page || page.length === 0) {
      // Nothing left to enrich — genuinely finished, not "ran out of budget".
      // (A prior version fell through to `return { done: false }` here,
      // which told the dispatcher to self-continue forever finding 0 rows.)
      await checkpoint(ctx.supabase, ctx.syncRecordId, 'outer_enrichment_done', { cursor_offset: null });
      return { done: true };
    }

    for (const item of page) {
      try {
        const isComplete = item.image_url && item.price && item.price > 0 && item.unit_cost && item.unit_cost > 0;
        if (isComplete) continue;

        const { data: productData, error: productError } = await ctx.supabase.functions.invoke('fetch-listing-snapshot', { body: { asin: item.asin } });
        if (productError) {
          const errorMsg = productError?.message || JSON.stringify(productError);
          if (errorMsg.includes('Unauthorized') || errorMsg.includes('NOT_FOUND')) continue;
          console.error(`Error fetching data for ${item.asin}:`, productError);
          continue;
        }

        const updateData: any = {};
        if (productData?.data) {
          if (productData.data.title) updateData.title = productData.data.title;
          if (productData.data.image) updateData.image_url = productData.data.image;
          if (productData.data.price) updateData.price = productData.data.price;
        }

        const { data: createdListing } = await ctx.supabase.from('created_listings').select('cost, units, amount').eq('user_id', ctx.userId).eq('asin', item.asin).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (createdListing && !item.unit_cost_manual) {
          const unitCost = getListingUnitCost(createdListing);
          if (unitCost !== null) {
            const stockQty = Math.max(0, Number(item.available || 0) + Number(item.reserved || 0) + Number(item.inbound || 0));
            updateData.cost = unitCost;
            updateData.amount = unitCost * stockQty;
            updateData.units = stockQty;
            updateData.unit_cost_manual = false;
          }
        }

        if (updateData.price && updateData.price > 0) {
          const { data: roiData, error: roiError } = await ctx.supabase.functions.invoke('calculate-roi', { body: { asin: item.asin, price: updateData.price } });
          if (!roiError && roiData?.fees) updateData.fees_json = roiData.fees;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (Object.keys(updateData).length > 0) {
          await ctx.supabase.from('inventory').update(updateData).eq('id', item.id);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (itemError: any) {
        console.error(`Error auto-updating ${item.asin}:`, itemError.message);
      }
    }

    offset += page.length;
    await checkpoint(ctx.supabase, ctx.syncRecordId, 'outer_enrichment_progress', { cursor_offset: offset });
    if (page.length < OUTER_ENRICH_BATCH) {
      await checkpoint(ctx.supabase, ctx.syncRecordId, 'outer_enrichment_done', { cursor_offset: null });
      return { done: true };
    }
  }
  return { done: false };
}

// ---------------------------------------------------------------------------
// Top-level phase dispatcher: loops through phases while budget remains,
// self-continuing (and returning) the moment the deadline is hit.
// ---------------------------------------------------------------------------
async function runPhases(ctx: Ctx, startPhase: string) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  let phase = startPhase;

  try {
    while (true) {
      if (Date.now() >= deadline) {
        await selfContinue(ctx, phase);
        return;
      }

      const { data: row } = await ctx.supabase.from('fnsku_sync_history').select('*').eq('id', ctx.syncRecordId).single();
      if (!row) return;

      if (phase === 'fba_report_requested' || phase === 'fba_polling') {
        const r = await phaseReportPoll(ctx, deadline, 'fba', row);
        if (!r.done) { await selfContinue(ctx, 'fba_polling'); return; }
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'fba_downloading_parsing') {
        const r = await phaseDownloadParseFba(ctx, row);
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'fba_enriching') {
        const r = await phaseEnrichFba(ctx, deadline, row);
        if (!r.done) { await selfContinue(ctx, 'fba_enriching'); return; }
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'fba_applying') {
        const r = await phaseApply(ctx, deadline, 'fba');
        if (!r.done) { await selfContinue(ctx, 'fba_applying'); return; }
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'fba_backfilling') {
        const r = await phaseBackfill(ctx, deadline, row);
        if (!r.done) { await selfContinue(ctx, 'fba_backfilling'); return; }
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'fbm_report_requested' || phase === 'fbm_polling') {
        try {
          const r = await phaseReportPoll(ctx, deadline, 'fbm', row.report_id === row.report_id && phase === 'fbm_report_requested' ? { ...row, report_id: null, poll_attempts: 0 } : row);
          if (!r.done) { await selfContinue(ctx, 'fbm_polling'); return; }
          phase = r.nextPhase!;
        } catch (fbmErr) {
          // Don't fail the whole sync if FBM fails — matches original behavior.
          console.error('FBM report failed, skipping FBM sync:', fbmErr);
          phase = 'completed';
        }
        continue;
      }
      if (phase === 'fbm_downloading_parsing') {
        try {
          const r = await phaseDownloadParseFbm(ctx, row);
          phase = r.nextPhase!;
        } catch (fbmErr) {
          console.error('FBM parse failed, skipping FBM sync:', fbmErr);
          phase = 'completed';
        }
        continue;
      }
      if (phase === 'fbm_applying') {
        const r = await phaseApply(ctx, deadline, 'fbm');
        if (!r.done) { await selfContinue(ctx, 'fbm_applying'); return; }
        phase = r.nextPhase!;
        continue;
      }
      if (phase === 'completed') {
        const { data: fbaCount } = await ctx.supabase.from('fnsku_sync_report_rows').select('id', { count: 'exact', head: true }).eq('sync_id', ctx.syncRecordId).eq('report_type', 'fba');
        const { data: fbmCount } = await ctx.supabase.from('fnsku_sync_report_rows').select('id', { count: 'exact', head: true }).eq('sync_id', ctx.syncRecordId).eq('report_type', 'fbm');
        await ctx.supabase.from('fnsku_sync_history').update({
          status: 'completed',
          sync_completed_at: new Date().toISOString(),
          phase: 'completed',
          cursor_offset: null,
          cursor_total: null,
        }).eq('id', ctx.syncRecordId);
        await ctx.supabase.from('user_sync_status').upsert({
          user_id: ctx.userId, amazon_connected: true, inventory_synced: true,
          inventory_sync_completed_at: new Date().toISOString(), last_error: null,
        }, { onConflict: 'user_id' });
        console.log(`[sync-fnsku-report] core sync completed for ${ctx.userId}`);
        phase = 'outer_enriching';
        continue;
      }
      if (phase === 'outer_enriching') {
        const r = await phaseOuterEnrich(ctx, deadline, row);
        if (!r.done) { await selfContinue(ctx, 'outer_enriching'); return; }
        return;
      }

      console.error(`[sync-fnsku-report] unknown phase "${phase}", aborting`);
      return;
    }
  } catch (err: any) {
    console.error('sync-fnsku-report phase error:', err);
    await ctx.supabase.from('fnsku_sync_history').update({
      status: 'failed',
      sync_completed_at: new Date().toISOString(),
      error_message: err?.message || String(err),
    }).eq('id', ctx.syncRecordId);
    await ctx.supabase.from('user_sync_status').upsert({
      user_id: ctx.userId, amazon_connected: true, inventory_synced: false, last_error: err?.message || String(err),
    }, { onConflict: 'user_id' });
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let requestBody: any = {};
    if (req.method === 'POST') {
      try {
        requestBody = await req.json();
      } catch {
        console.log('No request body or invalid JSON, treating as manual call');
      }
    }

    // ---- Resume path: continuation of an already-started sync ----
    if (requestBody.resume === true && requestBody.syncRecordId) {
      const userId = requestBody.user_id;
      const sellerId = requestBody.seller_id;
      const marketplaceId = requestBody.marketplace_id;
      const refreshToken = requestBody.refresh_token;
      const phase = requestBody.phase;

      const { data: existing } = await supabase.from('fnsku_sync_history').select('id, status').eq('id', requestBody.syncRecordId).eq('user_id', userId).maybeSingle();
      // outer_enriching intentionally continues AFTER status is already
      // 'completed' (it's a non-blocking follow-up, not part of the core
      // signal) — a continuation for that phase must still be resumable, or
      // it silently truncates after whatever one invocation manages to do.
      const resumable = existing && (existing.status === 'in_progress' || (existing.status === 'completed' && phase === 'outer_enriching'));
      if (!resumable) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_resumable' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const accessToken = await getLwaAccessToken(refreshToken);
      const ctx: Ctx = { supabase, supabaseUrl, serviceKey: supabaseKey, syncRecordId: requestBody.syncRecordId, userId, sellerId, marketplaceId, refreshToken, accessToken };

      (globalThis as any).EdgeRuntime?.waitUntil(runPhases(ctx, phase));
      return new Response(JSON.stringify({ ok: true, resumed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- Fresh start ----
    const isAutomatedCall = requestBody.user_id && requestBody.seller_id && requestBody.refresh_token;

    let sellerId: string;
    let marketplaceId: string;
    let refreshToken: string;
    let userId: string;

    if (isAutomatedCall) {
      console.log('Processing automated sync for user:', requestBody.user_id);
      sellerId = requestBody.seller_id;
      marketplaceId = requestBody.marketplace_id;
      refreshToken = requestBody.refresh_token;
      userId = requestBody.user_id;
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      userId = user.id;

      const { data: authRows } = await supabase.from('seller_authorizations').select('seller_id, marketplace_id, refresh_token').eq('user_id', user.id);
      const sellerAuth = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (!sellerAuth) {
        return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      sellerId = sellerAuth.seller_id;
      marketplaceId = sellerAuth.marketplace_id;
      refreshToken = sellerAuth.refresh_token;
    }

    // Cooldown: Amazon's FBA inventory report can only be generated once
    // every 4 hours. Block if the LAST COMPLETED sync was within that window.
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: recentSyncs } = await supabase
      .from('fnsku_sync_history')
      .select('sync_started_at')
      .eq('user_id', userId).eq('seller_id', sellerId).eq('marketplace_id', marketplaceId)
      .eq('status', 'completed')
      .gte('sync_started_at', fourHoursAgo)
      .order('sync_started_at', { ascending: false })
      .limit(1);

    if (recentSyncs && recentSyncs.length > 0) {
      const lastSync = recentSyncs[0];
      const timeSinceLastSync = Date.now() - new Date(lastSync.sync_started_at).getTime();
      const minutesRemaining = Math.ceil((4 * 60 * 60 * 1000 - timeSinceLastSync) / 60000);
      return new Response(JSON.stringify({
        status: 'error', error: 'sync_cooldown',
        message: `Amazon's FBA inventory report can only be generated once every 4 hours (Amazon limitation). Please wait ${minutesRemaining} more minutes before syncing again.`,
        lastSyncTime: lastSync.sync_started_at, minutesRemaining, httpStatus: 429,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Active-sync check: a genuinely still-running sync (heartbeat within
    // the last 15 min — matches the timed_out safety-net threshold, so a
    // truly stalled run doesn't block new attempts forever like before).
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: activeSyncs } = await supabase
      .from('fnsku_sync_history')
      .select('id, sync_started_at, status, last_heartbeat_at')
      .eq('user_id', userId).eq('seller_id', sellerId).eq('marketplace_id', marketplaceId)
      .eq('status', 'in_progress')
      .gte('last_heartbeat_at', fifteenMinutesAgo)
      .order('sync_started_at', { ascending: false })
      .limit(1);

    if (activeSyncs && activeSyncs.length > 0) {
      const runningSync = activeSyncs[0];
      return new Response(JSON.stringify({
        status: 'error', error: 'sync_in_progress',
        message: 'A sync is already running in the background. Please wait for it to finish before starting another one.',
        runningSyncId: runningSync.id, startedAt: runningSync.sync_started_at, httpStatus: 429,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const nowIso = new Date().toISOString();
    const { data: syncRecord, error: syncRecordError } = await supabase
      .from('fnsku_sync_history')
      .insert({ user_id: userId, seller_id: sellerId, marketplace_id: marketplaceId, status: 'in_progress', phase: 'fba_report_requested', last_heartbeat_at: nowIso })
      .select()
      .single();

    if (syncRecordError || !syncRecord) {
      console.error('Failed to create sync history record:', syncRecordError);
      return new Response(JSON.stringify({ error: 'Failed to start sync' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const accessToken = await getLwaAccessToken(refreshToken);
    const ctx: Ctx = { supabase, supabaseUrl, serviceKey: supabaseKey, syncRecordId: syncRecord.id, userId, sellerId, marketplaceId, refreshToken, accessToken };

    if ((globalThis as any).EdgeRuntime?.waitUntil) {
      (globalThis as any).EdgeRuntime.waitUntil(runPhases(ctx, 'fba_report_requested'));
    } else {
      runPhases(ctx, 'fba_report_requested');
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Sync started successfully. This may take several minutes for large inventories.',
      syncRecordId: syncRecord.id,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('sync-fnsku-report error:', error);
    return new Response(JSON.stringify({ error: error?.message || String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
