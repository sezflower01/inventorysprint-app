import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { nextPage } from './itemPagination.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing helpers
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return await crypto.subtle.digest('SHA-256', encoder.encode(message));
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));
  
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  
  const canonicalRequest = [method, urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  
  const signingKey = await getSigningKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One per-shipment item fetch, measured. Added 2026-11-18 because the phase
 * breadcrumbs showed only 6 fetches in 77s and 4 in 98s, all returning zero
 * items, and nothing in the logs said which half was slow. `gate_ms` is time
 * blocked on our own shared rate limiter; `call_ms` is time inside callSpApi,
 * which retries a 429 up to 3 attempts with backoff. Separating them is the
 * whole point: the two have completely different fixes.
 */
interface ItemFetchProbe {
  shipment_id: string;
  source: string;
  gate_ms: number;
  gate_ok: boolean;
  call_ms: number;
  ok: boolean;
  status?: number;
  items: number;
  bytes?: number;
  error?: string;
}

class SpApiError extends Error {
  constructor(public status: number, public responseText: string) {
    super(`SP-API error: ${status} - ${responseText}`);
  }
}

async function callSpApi(method: string, url: string, accessToken: string, body = '', maxRetries = 2): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = await signRequest(method, url, body, accessToken);
    
    const fetchHeaders: Record<string, string> = {
      'Authorization': headers['Authorization'],
      'x-amz-date': headers['x-amz-date'],
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body || undefined,
    });

    const text = await response.text();
    
    if (response.ok) {
      return text ? JSON.parse(text) : {};
    }

    const retryable = response.status === 429 || response.status === 500 || response.status === 503 || response.status === 504;
    if (retryable && attempt < maxRetries) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.min(15000, 2000 * Math.pow(2, attempt));
      console.warn(`[SP-API] ${response.status} retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(delayMs);
      continue;
    }

    throw new SpApiError(response.status, text);
  }

  throw new Error('SP-API request failed after retries');
}

function buildV0ShipmentListUrl(params: URLSearchParams, nextToken: string | null): string {
  if (!nextToken) {
    return `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?${params.toString()}`;
  }

  const nextParams = new URLSearchParams();
  nextParams.set('QueryType', 'NEXT_TOKEN');
  nextParams.set('NextToken', nextToken);
  return `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?${nextParams.toString()}`;
}

async function fetchCatalogSummary(
  supabase: any,
  asin: string,
  marketplaceId: string,
  accessToken: string,
  fallbackTitle?: string | null,
  fallbackImageUrl?: string | null,
): Promise<{ asin: string; title?: string; image_url?: string }> {
  const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,images`;
  await waitForApiToken(supabase, 'catalog_api');
  const catalogResponse = await callSpApi('GET', catalogUrl, accessToken);
  const summaries = catalogResponse?.summaries || [];
  const images = catalogResponse?.images || [];
  const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];
  const imageSet = images.find((i: any) => i.marketplaceId === marketplaceId) || images[0];
  const mainImage = imageSet?.images?.find((img: any) => img.variant === 'MAIN') || imageSet?.images?.[0];

  return {
    asin,
    title: summary?.itemName || fallbackTitle || undefined,
    image_url: mainImage?.link || fallbackImageUrl || undefined,
  };
}

function quantityValue(...values: any[]): number {
  for (const value of values) {
    const raw = typeof value === 'object' && value !== null
      ? value.amount ?? value.quantity ?? value.value
      : value;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Items fetched, plus why the fetch ended if it ended badly.
 *
 * Returns rather than throws, because the call site's `catch` used to swallow
 * the error AND the items together: on 2026-11-18 fifteen genuinely fetched
 * items were discarded when a later call in the same loop 429'd, and the run
 * reported "0 items" -- indistinguishable from Amazon saying there are none.
 * Partial data and a recorded failure are two separate facts; both travel.
 */
interface ItemFetchResult {
  items: any[];
  error?: string;
  status?: number;
}

/**
 * ONE call. There is no second page, and asking for one is what broke this.
 *
 * `getShipmentItemsByShipmentId` declares exactly two parameters in Amazon's
 * model file -- `shipmentId` (path) and `MarketplaceId` (query, documented as
 * "Deprecated. Do not use.") -- and NO NextToken. Its 200 response nonetheless
 * reuses the shared GetShipmentItemsResponse schema, which carries a NextToken
 * for the bulk `/fba/inbound/v0/shipmentItems` operation. So this endpoint
 * hands back a token it will never honour.
 *
 * The previous `do { ... } while (nextToken)` fed that token back as a query
 * parameter the endpoint ignores, got the identical page again, and looped:
 * 54 calls on FBA19RKR64KC, each 200 OK / 4,735 bytes / 15 items / ~100ms,
 * ending in 429 QuotaExceeded. That single loop was the entire cause of the
 * "12-25s per shipment returning nothing" symptom, and it drained the shared
 * inbound quota that every other inbound caller depends on.
 *
 * MarketplaceId is dropped as well: Amazon marks it deprecated, and sending it
 * is what made the URL look paginable in the first place.
 */
async function fetchV0ShipmentItems(supabase: any, shipmentId: string, accessToken: string, probe?: ItemFetchProbe[]): Promise<ItemFetchResult> {
  const itemsUrl = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`;

  // Measured separately -- see ItemFetchProbe. A long gate_ms means the
  // shared bucket is starved; a long call_ms means Amazon is throttling us
  // inside callSpApi's retry loop.
  const gateStart = Date.now();
  const gateOk = await waitForApiToken(supabase, 'inbound_api');
  const gateMs = Date.now() - gateStart;
  const callStart = Date.now();

  let itemsResponse: any;
  try {
    itemsResponse = await callSpApi('GET', itemsUrl, accessToken);
  } catch (e) {
    const status = (e as any)?.status;
    const message = String((e as any)?.message ?? e).slice(0, 200);
    probe?.push({
      shipment_id: shipmentId,
      source: 'v0',
      gate_ms: gateMs,
      gate_ok: gateOk,
      call_ms: Date.now() - callStart,
      ok: false,
      status,
      items: 0,
      error: message,
    });
    return { items: [], error: message, status };
  }

  const items = Array.isArray(itemsResponse.payload?.ItemData) ? itemsResponse.payload.ItemData : [];
  probe?.push({
    shipment_id: shipmentId,
    source: 'v0',
    gate_ms: gateMs,
    gate_ok: gateOk,
    call_ms: Date.now() - callStart,
    ok: true,
    status: 200,
    items: items.length,
    bytes: JSON.stringify(itemsResponse ?? {}).length,
  });
  return { items };
}

/**
 * The 2024-03-20 endpoint really does page: `paginationToken` in,
 * `pagination.nextToken` out. Unlike the v0 per-shipment call, looping here is
 * correct -- but the loop is now gated by itemPagination.nextPage, which
 * refuses a token it has already sent and caps total pages. The v0 bug proved
 * that "the response contains a token" and "there is another page" are not the
 * same fact, and this endpoint gets the same protection even though nothing
 * has gone wrong with it. Partial pages are kept on failure, for the reason in
 * ItemFetchResult.
 */
async function fetchV2024ShipmentItems(supabase: any, inboundPlanId: string, internalShipmentId: string, accessToken: string): Promise<ItemFetchResult> {
  const collected: any[] = [];
  let nextToken: string | null = null;
  const seenTokens = new Set<string>();
  let pagesFetched = 0;

  for (;;) {
    const params = new URLSearchParams({ pageSize: '100' });
    if (nextToken) params.set('paginationToken', nextToken);
    const itemsUrl = `https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(internalShipmentId)}/items?${params.toString()}`;
    await waitForApiToken(supabase, 'inbound_api');

    let response: any;
    try {
      response = await callSpApi('GET', itemsUrl, accessToken, '', 3);
    } catch (e) {
      // Keep the pages already collected; report why we stopped.
      return {
        items: collected,
        error: String((e as any)?.message ?? e).slice(0, 200),
        status: (e as any)?.status,
      };
    }

    const items = Array.isArray(response?.items) ? response.items : [];
    collected.push(...items);
    pagesFetched++;

    const decision = nextPage({
      sentToken: nextToken,
      receivedToken: response?.pagination?.nextToken,
      pagesFetched,
      maxPages: 20,
      seenTokens,
    });
    if (!decision.advance) {
      if (response?.pagination?.nextToken) {
        console.log(`[v2024-items] ${internalShipmentId}: stopped paging -- ${decision.reason}`);
      }
      break;
    }
    nextToken = decision.token;
    seenTokens.add(decision.token!);
  }

  return { items: collected };
}

async function upsertShipmentItems(supabase: any, userId: string, shipmentId: string, items: any[]): Promise<number> {
  const rows: any[] = [];
  for (const item of items) {
    const sellerSku = item?.SellerSKU || item?.sellerSku || item?.msku || item?.merchantSku || item?.sku;
    if (!sellerSku) continue;

    const itemData: any = {
      user_id: userId,
      shipment_id: shipmentId,
      seller_sku: sellerSku,
      fnsku: item?.FulfillmentNetworkSKU || item?.fnsku || item?.FNSKU || null,
      asin: item?.ASIN || item?.asin || null,
      quantity_shipped: quantityValue(item?.QuantityShipped, item?.quantityShipped, item?.expectedQuantity, item?.quantity),
      quantity_received: quantityValue(item?.QuantityReceived, item?.quantityReceived, item?.receivedQuantity),
      quantity_in_case: quantityValue(item?.QuantityInCase, item?.quantityInCase),
      updated_at: new Date().toISOString(),
    };
    if (item?.title || item?.itemName || item?.productName) itemData.title = item.title || item.itemName || item.productName;
    if (item?.image_url || item?.imageUrl) itemData.image_url = item.image_url || item.imageUrl;
    rows.push(itemData);
  }

  if (rows.length === 0) return 0;

  // Batch upsert (one round-trip instead of N)
  const { error } = await supabase
    .from('fba_shipment_items')
    .upsert(rows, { onConflict: 'user_id,shipment_id,seller_sku' });
  if (error) {
    console.log(`Batch upsert error for ${shipmentId}:`, error.message);
    return 0;
  }
  return rows.length;
}

async function discoverV2024Shipments(
  supabase: any,
  accessToken: string,
  lookbackDays: number,
  requestedConfirmationId?: string | null,
): Promise<any[]> {
  const after = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const planStatuses: Array<string | null> = requestedConfirmationId ? [null, 'ACTIVE', 'SHIPPED'] : [null];
  const seenPlans = new Set<string>();
  const discovered: any[] = [];
  // Targeted lookup: scan deeply (up to 150). Bulk sync: 60 to balance quota vs coverage.
  const MAX_PLAN_DETAIL_CALLS = requestedConfirmationId ? 150 : 60;
  let planDetailCalls = 0;

  const addFromShipmentDetails = (plan: any, details: any) => {
    const internalShipmentId = details?.shipmentId;
    const confirmationId = details?.shipmentConfirmationId || details?.shipmentId;
    if (!confirmationId) return false;
    if (requestedConfirmationId && confirmationId !== requestedConfirmationId) return false;

    discovered.push({
      ShipmentId: confirmationId,
      ShipmentName: details?.name || plan?.name || null,
      DestinationFulfillmentCenterId: details?.destination?.warehouseId || null,
      ShipmentStatus: details?.status || 'UNKNOWN',
      LabelPrepType: null,
      AreCasesRequired: false,
      BoxContentsSource: null,
      __source: 'v2024',
      __inboundPlanId: plan?.inboundPlanId,
      __v2024ShipmentId: internalShipmentId,
    });
    return true;
  };

  for (const planStatus of planStatuses) {
    let planToken: string | null = null;
    let planPage = 1;
    const maxPlanPages = requestedConfirmationId ? 30 : Math.min(60, Math.max(4, Math.ceil(lookbackDays / 10)));

    do {
      const planParams = new URLSearchParams();
      planParams.set('pageSize', requestedConfirmationId ? '30' : '15');
      planParams.set('sortBy', 'LAST_UPDATED_TIME');
      planParams.set('sortOrder', 'DESC');
      if (planStatus) planParams.set('status', planStatus);
      if (planToken) planParams.set('paginationToken', planToken);

      const planUrl = `https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans?${planParams.toString()}`;
      console.log(`[PHASE 1.5] v2024 inboundPlans status=${planStatus || 'ALL'} page ${planPage}/${maxPlanPages}...`);

      let planResp: any;
      try {
        await waitForApiToken(supabase, 'inbound_api');
        planResp = await callSpApi('GET', planUrl, accessToken);
      } catch (e: any) {
        console.error(`[PHASE 1.5] inboundPlans failed status=${planStatus || 'ALL'}: ${e?.message?.slice(0, 120)}`);
        break;
      }

      const plans = Array.isArray(planResp?.inboundPlans) ? planResp.inboundPlans : [];
      let stopPaging = false;

      for (const plan of plans) {
        const planId: string | undefined = plan?.inboundPlanId;
        const planUpdated: string | undefined = plan?.lastUpdatedAt || plan?.lastUpdatedTime || plan?.createdAt;
        if (planUpdated && planUpdated < after) {
          stopPaging = true;
          break;
        }
        if (!planId || seenPlans.has(planId)) continue;
        seenPlans.add(planId);

        try {
          planDetailCalls++;
          const detailUrl = `https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}`;
          await waitForApiToken(supabase, 'inbound_api');
          const planDetails = await callSpApi('GET', detailUrl, accessToken, '', 3);
          const shipments = Array.isArray(planDetails?.shipments) ? planDetails.shipments : [];

          for (const summary of shipments) {
            const internalShipmentId = summary?.shipmentId;
            if (!internalShipmentId) continue;

            try {
              const shipmentUrl = `https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(internalShipmentId)}`;
              await waitForApiToken(supabase, 'inbound_api');
              const details = await callSpApi('GET', shipmentUrl, accessToken, '', 3);
              if (addFromShipmentDetails(plan, details) && requestedConfirmationId) return discovered;
              await sleep(requestedConfirmationId ? 1200 : 2000);
            } catch (e: any) {
              if (e instanceof SpApiError && e.status === 429) {
                console.warn(`[PHASE 1.5] shipment detail quota reached; returning ${discovered.length} discovered shipments so far`);
                return discovered;
              }
              console.error(`[PHASE 1.5] getShipment plan=${planId} shipment=${internalShipmentId} failed: ${e?.message?.slice(0, 100)}`);
            }
          }
        } catch (e: any) {
          if (e instanceof SpApiError && e.status === 429) {
            console.warn(`[PHASE 1.5] plan detail quota reached; returning ${discovered.length} discovered shipments so far`);
            return discovered;
          }
          console.error(`[PHASE 1.5] plan ${planId} detail failed: ${e?.message?.slice(0, 100)}`);
        }

        if (planDetailCalls >= MAX_PLAN_DETAIL_CALLS) {
          console.log(`[PHASE 1.5] Stopped at ${planDetailCalls} v2024 plan detail calls to avoid Amazon quota exhaustion`);
          return discovered;
        }

        await sleep(requestedConfirmationId ? 1200 : 2500);
      }

      planToken = stopPaging ? null : (planResp?.pagination?.nextToken || null);
      planPage++;
      if (planToken) await sleep(requestedConfirmationId ? 1500 : 3000);
    } while (planToken && planPage <= maxPlanPages);
  }

  return discovered;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Optional request body (allows syncing a specific shipment id or date range)
    const requestBody: any = await req.json().catch(() => ({}));
    const requestedShipmentId: string | null =
      typeof requestBody?.shipmentId === 'string' && requestBody.shipmentId.trim()
        ? requestBody.shipmentId.trim()
        : typeof requestBody?.shipment_id === 'string' && requestBody.shipment_id.trim()
          ? requestBody.shipment_id.trim()
          : null;
    
    // DATE_RANGE parameters for chunked historical syncs
    const dateRangeStart: string | null =
      typeof requestBody?.dateRangeStart === 'string' ? requestBody.dateRangeStart.trim() : null;
    const dateRangeEnd: string | null =
      typeof requestBody?.dateRangeEnd === 'string' ? requestBody.dateRangeEnd.trim() : null;

    // Optional override for the PHASE 1 lookback window (default 60 days).
    // Used by the "Sync Missing" UI to widen the net to 90 days without ID input.
    const lookbackDaysRaw = Number(requestBody?.lookbackDays);
    const lookbackDays: number = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
      ? Math.min(Math.floor(lookbackDaysRaw), 730)
      : 60;

    // Fast mode: skip per-shipment item fetches & catalog enrichment so the
    // function can complete within edge-function timeout when scanning wide
    // windows (e.g. 90-day "Sync Missing"). Headers-only sync.
    const headersOnly: boolean = requestBody?.headersOnly === true;

    // Skip the catalogue enrichment pass only. Items and v2024 discovery still
    // run -- this is NOT headersOnly.
    //
    // WHY THIS EXISTS. The enrichment block below is the single unbounded phase
    // in this function, and it is scoped to the USER'S WHOLE HISTORY rather than
    // to the shipments just synced: it selects up to 10,000 fba_shipment_items
    // rows with a null asin/title/image, makes a rate-limited SP-API catalog
    // call per unique SKU, then issues up to 10,000 SEQUENTIAL single-row
    // UPDATEs. Because asin is null on write by design (Amazon's
    // InboundShipmentItem payload has no ASIN field), almost every historical
    // row qualifies forever, so the work does not shrink as syncs succeed.
    //
    // Measured 2026-11-18: catchup-fba-shipments-recent ran 151,610 ms, of
    // which 150,000 was this function being cut off by the platform's 150s
    // idle-timeout, returning 504 to its caller. The browser's own "Sync"
    // button hits the same wall.
    //
    // Nothing downstream needs it: /tools/unshipped-purchases resolves a line's
    // ASIN through seller_sku (src/lib/shipmentAttribution.ts, commit a148880)
    // precisely because this column is normally null. Enrichment is a backfill
    // concern, not part of a sync, so the cron opts out and the browser keeps
    // the old behaviour by default.
    const skipEnrichment: boolean = requestBody?.skipEnrichment === true;

    // -- BOUNDING THE ITEM LOOP --------------------------------------------
    // The per-shipment loop further down is the phase that actually exceeds
    // the platform 150s idle timeout. It is proportional to how many shipments
    // the discovery phases found, and each iteration costs one SP-API call
    // plus a hardcoded 300ms sleep -- so a few hundred shipments cannot fit,
    // and no amount of retrying changes that. Measured 2026-11-18: two runs,
    // 151,610 ms and 151,620 ms, both killed at exactly 150s having written
    // nothing, because nothing is persisted until that loop is reached.
    //
    // All of these default to off/unlimited, so the browser Sync button
    // behaves exactly as it did before.
    const itemFetchBudgetRaw = Number(requestBody?.itemFetchBudgetMs);
    const itemFetchBudgetMs: number | null =
      Number.isFinite(itemFetchBudgetRaw) && itemFetchBudgetRaw > 0
        ? Math.floor(itemFetchBudgetRaw)
        : null;
    // The cursor, stateless on purpose: a shipment is done when rows already
    // exist for it in fba_shipment_items. No progress table to drift out of
    // step with reality, and a repeated run resumes instead of redoing the
    // same shipments until the budget runs out again.
    const skipShipmentsWithItems: boolean = requestBody?.skipShipmentsWithItems === true;

    // -- PHASE 1.5 IS OPT-IN NOW, BECAUSE IT HAS NEVER ACTUALLY RUN --------
    // Its call site passed (accessToken, recentDays) to a function declared
    // (supabase, accessToken, lookbackDays, requestedConfirmationId): two of
    // the four, shifted by one. lookbackDays therefore arrived undefined, so
    // new Date(Date.now() - undefined * 86400000).toISOString() threw
    // RangeError on the first line, every single time, caught by the
    // surrounding try/catch and logged as "v2024 discovery failed". tsc has
    // been reporting it as TS2554 all along.
    //
    // The arguments are corrected below, but the gate is kept OFF by default
    // rather than silently switching on a phase this account has never
    // exercised and whose own comment says it blows the edge-worker wall-time
    // at up to 54 pages of detail calls. Pass includeV2024: true to test
    // whether Send-to-Amazon shipments are being missed.
    const includeV2024: boolean = requestBody?.includeV2024 === true;

    // Write a breadcrumb to cron_run_history before each phase, so a request
    // killed by the platform still says which phase it was in. A kill leaves
    // no return value and so no response to inspect; these rows are the only
    // evidence that survives one.
    const phaseTrace: boolean = requestBody?.phaseTrace === true;

    // -- A HARD BUDGET ON THE WHOLE LOOP, NOT JUST THE ITEM FETCHES ---------
    // itemFetchBudgetMs stops the SP-API calls but the loop still runs on,
    // upserting headers for every remaining shipment. Measured 2026-11-18:
    // the item budget tripped at 77.7s and the call still had not returned at
    // ~91.5s. The wrapper treats this value as the inner worst case when it
    // decides whether another call fits (see catchup-fba-shipments/reentry.ts),
    // so an unbounded tail makes that arithmetic unsound and gets the WRAPPER
    // killed. Default null = unlimited, so the browser path is unchanged.
    const totalBudgetRaw = Number(requestBody?.totalBudgetMs);
    const totalBudgetMs: number | null =
      Number.isFinite(totalBudgetRaw) && totalBudgetRaw > 0 ? Math.floor(totalBudgetRaw) : null;

    // How many per-shipment item fetches to measure in detail. 0 = none.
    const traceItemFetchesRaw = Number(requestBody?.traceItemFetches);
    const traceItemFetches: number =
      Number.isFinite(traceItemFetchesRaw) && traceItemFetchesRaw > 0
        ? Math.min(25, Math.floor(traceItemFetchesRaw))
        : 0;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const T0 = Date.now();
    const phaseLog: Array<{ phase: string; at_ms: number; [k: string]: unknown }> = [];
    const markPhase = async (phase: string, extra: Record<string, unknown> = {}) => {
      const at_ms = Date.now() - T0;
      phaseLog.push({ phase, at_ms, ...extra });
      console.log(`[PHASE_TRACE] ${phase} at ${at_ms}ms ${JSON.stringify(extra)}`);
      if (!phaseTrace) return;
      try {
        await supabase.rpc('record_cron_run', {
          p_job_name: 'sync-fba-shipments-phase',
          p_status: 'started',
          p_duration_ms: at_ms,
          p_items_processed: 0,
          p_error: null,
          p_detail: { phase, ...extra },
        });
      } catch (_e) { /* tracing must never break the sync */ }
    };

    // Auth: either a user JWT, OR an internal-secret + body.user_id (used by catch-up cron)
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    let userId: string | null = null;

    if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
      const bodyUserId = typeof requestBody?.user_id === 'string' ? requestBody.user_id.trim() : '';
      if (!bodyUserId) {
        throw new Error('user_id required when using internal-secret auth');
      }
      userId = bodyUserId;
      console.log(`[INTERNAL] Syncing FBA shipments for user: ${userId}`);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        throw new Error('Missing authorization header');
      }
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        throw new Error('Unauthorized');
      }
      userId = user.id;
      console.log(`Syncing FBA shipments for user: ${userId}`);
    }

    // Wrap to keep downstream `user.id` references working with minimal change
    const user = { id: userId } as { id: string };

    // Get seller authorization — user may have multiple rows (one per marketplace).
    // Prefer US (ATVPDKIKX0DER) since FBA inbound shipments live in NA endpoint.
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, created_at')
      .eq('user_id', user.id);

    console.log(`[AUTH_LOOKUP] user_id=${user.id} rows_found=${authRows?.length ?? 0} error=${authError?.message ?? 'none'}`);

    if (authError || !authRows || authRows.length === 0) {
      throw new Error('No Amazon seller authorization found. Please connect your Amazon account first.');
    }

    // Prefer US marketplace, then CA, then any NA marketplace, else first row
    const NA_MARKETPLACES = ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'];
    const auth =
      authRows.find((r: any) => r.marketplace_id === 'ATVPDKIKX0DER') ||
      authRows.find((r: any) => NA_MARKETPLACES.includes(r.marketplace_id)) ||
      authRows[0];

    console.log(`[AUTH_SELECTED] marketplace_id=${auth.marketplace_id} seller_id=${auth.seller_id}`);

    const marketplaceId = auth.marketplace_id || 'ATVPDKIKX0DER';

    // Get LWA access token
    const accessToken = await getLwaAccessToken(auth.refresh_token);
    console.log('Got LWA access token');

    // If the caller provided a shipment id, fetch it directly (avoids paging + reduces quota usage)
    if (requestedShipmentId) {
      // ===== ITEMS-ONLY FAST PATH =====
      // When the shipment row already exists in DB (typical interactive case where the
      // user clicks to expand a shipment that has 0 cached item lines), skip the entire
      // shipment lookup + v2024 plan-scan dance. Just race the v0 items endpoint across
      // NA marketplaces in parallel and take the first non-empty result. Cuts wait from
      // 30-60s down to ~1-3s.
      const { data: existingShipmentRows } = await supabase
        .from('fba_shipments')
        .select('shipment_id')
        .eq('user_id', user.id)
        .eq('shipment_id', requestedShipmentId)
        .limit(1);
      const shipmentExists = (existingShipmentRows || []).length > 0;

      if (shipmentExists) {
        // STEP 1: If items are already cached in DB, return immediately (no SP-API call).
        // This avoids hitting v0 quota (429) for shipments we've already fetched once.
        const { count: cachedItemsCount } = await supabase
          .from('fba_shipment_items')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('shipment_id', requestedShipmentId);

        if ((cachedItemsCount || 0) > 0) {
          console.log(`[FAST_PATH] Shipment ${requestedShipmentId} has ${cachedItemsCount} cached items — returning from DB`);
          return new Response(
            JSON.stringify({ success: true, mode: 'cached', shipmentId: requestedShipmentId, itemsCount: cachedItemsCount }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        // STEP 2: No cache — try the lightweight v0 item endpoint across NA marketplaces.
        // Do NOT fall through into full v2024 discovery for an already-known shipment; that scan can
        // run past the edge-function timeout and makes the UI look like nothing happened.
        // ONE ATTEMPT, NOT ONE PER MARKETPLACE.
        //
        // This used to loop over every known marketplace id, passing each as
        // MarketplaceId. Amazon's model file marks that parameter "Deprecated.
        // Do not use." on getShipmentItemsByShipmentId, so the endpoint ignored
        // it and all four requests were byte-identical -- four calls against a
        // shared 2 rps inbound quota to learn one thing once. The retry only
        // ever looked useful because a shipment with no items returned nothing
        // each time round.
        const fastAttempts: string[] = [];
        console.log(`[FAST_PATH] Shipment ${requestedShipmentId} exists, no cached items — fetching v0 items only`);
        {
          try {
            const fastResult = await fetchV0ShipmentItems(supabase, requestedShipmentId, accessToken);
            const bestItems = fastResult.items;
            fastAttempts.push(`v0:${bestItems.length}${fastResult.error ? ` (${fastResult.status ?? '?'})` : ''}`);
            if (bestItems.length > 0) {
              const itemsCount = await upsertShipmentItems(supabase, user.id, requestedShipmentId, bestItems);
              console.log(`[FAST_PATH] Got ${bestItems.length} items, upserted=${itemsCount}`);
              return new Response(
                JSON.stringify({ success: true, mode: 'single_fast', shipmentId: requestedShipmentId, itemsCount }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
              );
            }
          } catch (e: any) {
            fastAttempts.push(`v0:ERR(${(e?.message || '').slice(0, 80)})`);
          }
        }

        console.log(`[FAST_PATH] No item lines returned quickly for ${requestedShipmentId}. Attempts: ${fastAttempts.join(', ')}`);
        return new Response(
          JSON.stringify({ success: true, mode: 'single_fast_empty', shipmentId: requestedShipmentId, itemsCount: 0, attempts: fastAttempts }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log(`[DIRECT] Syncing single shipment: ${requestedShipmentId}`);

      // SP-API v0 requires using ShipmentIdList param on the list endpoint - there's no /shipments/{id} endpoint.
      // The shipment may live on any of the user's NA marketplaces (US/CA/MX/BR), so try each one
      // until we find it. We also try once with NO marketplace filter as a final fallback because
      // some shipments (especially older / closed ones) only return when MarketplaceId is omitted.
      const candidateMarketplaces = Array.from(
        new Set([
          marketplaceId,
          ...(authRows || []).map((r: any) => r.marketplace_id).filter(Boolean),
          'ATVPDKIKX0DER', // US
          'A2EUQ1WTGCTBG2', // CA
          'A1AM78C64UM0Y8', // MX
          'A2Q3Y263D00KWC', // BR
        ]),
      );

      let shipment: any = null;
      const attempts: string[] = [];

      for (const mp of candidateMarketplaces) {
        const url = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?MarketplaceId=${mp}&QueryType=SHIPMENT&ShipmentIdList=${encodeURIComponent(requestedShipmentId)}`;
        try {
          await waitForApiToken(supabase, 'inbound_api');
          const resp = await callSpApi('GET', url, accessToken);
          const list = resp?.payload?.ShipmentData || [];
          attempts.push(`${mp}:${list.length}`);
          if (list[0]?.ShipmentId) {
            shipment = list[0];
            // Which marketplace answered is recorded in this log line rather
            // than a variable: the per-shipment items call no longer takes a
            // MarketplaceId, because Amazon deprecated it on that operation.
            console.log(`[DIRECT] Found ${requestedShipmentId} on marketplace ${mp}`);
            break;
          }
        } catch (e: any) {
          attempts.push(`${mp}:ERR(${(e?.message || '').slice(0, 60)})`);
        }
      }

      // Final fallback: try without MarketplaceId filter
      if (!shipment) {
        const url = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?QueryType=SHIPMENT&ShipmentIdList=${encodeURIComponent(requestedShipmentId)}`;
        try {
          await waitForApiToken(supabase, 'inbound_api');
          const resp = await callSpApi('GET', url, accessToken);
          const list = resp?.payload?.ShipmentData || [];
          attempts.push(`no-mp:${list.length}`);
          if (list[0]?.ShipmentId) {
            shipment = list[0];
            console.log(`[DIRECT] Found ${requestedShipmentId} without marketplace filter`);
          }
        } catch (e: any) {
          attempts.push(`no-mp:ERR(${(e?.message || '').slice(0, 60)})`);
        }
      }

      // ===== v2024 Inbound API fallback (new STA workflow shipments) =====
      // v2024 does not support lookup by the visible FBA confirmation id directly.
      // Scan recent plans -> placement options -> internal shipment details, then match shipmentConfirmationId.
      let v2024Shipment: any = null;
      if (!shipment) {
        try {
          const matches = await discoverV2024Shipments(supabase, accessToken, Math.max(lookbackDays, 90), requestedShipmentId);
          attempts.push(`v2024-scan:${matches.length}`);
          if (matches[0]?.ShipmentId) {
            v2024Shipment = matches[0];
            console.log(`[DIRECT] Found ${requestedShipmentId} via v2024 Inbound API`);
          }
        } catch (e: any) {
          attempts.push(`v2024-scan:ERR(${(e?.message || '').slice(0, 80)})`);
        }
      }

      console.log(`[DIRECT] Lookup attempts: ${attempts.join(', ')}`);

      if (!shipment && !v2024Shipment) {
        throw new Error(
          `Shipment "${requestedShipmentId}" not found via v0 or v2024 Inbound APIs across your marketplaces (US/CA/MX/BR). ` +
          `Attempts: ${attempts.join(', ')}`,
        );
      }

      const shipmentData = shipment
        ? {
            user_id: user.id,
            shipment_id: shipment.ShipmentId,
            shipment_name: shipment.ShipmentName || v2024Shipment?.ShipmentName || null,
            destination_fulfillment_center_id: shipment.DestinationFulfillmentCenterId || v2024Shipment?.DestinationFulfillmentCenterId || null,
            shipment_status: shipment.ShipmentStatus || v2024Shipment?.ShipmentStatus || null,
            label_prep_type: shipment.LabelPrepType || null,
            are_cases_required: shipment.AreCasesRequired || false,
            box_contents_source: shipment.BoxContentsSource || null,
            updated_at: new Date().toISOString(),
          }
        : {
            user_id: user.id,
            shipment_id: v2024Shipment.ShipmentId || requestedShipmentId,
            shipment_name: v2024Shipment.ShipmentName || null,
            destination_fulfillment_center_id:
              v2024Shipment.DestinationFulfillmentCenterId || null,
            shipment_status: v2024Shipment.ShipmentStatus || null,
            label_prep_type: null,
            are_cases_required: false,
            box_contents_source: null,
            updated_at: new Date().toISOString(),
          };

      const { error: upsertError } = await supabase
        .from('fba_shipments')
        .upsert(shipmentData, { onConflict: 'user_id,shipment_id' });

      if (upsertError) {
        throw new Error(`Error upserting shipment ${requestedShipmentId}: ${upsertError.message}`);
      }

      // Fetch items - try v0 first, then v2024 if needed
      let itemsCount = 0;
      try {
        const v0Result = await fetchV0ShipmentItems(supabase, requestedShipmentId, accessToken);
        if (v0Result.items.length > 0) {
          itemsCount += await upsertShipmentItems(supabase, user.id, requestedShipmentId, v0Result.items);
        }
        console.log(`[DIRECT] v0 items for ${requestedShipmentId}: fetched=${v0Result.items.length} upserted=${itemsCount}${v0Result.error ? ` error=${v0Result.status ?? '?'} ${v0Result.error}` : ''}`);
      } catch (e: any) {
        console.log(`[DIRECT] v0 items fetch failed: ${e?.message?.slice(0, 100)}`);
      }

      // v2024 items fallback (paginate through items endpoint)
      if (itemsCount === 0) {
        try {
          const v2024PlanId = v2024Shipment?.__inboundPlanId;
          const v2024InternalShipmentId = v2024Shipment?.__v2024ShipmentId;
          if (!v2024PlanId || !v2024InternalShipmentId) {
            throw new Error('Missing v2024 plan/internal shipment id for item lookup');
          }
          const v2024Result = await fetchV2024ShipmentItems(supabase, v2024PlanId, v2024InternalShipmentId, accessToken);
          if (v2024Result.items.length > 0) {
            itemsCount += await upsertShipmentItems(supabase, user.id, requestedShipmentId, v2024Result.items);
          }
          console.log(`[DIRECT] v2024 items for ${requestedShipmentId}: fetched=${v2024Result.items.length} upserted=${itemsCount}${v2024Result.error ? ` error=${v2024Result.status ?? '?'} ${v2024Result.error}` : ''}`);
        } catch (e: any) {
          console.log(`[DIRECT] v2024 items fetch failed: ${e?.message?.slice(0, 100)}`);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'single',
          source: shipment?.__source || (shipment ? 'v0' : 'v2024'),
          shipmentId: requestedShipmentId,
          itemsCount,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // =====================================================================
    // CUSTOM DATE_RANGE SYNC (used by OAuth callback for 2-year historical)
    // =====================================================================
    if (dateRangeStart && dateRangeEnd) {
      console.log(`[DATE_RANGE] Custom sync from ${dateRangeStart} to ${dateRangeEnd}`);

      const rangeShipments: any[] = [];
      const rangeSeenIds = new Set<string>();
      const startISO = new Date(dateRangeStart).toISOString();
      const endISO = new Date(dateRangeEnd).toISOString();

      // SP-API requires ShipmentStatusList for DATE_RANGE queries.
      // Iterate every relevant status so we don't miss anything in the window.
      const STATUSES = [
        'WORKING',
        'SHIPPED',
        'IN_TRANSIT',
        'DELIVERED',
        'CHECKED_IN',
        'RECEIVING',
        'CLOSED',
        'CANCELLED',
        'DELETED',
        'ERROR',
      ];

      for (const status of STATUSES) {
        try {
          let nextToken: string | null = null;
          let page = 1;
          const maxPages = 100;
          let statusCount = 0;

          do {
            const params = new URLSearchParams({ MarketplaceId: marketplaceId });
            params.set('QueryType', 'DATE_RANGE');
            params.set('LastUpdatedAfter', startISO);
            params.set('LastUpdatedBefore', endISO);
            params.set('ShipmentStatusList', status);

            const url = buildV0ShipmentListUrl(params, nextToken);
            console.log(`[DATE_RANGE] status=${status} page=${page}`);

            await waitForApiToken(supabase, 'inbound_api');
            const response = await callSpApi('GET', url, accessToken);
            const shipments = Array.isArray(response.payload?.ShipmentData) ? response.payload.ShipmentData : [];
            nextToken = typeof response.payload?.NextToken === 'string' && response.payload.NextToken.length > 0
              ? response.payload.NextToken
              : null;

            for (const s of shipments) {
              if (s.ShipmentId && !rangeSeenIds.has(s.ShipmentId)) {
                rangeSeenIds.add(s.ShipmentId);
                rangeShipments.push(s);
                statusCount++;
              }
            }

            page++;
            await new Promise(r => setTimeout(r, 500)); // Rate limit
          } while (nextToken && page <= maxPages);

          console.log(`[DATE_RANGE] status=${status} → ${statusCount} new shipments`);
        } catch (err) {
          console.error(`[DATE_RANGE] status=${status} failed:`, (err as Error).message);
        }
      }

      console.log(`[DATE_RANGE] Found ${rangeShipments.length} shipments`);

      // Upsert shipments
      let upsertedCount = 0;
      for (const shipment of rangeShipments) {
        const { error } = await supabase
          .from('fba_shipments')
          .upsert({
            user_id: user.id,
            shipment_id: shipment.ShipmentId,
            shipment_name: shipment.ShipmentName,
            shipment_status: shipment.ShipmentStatus,
            destination_fulfillment_center_id: shipment.DestinationFulfillmentCenterId,
            label_prep_type: shipment.LabelPrepType,
            are_cases_required: shipment.AreCasesRequired,
            box_contents_source: shipment.BoxContentsSource,
            confirmed_need_by_date: shipment.ConfirmedNeedByDate,
          }, { onConflict: 'user_id,shipment_id' });

        if (!error) upsertedCount++;
      }

      // Sync items for each shipment
      let totalItems = 0;
      for (const shipment of rangeShipments) {
        try {
          const itemsUrl = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${shipment.ShipmentId}/items?MarketplaceId=${marketplaceId}`;
          await waitForApiToken(supabase, 'inbound_api');
          const itemsResp = await callSpApi('GET', itemsUrl, accessToken);
          const items = Array.isArray(itemsResp.payload?.ItemData) ? itemsResp.payload.ItemData : [];

          for (const item of items) {
            await supabase
              .from('fba_shipment_items')
              .upsert({
                user_id: user.id,
                shipment_id: shipment.ShipmentId,
                seller_sku: item.SellerSKU,
                fnsku: item.FulfillmentNetworkSKU,
                quantity_shipped: item.QuantityShipped,
                quantity_received: item.QuantityReceived,
                quantity_in_case: item.QuantityInCase,
              }, { onConflict: 'user_id,shipment_id,seller_sku' });
            totalItems++;
          }

          await new Promise(r => setTimeout(r, 300));
        } catch (itemErr) {
          console.error(`[DATE_RANGE] Items error for ${shipment.ShipmentId}:`, (itemErr as Error).message);
        }
      }

      console.log(`[DATE_RANGE] Upserted ${upsertedCount} shipments, ${totalItems} items`);

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'date_range',
          dateRangeStart,
          dateRangeEnd,
          shipmentsFound: rangeShipments.length,
          shipmentsUpserted: upsertedCount,
          itemsUpserted: totalItems,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch shipments from SP-API (Fulfillment Inbound v0)
    // STRATEGY: Use DATE_RANGE query first to get ALL recent shipments regardless of status.
    // This is more reliable than querying by status because it catches CLOSED, RECEIVING, etc. in one pass.
    // Then fall back to status-based queries for any statuses that might have older shipments.

    let allShipments: any[] = [];
    const statusCounts: Record<string, number> = {};
    const seenShipmentIds = new Set<string>();

    // === PHASE 1: DATE_RANGE query (catches all recent shipments including CLOSED) ===
    const recentDays = lookbackDays;
    const recentAfter = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();
    // SP-API requires LastUpdatedBefore when LastUpdatedAfter is set; use 2 minutes ago to avoid clock-skew rejections
    const recentBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    console.log(`[PHASE 1] Fetching ALL shipments updated in last ${recentDays} days (${recentAfter} → ${recentBefore})...`);

    try {
      let nextToken: string | null = null;
      let page = 1;
      const maxPages = 100; // Allow more pages since this is our primary query

      do {
        const params = new URLSearchParams({ MarketplaceId: marketplaceId });
        params.set('QueryType', 'DATE_RANGE');
        params.set('LastUpdatedAfter', recentAfter);
        params.set('LastUpdatedBefore', recentBefore);
        params.set('ShipmentStatusList', 'WORKING,SHIPPED,IN_TRANSIT,DELIVERED,CHECKED_IN,RECEIVING,CLOSED,CANCELLED,DELETED,ERROR');

        const url = buildV0ShipmentListUrl(params, nextToken);
        console.log(`[PHASE 1] Fetching page ${page}/${maxPages}...`);

        await waitForApiToken(supabase, 'inbound_api');
        const response = await callSpApi('GET', url, accessToken);

        const shipments = Array.isArray(response.payload?.ShipmentData) ? response.payload.ShipmentData : [];
        nextToken = typeof response.payload?.NextToken === 'string' && response.payload.NextToken.length > 0
          ? response.payload.NextToken
          : null;

        for (const s of shipments) {
          if (s.ShipmentId && !seenShipmentIds.has(s.ShipmentId)) {
            seenShipmentIds.add(s.ShipmentId);
            allShipments.push(s);
            const status = s.ShipmentStatus || 'UNKNOWN';
            statusCounts[status] = (statusCounts[status] || 0) + 1;
          }
        }

        console.log(`[PHASE 1] Page ${page}: ${shipments.length} shipments (total unique: ${seenShipmentIds.size}, nextToken=${nextToken ? 'yes' : 'no'})`);

        page++;
        await new Promise(r => setTimeout(r, 400));
      } while (nextToken && page <= maxPages);

      if (nextToken) {
        console.log(`[PHASE 1] More pages exist but reached limit of ${maxPages}`);
      }
    } catch (err) {
      console.error('[PHASE 1] DATE_RANGE query failed:', (err as Error).message);
    }

    console.log(`[PHASE 1] Complete: ${seenShipmentIds.size} unique shipments (v0)`);

    // === PHASE 1.5: v2024-03-20 Inbound API discovery ===
    // New "Send to Amazon" workflow shipments (STA) do NOT appear on the v0 list endpoint.
    // We must list them via the v2024 inboundPlans + shipments endpoints.
    // Skipped in headers-only mode: the endpoint requires up to 54 pages of paginated
    // detail calls and blows the edge-worker wall-time before Phase 1's shipments are
    // persisted. Phase 1's DATE_RANGE query already covers all recent shipments,
    // which is sufficient for the weekly catch-up header refresh.
    await markPhase('phase-1-complete', { shipments: allShipments.length });

    if (!headersOnly && includeV2024) {
      try {
        let v2024Found = 0;
        // Correct argument order. See the includeV2024 comment above.
        const v2024Shipments = await discoverV2024Shipments(supabase, accessToken, recentDays);

        for (const shipment of v2024Shipments) {
          if (!shipment.ShipmentId || seenShipmentIds.has(shipment.ShipmentId)) continue;
          seenShipmentIds.add(shipment.ShipmentId);
          allShipments.push(shipment);
          const status = shipment.ShipmentStatus || 'UNKNOWN';
          statusCounts[`v2024:${status}`] = (statusCounts[`v2024:${status}`] || 0) + 1;
          v2024Found++;
        }

        console.log(`[PHASE 1.5] v2024 discovery added ${v2024Found} shipments (total unique: ${seenShipmentIds.size})`);
      } catch (err) {
        console.error('[PHASE 1.5] v2024 discovery failed:', (err as Error).message);
      }
    } else {
      console.log(`[PHASE 1.5] skipped (headersOnly=${headersOnly}, includeV2024=${includeV2024})`);
    }

    // === PHASE 2: Status-based queries for older WORKING/CANCELLED shipments (optional, limited) ===
    const olderStatusPriority = [
      { status: 'WORKING', maxPages: 5 },
      { status: 'CANCELLED', maxPages: 3 },
    ];

    const olderAfter = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const olderBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    // Phase 2 is also skipped in headers-only mode — it's an additional 8 pages of API
    // calls that risk pushing the worker past its wall-time before persistence.
    for (const { status, maxPages } of (headersOnly ? [] : olderStatusPriority)) {
      try {
        let nextToken: string | null = null;
        let page = 1;

        do {
          const params = new URLSearchParams({ MarketplaceId: marketplaceId });
          params.set('ShipmentStatusList', status);
          params.set('QueryType', 'SHIPMENT');
          params.set('LastUpdatedAfter', olderAfter);
          params.set('LastUpdatedBefore', olderBefore);

          const url = buildV0ShipmentListUrl(params, nextToken);

          await waitForApiToken(supabase, 'inbound_api');
          const response = await callSpApi('GET', url, accessToken);
          const shipments = Array.isArray(response.payload?.ShipmentData) ? response.payload.ShipmentData : [];
          nextToken = typeof response.payload?.NextToken === 'string' && response.payload.NextToken.length > 0
            ? response.payload.NextToken
            : null;

          for (const s of shipments) {
            if (s.ShipmentId && !seenShipmentIds.has(s.ShipmentId)) {
              seenShipmentIds.add(s.ShipmentId);
              allShipments.push(s);
              statusCounts[status] = (statusCounts[status] || 0) + 1;
            }
          }

          page++;
          await new Promise(r => setTimeout(r, 500));
        } while (nextToken && page <= maxPages);
      } catch (err) {
        console.error(`[PHASE 2] ${status} query failed:`, (err as Error).message);
        statusCounts[status] = -1;
      }
    }

    console.log('Status counts:', JSON.stringify(statusCounts));
    console.log(`Total shipments found: ${allShipments.length}`);

    await markPhase('phase-2-complete', { shipments: allShipments.length });

    // Which shipments already have item rows -- the cursor described at
    // skipShipmentsWithItems above.
    //
    // ⚠️ THE OBVIOUS VERSION OF THIS QUERY SILENTLY RETURNS A FRACTION.
    // It was `.select('shipment_id').eq('user_id', ...).limit(50000)`, and on
    // 2026-11-18 it reported 122 shipments while the table actually held
    // 1,163 distinct shipment_ids. PostgREST caps a response at the project's
    // db-max-rows (1,000 here) and `.limit()` cannot raise it -- so the 50,000
    // was never granted, the first 1,000 item rows happened to cover only 122
    // shipments, and the cursor then re-fetched ~1,041 shipments it already
    // had. That is the same class as the ~28 files paging with .range() and no
    // ORDER BY: a capped read that looks like a complete one.
    //
    // Fixed by asking only about the shipments in THIS window (a few hundred,
    // known already) in chunks that cannot hit the cap, instead of reading the
    // whole table and hoping.
    const haveItemsFor = new Set<string>();
    if (skipShipmentsWithItems && !headersOnly) {
      const windowIds = Array.from(
        new Set(allShipments.map((sh: any) => String(sh.ShipmentId)).filter(Boolean)),
      );
      const CHUNK = 150;
      let pages = 0;
      let capHit = false;
      for (let i = 0; i < windowIds.length; i += CHUNK) {
        const chunk = windowIds.slice(i, i + CHUNK);
        const { data: existing, error: curErr } = await supabase
          .from('fba_shipment_items')
          .select('shipment_id')
          .eq('user_id', user.id)
          .in('shipment_id', chunk);
        pages++;
        if (curErr) {
          // A broken cursor must not look like an empty one: an empty cursor
          // means "fetch everything" and would burn the whole budget.
          console.log(`[cursor] chunk ${pages} failed: ${curErr.message}`);
          capHit = true;
          continue;
        }
        for (const r of existing ?? []) {
          if (r?.shipment_id) haveItemsFor.add(String(r.shipment_id));
        }
      }
      await markPhase('cursor-loaded', {
        shipments_with_items: haveItemsFor.size,
        window_shipments: windowIds.length,
        chunks: pages,
        degraded: capHit,
      });
    }

    // Upsert shipments and fetch their items
    let itemsCount = 0;
    let itemFetches = 0;
    let itemsSkippedAlreadyHave = 0;
    let itemsSkippedBudget = 0;
    let headersUpserted = 0;
    let budgetExhausted = false;
    let totalBudgetExhausted = false;
    let shipmentsNotReached = 0;
    let itemFetchFailures = 0;
    const itemFetchErrors: string[] = [];
    const itemProbes: ItemFetchProbe[] = [];

    for (const shipment of allShipments) {
      // The hard stop. Unlike the item budget this abandons the loop
      // ENTIRELY, headers included, because the wrapper's re-entry arithmetic
      // assumes we return inside totalBudgetMs and is unsound otherwise.
      if (totalBudgetMs !== null && Date.now() - T0 > totalBudgetMs) {
        if (!totalBudgetExhausted) {
          totalBudgetExhausted = true;
          await markPhase('total-budget-exhausted', {
            headers_upserted: headersUpserted,
            item_fetches: itemFetches,
            items_so_far: itemsCount,
          });
        }
        shipmentsNotReached++;
        continue;
      }

      const shipmentData = {
        user_id: user.id,
        shipment_id: shipment.ShipmentId,
        shipment_name: shipment.ShipmentName || null,
        destination_fulfillment_center_id: shipment.DestinationFulfillmentCenterId || null,
        shipment_status: shipment.ShipmentStatus || null,
        label_prep_type: shipment.LabelPrepType || null,
        are_cases_required: shipment.AreCasesRequired || false,
        box_contents_source: shipment.BoxContentsSource || null,
        updated_at: new Date().toISOString(),
      };

      const { error: upsertError } = await supabase
        .from('fba_shipments')
        .upsert(shipmentData, { onConflict: 'user_id,shipment_id' });

      if (upsertError) {
        console.log(`Error upserting shipment ${shipment.ShipmentId}:`, upsertError.message);
        continue;
      }
      headersUpserted++;

      // Fetch items for this shipment (skipped in headers-only mode)
      // The header is already persisted by this point, so stopping here costs
      // detail but never a row -- headers keep being written for every
      // remaining shipment, and only the per-shipment SP-API item call stops.
      if (skipShipmentsWithItems && haveItemsFor.has(String(shipment.ShipmentId))) {
        itemsSkippedAlreadyHave++;
        continue;
      }
      if (itemFetchBudgetMs !== null && Date.now() - T0 > itemFetchBudgetMs) {
        if (!budgetExhausted) {
          budgetExhausted = true;
          await markPhase('item-budget-exhausted', {
            after_fetches: itemFetches,
            items_so_far: itemsCount,
          });
        }
        itemsSkippedBudget++;
        continue;
      }

      if (!headersOnly) {
        try {
          itemFetches++;
          const wantProbe = itemProbes.length < traceItemFetches ? itemProbes : undefined;
          const result = shipment.__source === 'v2024' && shipment.__inboundPlanId && shipment.__v2024ShipmentId
            // Correct argument order; this call was short by one as well.
            ? await fetchV2024ShipmentItems(supabase, shipment.__inboundPlanId, shipment.__v2024ShipmentId, accessToken)
            : await fetchV0ShipmentItems(supabase, shipment.ShipmentId, accessToken, wantProbe);

          // Write what came back even when the fetch also reported an error.
          // The two used to share one code path and the items always lost.
          if (result.items.length > 0) {
            itemsCount += await upsertShipmentItems(supabase, user.id, shipment.ShipmentId, result.items);
          }
          if (result.error) {
            itemFetchFailures++;
            if (itemFetchErrors.length < 10) {
              itemFetchErrors.push(`${shipment.ShipmentId}: ${result.status ?? '?'} ${result.error}`);
            }
            console.log(`[items] ${shipment.ShipmentId} failed after ${result.items.length} item(s): ${result.error}`);
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (itemErr) {
          // Should now be unreachable -- the fetchers return their failures.
          itemFetchFailures++;
          console.log(`Error fetching items for ${shipment.ShipmentId}:`, (itemErr as Error).message);
        }
      }
    }

    if (itemProbes.length > 0) {
      await markPhase('item-fetch-trace', { probes: itemProbes });
    }

    if (headersOnly) {
      console.log(`[headers-only] Skipped item fetches and enrichment for ${allShipments.length} shipments`);
    }

    // Enrich items with ASIN/title/image - fetch from Amazon Catalog API as primary source
    // Get items missing ANY of the key fields (asin, title, or image_url)
    // Skipped entirely in headers-only mode to keep function under timeout.
    const { data: itemsToEnrich } = (headersOnly || skipEnrichment) ? { data: [] as any[] } : await supabase
      .from('fba_shipment_items')
      .select('id, seller_sku, asin, title, image_url')
      .eq('user_id', user.id)
      .or('asin.is.null,title.is.null,image_url.is.null')
      .limit(10000);

    if (itemsToEnrich && itemsToEnrich.length > 0) {
      console.log(`Enriching ${itemsToEnrich.length} items missing ASIN/title/image`);
      
      // Group by unique SKU to avoid duplicate API calls
      const uniqueSkus = [...new Set(itemsToEnrich.map(i => i.seller_sku))];
      const skuDataMap = new Map<string, { asin?: string; title?: string; image_url?: string }>();
      
      for (const sku of uniqueSkus) {
        try {
          // First try to get ASIN from inventory (fastest)
          const { data: inv } = await supabase
            .from('inventory')
            .select('asin, title, image_url')
            .eq('user_id', user.id)
            .eq('sku', sku)
            .maybeSingle();
          
          if (inv?.asin) {
            // If we have ASIN but missing title/image, fetch from Amazon Catalog API
            if (!inv.title || !inv.image_url) {
              try {
                const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${inv.asin}?marketplaceIds=${auth.marketplace_id}&includedData=summaries,images`;
                await waitForApiToken(supabase, 'catalog_api');
                const catalogResponse = await callSpApi('GET', catalogUrl, accessToken);
                
                const summaries = catalogResponse?.summaries || [];
                const images = catalogResponse?.images || [];
                
                const summary = summaries.find((s: any) => s.marketplaceId === auth.marketplace_id) || summaries[0];
                const imageSet = images.find((i: any) => i.marketplaceId === auth.marketplace_id) || images[0];
                const mainImage = imageSet?.images?.find((img: any) => img.variant === 'MAIN') || imageSet?.images?.[0];
                
                skuDataMap.set(sku, {
                  asin: inv.asin,
                  title: summary?.itemName || inv.title,
                  image_url: mainImage?.link || inv.image_url,
                });
                
                console.log(`[ENRICH] Fetched from Amazon Catalog for SKU ${sku}: ${summary?.itemName?.substring(0, 50)}...`);
                await new Promise(r => setTimeout(r, 200)); // Rate limit
              } catch (catalogErr) {
                console.log(`[ENRICH] Catalog API error for ${inv.asin}, using inventory data:`, (catalogErr as Error).message);
                skuDataMap.set(sku, inv);
              }
            } else {
              skuDataMap.set(sku, inv);
            }
          } else {
              // No inventory data, try created_listings
            const { data: listing } = await supabase
              .from('created_listings')
              .select('asin, title, image_url')
              .eq('user_id', user.id)
              .eq('sku', sku)
              .maybeSingle();
            
            if (listing?.asin) {
              // Fetch from Amazon if missing title/image
              if (!listing.title || !listing.image_url) {
                try {
                  const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${listing.asin}?marketplaceIds=${auth.marketplace_id}&includedData=summaries,images`;
                  await waitForApiToken(supabase, 'catalog_api');
                  const catalogResponse = await callSpApi('GET', catalogUrl, accessToken);
                  
                  const summaries = catalogResponse?.summaries || [];
                  const images = catalogResponse?.images || [];
                  
                  const summary = summaries.find((s: any) => s.marketplaceId === auth.marketplace_id) || summaries[0];
                  const imageSet = images.find((i: any) => i.marketplaceId === auth.marketplace_id) || images[0];
                  const mainImage = imageSet?.images?.find((img: any) => img.variant === 'MAIN') || imageSet?.images?.[0];
                  
                  skuDataMap.set(sku, {
                    asin: listing.asin,
                    title: summary?.itemName || listing.title,
                    image_url: mainImage?.link || listing.image_url,
                  });
                  
                  console.log(`[ENRICH] Fetched from Amazon Catalog for SKU ${sku}: ${summary?.itemName?.substring(0, 50)}...`);
                  await new Promise(r => setTimeout(r, 200));
                } catch (catalogErr) {
                  console.log(`[ENRICH] Catalog API error for ${listing.asin}, using listing data:`, (catalogErr as Error).message);
                  skuDataMap.set(sku, listing);
                }
              } else {
                skuDataMap.set(sku, listing);
              }
            } else {
              // Fall back to sales orders: older shipments often have SKU-cost data there even when Product Library lacks ASIN.
              const { data: orderItem } = await supabase
                .from('sales_orders')
                .select('asin, title, image_url')
                .eq('user_id', user.id)
                .or(`seller_sku.eq.${sku},sku.eq.${sku}`)
                .not('asin', 'is', null)
                .neq('asin', '')
                .order('order_date', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (orderItem?.asin) {
                if (!orderItem.title || !orderItem.image_url) {
                  try {
                    skuDataMap.set(sku, await fetchCatalogSummary(supabase, orderItem.asin, auth.marketplace_id, accessToken, orderItem.title, orderItem.image_url));
                    await new Promise(r => setTimeout(r, 200));
                  } catch (catalogErr) {
                    console.log(`[ENRICH] Catalog API error for sales order ASIN ${orderItem.asin}, using sales order data:`, (catalogErr as Error).message);
                    skuDataMap.set(sku, orderItem);
                  }
                } else {
                  skuDataMap.set(sku, orderItem);
                }
              } else {
              // Last resort: try to get ASIN by searching SKU in catalog
              try {
                const searchUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items?marketplaceIds=${auth.marketplace_id}&sellerId=${auth.seller_id || ''}&identifiersType=SKU&identifiers=${encodeURIComponent(sku)}&includedData=summaries,images`;
                await waitForApiToken(supabase, 'catalog_api');
                const searchResponse = await callSpApi('GET', searchUrl, accessToken);
                
                const items = searchResponse?.items || [];
                if (items.length > 0) {
                  const catalogItem = items[0];
                  const summaries = catalogItem?.summaries || [];
                  const images = catalogItem?.images || [];
                  
                  const summary = summaries.find((s: any) => s.marketplaceId === auth.marketplace_id) || summaries[0];
                  const imageSet = images.find((i: any) => i.marketplaceId === auth.marketplace_id) || images[0];
                  const mainImage = imageSet?.images?.find((img: any) => img.variant === 'MAIN') || imageSet?.images?.[0];
                  
                  skuDataMap.set(sku, {
                    asin: catalogItem.asin,
                    title: summary?.itemName,
                    image_url: mainImage?.link,
                  });
                  
                  console.log(`[ENRICH] Found via SKU search for ${sku}: ASIN=${catalogItem.asin}`);
                }
                await new Promise(r => setTimeout(r, 200));
              } catch (searchErr) {
                console.log(`[ENRICH] SKU search failed for ${sku}:`, (searchErr as Error).message);
              }
              }
            }
          }
        } catch (err) {
          console.log(`[ENRICH] Error processing SKU ${sku}:`, (err as Error).message);
        }
      }
      
      // Update all items with the fetched data
      for (const item of itemsToEnrich) {
        const data = skuDataMap.get(item.seller_sku);
        if (data) {
          const updates: any = {};
          if (!item.asin && data.asin) updates.asin = data.asin;
          if (!item.title && data.title) updates.title = data.title;
          if (!item.image_url && data.image_url) updates.image_url = data.image_url;
          
          if (Object.keys(updates).length > 0) {
            await supabase
              .from('fba_shipment_items')
              .update(updates)
              .eq('id', item.id);
          }
        }
      }
    }

    // Get final counts
    const { count: shipmentCount } = await supabase
      .from('fba_shipments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    const { count: totalItemCount } = await supabase
      .from('fba_shipment_items')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    console.log(`Sync complete: ${allShipments.length} shipments synced, ${shipmentCount} total in DB, ${itemsCount} item rows written this run, ${totalItemCount} in table`);

    return new Response(JSON.stringify({
      success: true,
      message: `Synced ${allShipments.length} shipments`,
      shipmentCount,
      shipmentsFound: allShipments.length,
      // WORK DONE THIS RUN, not the size of the table.
      //
      // Both of these used to be `totalItemCount`, a count(*) over the whole
      // of fba_shipment_items -- so catchup-fba-shipments summed it into
      // cron_run_history.items_processed and recorded 15,505 "items processed"
      // on 2026-11-18 while last_item_write stayed at 2026-10-11 and not one
      // row had been written. A run that achieved nothing reported five
      // figures of progress. The table total is still useful, under a name
      // that says what it is.
      itemsUpserted: itemsCount,
      itemCount: itemsCount,
      itemRowsInTable: totalItemCount,
      itemFetchFailures,
      ...(itemFetchErrors.length > 0 ? { itemFetchErrors } : {}),
      lookbackDays,
      headersOnly,
      skipEnrichment,
      includeV2024,
      // What the caller needs in order to decide whether to call again.
      headersUpserted,
      itemFetches,
      itemsSkippedAlreadyHave,
      itemsSkippedBudget,
      budgetExhausted,
      totalBudgetExhausted,
      shipmentsNotReached,
      itemProbes,
      moreItemWorkRemaining: itemsSkippedBudget > 0 || shipmentsNotReached > 0,
      durationMs: Date.now() - T0,
      phaseLog,
      statusCounts,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error syncing FBA shipments:', error);
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
