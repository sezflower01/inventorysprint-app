import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { waitForApiToken } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  // Some projects historically used different LWA apps for different flows.
  // To keep cron/backfill reliable, try both credential pairs.
  const candidates: Array<{ clientId?: string; clientSecret?: string; label: string }> = [
    {
      clientId: Deno.env.get('SPAPI_LWA_CLIENT_ID'),
      clientSecret: Deno.env.get('SPAPI_LWA_CLIENT_SECRET'),
      label: 'SPAPI_LWA_*',
    },
    {
      clientId: Deno.env.get('LWA_CLIENT_ID'),
      clientSecret: Deno.env.get('LWA_CLIENT_SECRET'),
      label: 'LWA_*',
    },
  ];

  let lastStatus: number | null = null;
  let lastBody = '';

  for (const c of candidates) {
    if (!c.clientId || !c.clientSecret) continue;

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.access_token;
    }

    lastStatus = response.status;
    lastBody = await response.text().catch(() => '');
    console.warn(`[BACKFILL] LWA token refresh failed with ${c.label}: ${response.status} ${lastBody.slice(0, 120)}`);
  }

  throw new Error(`LWA token refresh failed: ${lastStatus ?? 'unknown'} ${lastBody.slice(0, 120)}`);
}

// Media product types that have closing fees
const MEDIA_PRODUCT_TYPES = new Set([
  // Books
  'ABIS_BOOK', 'BOOKS', 'BOOK', 'PRINTED_BOOKS', 'BOOK_SERIES',
  // Music
  'ABIS_MUSIC', 'MUSIC', 'DOWNLOADABLE_MUSIC', 'DIGITAL_MUSIC_ALBUM',
  // Video/DVD
  'ABIS_DVD', 'DVD', 'VIDEO', 'VIDEO_DVD', 'BLU_RAY', 'VIDEO_GAMES_ACCESSORIES',
  // Video Games & Software
  'VIDEO_GAMES', 'VIDEOGAME', 'SOFTWARE', 'DOWNLOADABLE_SOFTWARE',
  'CONSOLE_VIDEO_GAMES', 'PC_VIDEO_GAMES', 'DIGITAL_VIDEO_GAMES',
  'PHYSICAL_VIDEO_GAME_SOFTWARE', // <-- The exact type for B0BPMTWL3Y
  // Related media
  'DIGITAL_TEXT', 'KINDLE_EBOOK', 'AUDIBLE_AUDIOBOOK',
]);

// Check if product is media via Catalog API
async function checkIfMediaProduct(
  asin: string,
  accessToken: string,
  marketplaceId: string = 'ATVPDKIKX0DER'
): Promise<boolean> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/catalog/2022-04-01/items/${asin}`;
  const queryParams = `marketplaceIds=${marketplaceId}&includedData=classifications`;
  const url = `${endpoint}${path}?${queryParams}`;

  try {
    const headers = await signRequest('GET', url, '', accessToken);
    headers['Content-Type'] = 'application/json';

    const response = await fetch(url, { method: 'GET', headers });
    
    if (!response.ok) {
      console.warn(`[BACKFILL] Catalog API error for ${asin}: ${response.status}`);
      return false;
    }

    const data = await response.json();
    const classifications = data?.classifications || [];
    
    for (const classification of classifications) {
      const productType = classification?.classifications?.[0]?.productType?.toUpperCase() || '';
      const displayName = classification?.classifications?.[0]?.displayName?.toUpperCase() || '';
      
      // Check if product type matches media types
      if (MEDIA_PRODUCT_TYPES.has(productType)) {
        console.log(`[BACKFILL] ✓ ${asin} detected as media via productType: ${productType}`);
        return true;
      }
      
      // Also check display name for common media keywords
      if (displayName.includes('VIDEO GAME') || displayName.includes('SOFTWARE') || 
          displayName.includes('BOOK') || displayName.includes('DVD') ||
          displayName.includes('MUSIC') || displayName.includes('BLU-RAY')) {
        console.log(`[BACKFILL] ✓ ${asin} detected as media via displayName: ${displayName}`);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`[BACKFILL] Catalog API exception for ${asin}:`, error);
    return false;
  }
}

// Marketplace short-code → SP-API marketplaceId + native currency.
// MUST include BR — earlier version omitted it, falling back to US which
// silently routed BR ASINs to the wrong marketplace.
const MKT_SHORT_TO_ID: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};
const MKT_SHORT_TO_CCY: Record<string, string> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL',
};

function resolveMarketplace(short: string): { marketplaceId: string; currencyCode: string } {
  const code = String(short || 'US').toUpperCase();
  return {
    marketplaceId: MKT_SHORT_TO_ID[code] || 'ATVPDKIKX0DER',
    currencyCode: MKT_SHORT_TO_CCY[code] || 'USD',
  };
}

// Cache fx_rates (base=USD, quote=<ccy>, rate=<native per 1 USD>) per invocation.
let FX_RATES_CACHE: Record<string, number> | null = null;
async function loadFxRates(supabase: any): Promise<Record<string, number>> {
  if (FX_RATES_CACHE) return FX_RATES_CACHE;
  const map: Record<string, number> = { USD: 1 };
  try {
    const { data } = await supabase
      .from('fx_rates')
      .select('quote, rate')
      .eq('base', 'USD');
    for (const row of data || []) {
      const r = Number(row?.rate);
      if (row?.quote && Number.isFinite(r) && r > 0) map[row.quote] = r;
    }
  } catch (e) {
    console.warn('[BACKFILL] FX load failed:', (e as any)?.message);
  }
  FX_RATES_CACHE = map;
  return map;
}

// Fetch fees from Amazon Product Fees API and extract fixed FBA fee + referral rate.
// Mirrors sync-sales-orders/fetchProductFees: sends NATIVE currency, converts
// response back to USD before returning. Returns USD values.
async function fetchFeesForAsin(
  supabase: any,
  asin: string,
  referencePriceNative: number,
  currencyCode: string,
  fxRate: number, // native per 1 USD
  accessToken: string,
  marketplaceId: string = 'ATVPDKIKX0DER'
): Promise<{ fbaFeeFixed: number; referralRate: number; isMedia: boolean; error?: string } | null> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com'; // NA region serves US/CA/MX/BR
  const path = `/products/fees/v0/items/${asin}/feesEstimate`;
  const url = `${endpoint}${path}`;

  const isNonUs = currencyCode !== 'USD';
  const referencePriceUsd = isNonUs && fxRate > 0 ? referencePriceNative / fxRate : referencePriceNative;

  const requestBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: true,
      OptionalFulfillmentProgram: "FBA_CORE",
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currencyCode, Amount: referencePriceNative },
        Shipping: { CurrencyCode: currencyCode, Amount: 0 },
      },
      Identifier: `backfill-${asin}-${Date.now()}`,
    },
  });

  console.log(`[BACKFILL] Fee request for ${asin} mp=${marketplaceId} ccy=${currencyCode} native=${referencePriceNative} (~$${referencePriceUsd.toFixed(2)} USD)`);
  try {
    const headers = await signRequest('POST', url, requestBody, accessToken);
    headers['Content-Type'] = 'application/json';

    await waitForApiToken(supabase, 'fees_api');
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
    });

    if (response.status === 429) {
      console.warn(`[BACKFILL] ⚠️ Rate limited for ${asin}`);
      return { fbaFeeFixed: 0, referralRate: 0, isMedia: false, error: 'rate_limit' };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[BACKFILL] ❌ Fees API error for ${asin}: ${response.status} - ${errorText.substring(0, 200)}`);
      return { fbaFeeFixed: 0, referralRate: 0, isMedia: false, error: `api_error_${response.status}` };
    }

    const data = await response.json();
    console.log(`[BACKFILL] Fee response for ${asin}:`, JSON.stringify(data?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList ?? 'NO_FEES'));
    const result = data?.payload?.FeesEstimateResult;
    const status = String(result?.Status ?? '').toLowerCase();

    if (status && status !== 'success') {
      console.warn(`[BACKFILL] ⚠️ Non-success status for ${asin}: ${result?.Status}`);
      return { fbaFeeFixed: 0, referralRate: 0, isMedia: false, error: `status_${result?.Status}` };
    }

    const feeDetailList = result?.FeesEstimate?.FeeDetailList;
    if (!Array.isArray(feeDetailList) || feeDetailList.length === 0) {
      console.warn(`[BACKFILL] ⚠️ No fee details for ${asin}`);
      return { fbaFeeFixed: 0, referralRate: 0, isMedia: false, error: 'no_fee_details' };
    }

    // Amazon returns fees in the marketplace's NATIVE currency regardless of
    // the CurrencyCode label we sent. Sum natives, then convert to USD.
    let fbaFeeNative = 0;
    let referralFeeNative = 0;
    let isMedia = false;

    for (const fee of feeDetailList) {
      const type = String(fee?.FeeType ?? '');
      const rawAmount = fee?.FinalFee?.Amount ?? fee?.FeeAmount?.Amount ?? fee?.FeeAmount?.CurrencyAmount ?? 0;
      const parsed = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount ?? '0'));

      if (type === 'ReferralFee' || type.includes('Referral')) {
        referralFeeNative = parsed;
      } else if (
        type === 'FBAFees' ||
        type === 'FulfillmentFee' ||
        type === 'FBAWeightBasedFee' ||
        type === 'FBAPerUnitFulfillmentFee' ||
        type.startsWith('FBA') ||
        type.includes('Fulfillment')
      ) {
        fbaFeeNative += parsed;
      } else if (type === 'VariableClosingFee' || type === 'FixedClosingFee') {
        if (parsed > 0) isMedia = true;
      }
    }

    if (!isMedia) {
      isMedia = await checkIfMediaProduct(asin, accessToken, marketplaceId);
    }

    // Convert native → USD for consistent storage.
    const fbaFeeUsd = isNonUs && fxRate > 0 ? fbaFeeNative / fxRate : fbaFeeNative;
    const referralFeeUsd = isNonUs && fxRate > 0 ? referralFeeNative / fxRate : referralFeeNative;

    // referral_rate is a fraction (currency-neutral). Compute from native to
    // avoid double-FX rounding.
    const referralRate = referencePriceNative > 0 ? referralFeeNative / referencePriceNative : 0;

    console.log(`[BACKFILL] ✓ ${asin} ${currencyCode}: native FBA=${fbaFeeNative.toFixed(2)} → USD $${fbaFeeUsd.toFixed(2)}, referral=${(referralRate * 100).toFixed(1)}%, media=${isMedia}`);

    return { fbaFeeFixed: fbaFeeUsd, referralRate, isMedia };
  } catch (error) {
    console.error(`[BACKFILL] ❌ Error fetching fees for ${asin}:`, error);
    return { fbaFeeFixed: 0, referralRate: 0, isMedia: false, error: 'exception' };
  }
}



serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check for internal secret auth (for cron/scheduled calls)
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const isInternalCall = internalSecret && expectedSecret && internalSecret === expectedSecret;

    // Parse request body for optional user_id (for manual trigger)
    let targetUserId: string | null = null;
    let maxAsins = 10; // Default batch size
    let forceBypassTtl = false; // When true, re-fetch even fresh cache entries
    // Optional allow-list of {asin, marketplace} to narrow this run. See the
    // TARGETING note further down for why it exists.
    let reqBodyOnly: unknown[] = [];
    const delayMs = 2500; // 2.5 seconds between API calls

    try {
      const body = await req.json();
      targetUserId = body.user_id || null;
      maxAsins = body.max_asins || 10;
      forceBypassTtl = body.force_bypass_ttl === true;
      reqBodyOnly = Array.isArray(body.only) ? body.only : [];
    } catch {
      // No body or invalid JSON - run for all users (cron mode)
    }

    // If not internal call, require JWT auth
    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (!userError && user) {
          targetUserId = user.id;
        }
      }
    }

    console.log(`[BACKFILL] Starting fee cache backfill. Internal: ${isInternalCall}, Target user: ${targetUserId || 'ALL'}, Max ASINs: ${maxAsins}`);

    // Step 1: Find distinct (user_id, asin, marketplace) that need backfill
    // Criteria: fees_missing = true OR (fees_source IN ('unavailable', null) AND status != 'settled')
    let query = supabase
      .from('sales_orders')
      .select('user_id, asin, marketplace')
      .neq('status', 'settled')
      .not('asin', 'is', null)
      .neq('asin', 'UNKNOWN')
      .neq('asin', 'PENDING')
      .or('fees_missing.eq.true,fees_source.is.null,fees_source.eq.unavailable');

    if (targetUserId) {
      query = query.eq('user_id', targetUserId);
    }

    const { data: ordersNeedingFees, error: ordersError } = await query.limit(500);

    if (ordersError) {
      console.error('[BACKFILL] Error fetching orders:', ordersError);
      return new Response(JSON.stringify({ error: ordersError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!ordersNeedingFees || ordersNeedingFees.length === 0) {
      console.log('[BACKFILL] No orders need fee backfill');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No orders need fee backfill',
        selected_asins: 0,
        cached_written: 0,
        orders_updated: 0,
        errors: []
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Deduplicate by (user_id, asin, marketplace)
    const uniqueAsins = new Map<string, { userId: string; asin: string; marketplace: string }>();
    for (const order of ordersNeedingFees) {
      const marketplace = order.marketplace || 'US';
      const key = `${order.user_id}:${order.asin}:${marketplace}`;
      if (!uniqueAsins.has(key)) {
        uniqueAsins.set(key, { userId: order.user_id, asin: order.asin, marketplace });
      }
    }

    // TARGETING. Without this the function cannot be asked for a SPECIFIC
    // asin+marketplace: it pulls up to 500 candidate orders, dedupes them, and
    // takes the first max_asins -- and the query has no ORDER BY, so which
    // ones it takes is arbitrary. On 2026-10-18 there were 741 candidate pairs
    // and two runs (max_asins 5, then 60) both failed to reach the one CA pair
    // that an order actually needed. Fixing one missing fee row should not be
    // a lottery.
    //
    // `only` is an allow-list of {asin, marketplace} that narrows the deduped
    // set. It does NOT bypass the TTL or backoff checks below -- pass
    // force_bypass_ttl for that -- and it never invents a pair that is not
    // already a genuine candidate, so it cannot be used to spend Fees API
    // calls on ASINs with no orders behind them.
    const onlyRaw = Array.isArray(reqBodyOnly) ? reqBodyOnly : [];
    if (onlyRaw.length > 0) {
      const wanted = new Set(
        onlyRaw
          .filter((o: unknown): o is { asin: string; marketplace?: string } =>
            !!o && typeof (o as { asin?: unknown }).asin === 'string')
          .map((o) => `${String(o.asin).trim().toUpperCase()}:${String(o.marketplace || 'US').trim().toUpperCase()}`),
      );
      let dropped = 0;
      for (const [key, data] of [...uniqueAsins]) {
        if (!wanted.has(`${data.asin.toUpperCase()}:${data.marketplace.toUpperCase()}`)) {
          uniqueAsins.delete(key);
          dropped++;
        }
      }
      console.log(`[BACKFILL] only-filter active: kept ${uniqueAsins.size}, dropped ${dropped}`);
      if (uniqueAsins.size === 0) {
        console.warn(`[BACKFILL] only-filter matched NOTHING. Requested: ${[...wanted].join(', ')}`);
      }
    }

    console.log(`[BACKFILL] Found ${uniqueAsins.size} unique ASINs needing fees`);

    // Step 2: Filter out ASINs already in cache or in backoff period
    const now = new Date();
    const asinsToProcess: { userId: string; asin: string; marketplace: string }[] = [];
    const errors: { asin: string; error: string }[] = [];

    for (const [key, data] of uniqueAsins) {
      // Check if already cached or in backoff
      const { data: existingCache } = await supabase
        .from('asin_fee_cache')
        .select('fba_fee_fixed, referral_rate, next_retry_at, attempt_count, updated_at')
        .eq('user_id', data.userId)
        .eq('asin', data.asin)
        .eq('marketplace', data.marketplace)
        .maybeSingle();

      if (existingCache) {
        // 14-day TTL: re-fetch if cache is stale even if values exist
        const FEE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
        const cacheAge = existingCache.updated_at 
          ? Date.now() - new Date(existingCache.updated_at).getTime() 
          : Infinity;
        const isFresh = cacheAge < FEE_CACHE_TTL_MS;

        // If we have valid fee data AND it's fresh (and not force-bypassed), skip
        if ((existingCache.fba_fee_fixed > 0 || existingCache.referral_rate > 0) && isFresh && !forceBypassTtl) {
          console.log(`[BACKFILL] ⏭️ Skip ${data.asin}: cached & fresh (${Math.round(cacheAge / 86400000)}d old)`);
          continue;
        }

        if (!isFresh) {
          console.log(`[BACKFILL] 🔄 ${data.asin}: cache STALE (${Math.round(cacheAge / 86400000)}d old), will re-fetch`);
        }

        // If in backoff period, skip
        if (existingCache.next_retry_at && new Date(existingCache.next_retry_at) > now) {
          console.log(`[BACKFILL] ⏭️ Skip ${data.asin}: in backoff until ${existingCache.next_retry_at}`);
          continue;
        }
      }

      asinsToProcess.push(data);
      if (asinsToProcess.length >= maxAsins) break;
    }

    if (asinsToProcess.length === 0) {
      console.log('[BACKFILL] All ASINs are cached or in backoff');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'All ASINs are cached or in backoff',
        selected_asins: uniqueAsins.size,
        cached_written: 0,
        orders_updated: 0,
        errors: []
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[BACKFILL] Processing ${asinsToProcess.length} ASINs`);

    // Step 3: Get access token for each user and fetch fees
    const userTokens = new Map<string, string>();
    let successCount = 0;
    let failCount = 0;
    let ordersUpdated = 0;

    for (const { userId, asin, marketplace } of asinsToProcess) {
      // Get or fetch access token for this user
      if (!userTokens.has(userId)) {
        // Get all seller authorizations for this user (multi-marketplace)
        const { data: authRows } = await supabase
          .from('seller_authorizations')
          .select('refresh_token, marketplace_id')
          .eq('user_id', userId);

        // Prefer US marketplace, fallback to first available
        const authData = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
        if (!authData?.refresh_token) {
          console.warn(`[BACKFILL] ⚠️ No auth for user ${userId}`);
          errors.push({ asin, error: 'no_auth' });
          continue;
        }

        try {
          const accessToken = await getLWAAccessToken(authData.refresh_token);
          userTokens.set(userId, accessToken);
        } catch (error: any) {
          console.error(`[BACKFILL] ❌ Token refresh failed for user ${userId}:`, error);
          errors.push({ asin, error: 'auth_error' });
          continue;
        }
      }

      const accessToken = userTokens.get(userId)!;

      // Get a reference price for this ASIN (from inventory or buy_box_cache)
      const { data: invData } = await supabase
        .from('inventory')
        .select('amazon_price, price')
        .eq('user_id', userId)
        .eq('asin', asin)
        .maybeSingle();

      let referencePrice = invData?.amazon_price || invData?.price || 0;
      
      // Also check buy_box_cache if no inventory price
      if (referencePrice <= 0) {
        const { data: buyBoxData } = await supabase
          .from('buy_box_cache')
          .select('price')
          .eq('asin', asin)
          .order('fetched_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        
        if (buyBoxData?.price && buyBoxData.price > 0) {
          referencePrice = buyBoxData.price;
        }
      }
      
      // Default $25 if no price found
      if (referencePrice <= 0) {
        referencePrice = 25;
        console.log(`[BACKFILL] ⚠️ No reference price for ${asin}, using default $25`);
      }

      // Resolve marketplace + currency, load FX (native per 1 USD).
      const { marketplaceId, currencyCode } = resolveMarketplace(marketplace);
      const isNonUs = currencyCode !== 'USD';
      const fxMap = await loadFxRates(supabase);
      const fxRate = isNonUs ? (fxMap[currencyCode] || 0) : 1;

      // Guard 1: non-US requires a valid FX rate (>1.05 → native-per-USD).
      // Without it we can't safely convert native fees to USD and would
      // recreate the historical "native stored as USD" bug.
      if (isNonUs && !(fxRate > 1.05)) {
        console.warn(`[BACKFILL] SKIP ${asin} ${marketplace}: fx_rate missing/invalid (${fxRate}); refusing to store potentially-native fees`);
        errors.push({ asin, error: 'fx_missing' });
        continue;
      }

      // reference_price from inventory/buy_box is NATIVE for non-US markets.
      const referencePriceNative = referencePrice;
      const referencePriceUsd = isNonUs ? referencePriceNative / fxRate : referencePriceNative;

      const fees = await fetchFeesForAsin(
        supabase,
        asin,
        referencePriceNative,
        currencyCode,
        fxRate,
        accessToken,
        marketplaceId,
      );

      // Guard 2: upper bound — if returned USD FBA fee exceeds 70% of USD
      // reference price, it almost certainly leaked through as native.
      if (
        fees && !fees.error && isNonUs &&
        fees.fbaFeeFixed > referencePriceUsd * 0.70
      ) {
        console.warn(`[BACKFILL] SANITY_REJECT_HIGH ${asin} ${marketplace}: fba=$${fees.fbaFeeFixed.toFixed(2)} > 70% of ref $${referencePriceUsd.toFixed(2)} — not storing`);
        errors.push({ asin, error: 'sanity_reject_high' });
        failCount++;
        continue;
      }

      // Guard 3: lower bound for BR/MX — FBA fees realistically run ≥2% of
      // sale price. Anything lower indicates currency mislabel or wrong-MP
      // routing (the very bug we just fixed).
      if (
        fees && !fees.error && (marketplace === 'BR' || marketplace === 'MX') &&
        referencePriceUsd > 0 && fees.fbaFeeFixed > 0 &&
        (fees.fbaFeeFixed / referencePriceUsd) < 0.02
      ) {
        console.warn(`[BACKFILL] SANITY_REJECT_LOW ${asin} ${marketplace}: fba=$${fees.fbaFeeFixed.toFixed(2)} < 2% of ref $${referencePriceUsd.toFixed(2)} — not storing`);
        errors.push({ asin, error: 'sanity_reject_low' });
        failCount++;
        continue;
      }

      if (fees && !fees.error && (fees.fbaFeeFixed > 0 || fees.referralRate > 0)) {
        const feeSource = isNonUs ? `fees_api_${marketplace.toLowerCase()}` : 'fees_api';
        // Upsert into asin_fee_cache
        const { error: upsertError } = await supabase
          .from('asin_fee_cache')
          .upsert({
            user_id: userId,
            asin,
            marketplace,
            fba_fee_fixed: fees.fbaFeeFixed,
            referral_rate: fees.referralRate,
            is_media: fees.isMedia,
            updated_at: now.toISOString(),
            last_attempt_at: now.toISOString(),
            attempt_count: 0,
            last_error: null,
            next_retry_at: null,
            fee_source: feeSource,
            last_verified_at: now.toISOString(),
            history_sample_size: 0,
          }, {
            onConflict: 'user_id,asin,marketplace',
          });


        if (upsertError) {
          console.error(`[BACKFILL] ❌ Cache upsert error for ${asin}:`, upsertError);
          errors.push({ asin, error: 'cache_upsert_error' });
          failCount++;
        } else {
          successCount++;

          // Step 4: Update existing sales_orders with cached fees
          // Calculate fees for each order using the cached rate
          const { data: ordersToUpdate } = await supabase
            .from('sales_orders')
            .select('id, sold_price, item_price, quantity, unit_cost')
            .eq('user_id', userId)
            .eq('asin', asin)
            .or('fees_missing.eq.true,fees_source.is.null,fees_source.eq.unavailable');

          if (ordersToUpdate && ordersToUpdate.length > 0) {
            for (const order of ordersToUpdate) {
              const price = order.item_price || order.sold_price || referencePrice;
              const referralFee = price * fees.referralRate;
              const totalFees = referralFee + fees.fbaFeeFixed;
              
              // Calculate ROI if we have unit cost
              const unitCost = order.unit_cost || 0;
              const qty = order.quantity || 1;
              const totalCost = unitCost * qty;
              const totalSale = price * qty;
              const netProfit = totalSale - (totalFees * qty) - totalCost;
              const roi = totalCost > 0 ? Math.round((netProfit / totalCost) * 1000) / 10 : null;

              await supabase
                .from('sales_orders')
                .update({
                  referral_fee: Math.round(referralFee * 100) / 100,
                  fba_fee: Math.round(fees.fbaFeeFixed * 100) / 100,
                  total_fees: Math.round(totalFees * 100) / 100,
                  fees_source: 'from_cache',
                  fees_missing: false,
                  roi: roi,
                  updated_at: now.toISOString(),
                })
                .eq('id', order.id);

              ordersUpdated++;
            }
            console.log(`[BACKFILL] 📝 Updated ${ordersToUpdate.length} orders for ${asin}`);
          }
        }
      } else {
        // Failed to fetch - record attempt and set backoff
        const errorReason = fees?.error || 'unknown';
        errors.push({ asin, error: errorReason });
        
        const { data: existing } = await supabase
          .from('asin_fee_cache')
          .select('attempt_count')
          .eq('user_id', userId)
          .eq('asin', asin)
          .eq('marketplace', marketplace)
          .maybeSingle();

        const attemptCount = (existing?.attempt_count || 0) + 1;
        
        // Exponential backoff: 15m, 1h, 6h, 24h
        const backoffMinutes = attemptCount === 1 ? 15 : 
                               attemptCount === 2 ? 60 : 
                               attemptCount === 3 ? 360 : 1440;
        
        const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);

        await supabase
          .from('asin_fee_cache')
          .upsert({
            user_id: userId,
            asin,
            marketplace,
            fba_fee_fixed: 0,
            referral_rate: 0,
            is_media: false,
            updated_at: now.toISOString(),
            last_attempt_at: now.toISOString(),
            attempt_count: attemptCount,
            last_error: errorReason,
            next_retry_at: nextRetry.toISOString(),
          }, {
            onConflict: 'user_id,asin,marketplace',
          });

        console.log(`[BACKFILL] ⏸️ ${asin}: attempt ${attemptCount}, error=${errorReason}, next retry in ${backoffMinutes}m`);
        failCount++;
      }

      // Rate limit delay between API calls
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const result = {
      success: true,
      selected_asins: asinsToProcess.length,
      cached_written: successCount,
      orders_updated: ordersUpdated,
      errors,
    };

    console.log(`[BACKFILL] ✅ Complete:`, result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[BACKFILL] Fatal error:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? (error as Error).message : 'Unknown error',
      selected_asins: 0,
      cached_written: 0,
      orders_updated: 0,
      errors: [{ asin: 'unknown', error: 'fatal_error' }]
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});