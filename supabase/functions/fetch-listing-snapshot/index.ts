import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { checkModuleAccess } from "../_shared/module-access-guard.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Timeout helper
async function fetchWithTimeout(url: string, options: any, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// Retry helper for network/DNS errors, Amazon 500 errors AND 429 throttles.
//
// 429 was added 2026-08-28. The marketplace-gating path fires one SP-API
// getListingsRestrictions per connected marketplace through Promise.all --
// four at once for US/CA/MX/BR -- against a quota that is account-wide and
// shared with the repricer. Some of the four would win and some would be
// throttled, so the extension showed "BR: APPROVED, MX: APPROVED,
// CA: ERROR, US: ERROR" and a different combination on the next press.
//
// This is an INTERACTIVE request, so the house rule is wait-and-retry rather
// than skip-and-wait-for-the-next-run: a person is looking at the panel and
// wants an answer, not a blank.
async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Fetch attempt ${attempt + 1}/${maxRetries}`);
      const response = await fetchWithTimeout(url, options, 12000);
      
      // Throttled. Amazon may send Retry-After; honour it when present, and
      // back off harder than the 500 path because the quota is per-second and
      // retrying too eagerly just burns another slot.
      if (response.status === 429) {
        if (attempt < maxRetries - 1) {
          const retryAfter = Number(response.headers.get('retry-after')) || 0;
          const delayMs = retryAfter > 0
            ? Math.min(retryAfter * 1000, 5000)
            : 800 * Math.pow(2, attempt); // 800ms, 1.6s, 3.2s
          console.log(`Amazon 429 (throttled), retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        return response;
      }

      // Retry on Amazon 500 errors (InternalFailure)
      if (response.status === 500 || response.status === 503) {
        const clonedResponse = response.clone();
        const errorText = await clonedResponse.text();
        console.log(`Amazon returned ${response.status}, checking if retryable:`, errorText);
        
        if (errorText.includes('InternalFailure') || errorText.includes('ServiceUnavailable')) {
          if (attempt < maxRetries - 1) {
            const delayMs = 1500 * (attempt + 1); // Exponential backoff: 1.5s, 3s, 4.5s
            console.log(`Amazon 500 error, retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }
        }
        // If not retryable or max retries reached, return the response
        lastResponse = response;
      }
      
      return response;
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);
      
      // Check if it's a retryable network error
      if (errorMessage.includes('dns error') || 
          errorMessage.includes('name resolution') ||
          errorMessage.includes('client error') ||
          errorMessage.includes('timed out')) {
        
        if (attempt < maxRetries - 1) {
          const delayMs = 1500 * (attempt + 1);
          console.log(`Network error, retrying in ${delayMs}ms...`, errorMessage);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
      
      throw error;
    }
  }
  
  // Return last response if we have one (for 500 errors)
  if (lastResponse) return lastResponse;
  
  throw lastError || new Error('All retry attempts failed');
}

// AWS SigV4 signing
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

function isRestrictionForCondition(restriction: any, requestedConditionType: string): boolean {
  const returnedCondition = String(restriction?.conditionType || '').trim().toLowerCase();
  if (returnedCondition && returnedCondition !== requestedConditionType) return false;

  if (requestedConditionType === 'new_new') {
    const text = JSON.stringify(restriction || {}).toLowerCase();
    const mentionsOtherConditions = /\b(used|refurbished|collectible)\b/.test(text);
    const explicitlyMentionsNew = /\bnew\b/.test(text);
    if (mentionsOtherConditions && !explicitlyMentionsNew) return false;
  }
  return true;
}

// Cache for access tokens to avoid redundant LWA calls
const tokenCache: Record<string, { token: string; expiresAt: number }> = {};

async function getLwaAccessToken(region: 'NA' | 'EU' = 'NA', refreshTokenOverride?: string | null): Promise<string> {
  // Per project standard: LWA_CLIENT_ID is canonical, SPAPI_LWA_CLIENT_ID is legacy fallback.
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  
  // Use different refresh token based on region
  const refreshToken = refreshTokenOverride || (region === 'EU' 
    ? Deno.env.get('SPAPI_REFRESH_TOKEN_EU') 
    : Deno.env.get('SPAPI_REFRESH_TOKEN'));

  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA credentials');
  }
  
  if (!refreshToken) {
    throw new Error(`Missing refresh token for ${region} region`);
  }

  // Check cache
  const cacheKey = `${region}-${refreshToken.slice(0, 10)}`;
  const cached = tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`Using cached ${region} access token`);
    return cached.token;
  }

  console.log(`Fetching new ${region} access token...`);
  const response = await fetchWithRetry('https://api.amazon.com/auth/o2/token', {
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
    console.error(`LWA token error for ${region}:`, response.status, errorText);
    throw new Error(`LWA token error for ${region}: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  
  // Cache the token (expires in ~1 hour, cache for 50 mins to be safe)
  tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + 50 * 60 * 1000
  };
  
  return data.access_token;
}

async function callSpApi(path: string, accessToken: string, queryParams: Record<string, string> = {}, method: string = 'GET', body?: any): Promise<any> {
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
  
  // Calculate payload hash
  let payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // empty body hash
  if (body) {
    const bodyString = JSON.stringify(body);
    const encoder = new TextEncoder();
    const bodyData = encoder.encode(bodyString);
    const bodyHashBuffer = await crypto.subtle.digest('SHA-256', bodyData as any);
    const bodyHashArray = Array.from(new Uint8Array(bodyHashBuffer));
    payloadHash = bodyHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
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
  
  const fetchOptions: any = {
    method,
    headers: {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      'Authorization': authorizationHeader,
    },
  };
  
  if (body) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }
  
  const response = await fetchWithRetry(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('SP-API Error:', errorText);
    throw new Error(`SP-API request failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

function isQuotaOrThrottleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /429|quota|throttl|rate.?limit/i.test(message);
}

function marketplaceCodeFromId(marketplaceId: string): string {
  const map: Record<string, string> = {
    ATVPDKIKX0DER: 'US',
    A2EUQ1WTGCTBG2: 'CA',
    A1AM78C64UM0Y8: 'MX',
    A2Q3Y263D00KWC: 'BR',
  };
  return map[marketplaceId] || 'US';
}

async function readCachedFbaFees(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  asin: string,
  marketplace: string,
  price: number,
) {
  if (!(price > 0)) return null;
  const { data, error } = await adminClient
    .from('asin_fee_cache')
    .select('fba_fee_fixed, referral_rate, updated_at')
    .eq('user_id', userId)
    .eq('asin', asin)
    .eq('marketplace', marketplace)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const fbaFee = Number(data.fba_fee_fixed || 0);
  const referralRate = Number(data.referral_rate || 0);
  const referralFee = price * referralRate;
  const totalFees = referralFee + fbaFee;
  if (!(totalFees > 0)) return null;
  return {
    referralFee: Math.round(referralFee * 100) / 100,
    fbaFee: Math.round(fbaFee * 100) / 100,
    variableClosingFee: 0,
    totalFees: Math.round(totalFees * 100) / 100,
    fromCache: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    // MODULE ACCESS GUARD: personalhour:view is required (admin bypasses).
    // Use service-role client so the guard can read user_roles + user_module_access.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const access = await checkModuleAccess(adminClient, user.id, 'personalhour', 'view');
    if (!access.allowed) {
      console.warn(`[fetch-listing-snapshot] BLOCKED user=${user.id} reason=${access.reason}`);
      return new Response(
        JSON.stringify({ error: access.reason || 'Forbidden' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { asin, sku, fnsku, marketplaceId = 'ATVPDKIKX0DER', simple = false, priceOverride } = await req.json();

    if (!asin) {
      throw new Error('ASIN is required');
    }

    console.log(`Fetching product data for ASIN: ${asin}, simple: ${simple}, SKU: ${sku || 'N/A'}, priceOverride: ${priceOverride || 'none'}`);
    const startTime = Date.now();

    const { data: sellerAuth } = await adminClient
      .from('seller_authorizations')
      .select('refresh_token')
      .eq('user_id', user.id)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    const accessToken = await getLwaAccessToken('NA', sellerAuth?.refresh_token || null);

    // Get product details from Catalog Items API
    let catalogData: any;
    try {
      // Use only summaries,images (not attributes) - attributes causes Amazon 500 errors on some products
      // Pass `locale` so Amazon returns the localized title for the requested
      // marketplace (e.g. en_US for US) instead of the listing's primary
      // language (some US listings were created by sellers in pt_BR / es_MX).
      const localeForMarketplace: Record<string, string> = {
        ATVPDKIKX0DER: 'en_US',
        A2EUQ1WTGCTBG2: 'en_CA',
        A1AM78C64UM0Y8: 'es_MX',
        A2Q3Y263D00KWC: 'pt_BR',
        A1F83G8C2ARO7P: 'en_GB',
        A1PA6795UKMFR9: 'de_DE',
        A1RKKUPIHCS9HS: 'es_ES',
        A13V1IB3VIYBER: 'fr_FR',
        APJ6JRA9NG5V4:  'it_IT',
        A1805IZSGTT6HS: 'nl_NL',
        A1VC38T7YXB528: 'ja_JP',
        A39IBJ37TRP1C6: 'en_AU',
        A21TJRUUN4KGV:  'en_IN',
      };
      const locale = localeForMarketplace[marketplaceId] || 'en_US';
      await waitForApiToken(adminClient, 'catalog_api');
      catalogData = await callSpApi(
        `/catalog/2022-04-01/items/${asin}`,
        accessToken,
        { marketplaceIds: marketplaceId, includedData: 'summaries,images', locale }
      );
    } catch (err) {
      const message = err instanceof Error ? (err as Error).message : String(err);
      console.error('Catalog API error for ASIN', asin, message);

      // Gracefully handle NOT_FOUND (404) - return 200 with partial data so bulk updates continue
      if (message.includes('404') && message.includes('NOT_FOUND')) {
        console.warn(`ASIN ${asin} not found on Amazon - returning partial response`);
        return new Response(
          JSON.stringify({
            asin,
            title: 'Product not found on Amazon',
            imageUrl: '',
            price: 0,
            amazonFeeFbm: 0,
            available: 0,
            reserved: 0,
            inbound: 0,
            unfulfilled: 0,
            gatingStatus: 'NOT_FOUND',
            gatingReasons: ['Product not found in Amazon marketplace'],
            notFound: true,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Gracefully handle quota errors (429) with a clear error payload
      if (message.includes('429') || message.includes('QuotaExceeded')) {
        console.warn('SP-API quota exceeded for ASIN', asin, message);
        return new Response(
          JSON.stringify({
            error: 'QUOTA_EXCEEDED',
            message: 'You exceeded your SP-API quota for this resource.',
            asin,
            marketplaceId,
            statusCode: 429,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Gracefully handle Amazon 500 Internal Errors (transient issues on Amazon's side)
      if (message.includes('500') || message.includes('InternalFailure')) {
        console.warn('Amazon SP-API internal error for ASIN', asin, message);
        return new Response(
          JSON.stringify({
            error: 'AMAZON_INTERNAL_ERROR',
            message: 'Amazon encountered an internal error. Please try again in a few seconds.',
            asin,
            marketplaceId,
            statusCode: 500,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // For all other errors (credentials, auth, etc.), bubble up to global 500 handler
      throw err;
    }

    const item = catalogData;
    // Pick the summary matching the requested marketplace so we don't return a
    // Portuguese (BR) / Spanish (MX) / French (CA-fr) title when the user is
    // operating in US English. Fallback chain: matching marketplace → US → first.
    const summaries: any[] = Array.isArray(item?.summaries) ? item.summaries : [];
    const summaryForMarketplace =
      summaries.find((s: any) => s?.marketplaceId === marketplaceId) ||
      summaries.find((s: any) => s?.marketplaceId === 'ATVPDKIKX0DER') ||
      summaries[0];
    const title = summaryForMarketplace?.itemName || item?.attributes?.item_name?.[0]?.value || 'Unknown Product';
    const images: any[] = Array.isArray(item?.images) ? item.images : [];
    const imageForMarketplace =
      images.find((i: any) => i?.marketplaceId === marketplaceId) ||
      images.find((i: any) => i?.marketplaceId === 'ATVPDKIKX0DER') ||
      images[0];
    const imageUrl = imageForMarketplace?.images?.[0]?.link || '';

    // For simple mode (e.g., printing page), return immediately with just catalog data
    if (simple) {
      console.log(`Simple mode: returning in ${Date.now() - startTime}ms`);
      return new Response(
        JSON.stringify({
          asin,
          title,
          imageUrl,
          price: 0,
          amazonFeeFbm: 0,
          available: 0,
          reserved: 0,
          inbound: 0,
          unfulfilled: 0,
          gatingStatus: 'UNKNOWN',
          gatingReasons: []
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get competitive pricing for FBM offers
    let price = 0;
    try {
      await waitForApiToken(adminClient, 'pricing_api');
      const pricingData = await callSpApi(
        '/products/pricing/v0/items/' + asin + '/offers',
        accessToken,
        { MarketplaceId: marketplaceId, ItemCondition: 'New' }
      );

      console.log('Pricing API response:', JSON.stringify(pricingData, null, 2));

      // Prefer Buy Box price as the "actual" current price
      const summary = pricingData?.payload?.Summary;
      const buyBoxPrices = summary?.BuyBoxPrices || [];
      console.log('Buy Box Prices:', JSON.stringify(buyBoxPrices, null, 2));

      if (buyBoxPrices.length > 0) {
        // Prioritize LandedPrice (includes shipping) over ListingPrice for accuracy
        // Get all Buy Box prices and use the highest LandedPrice to match actual Buy Box
        const validPrices = buyBoxPrices
          .map((bp: any) => bp?.LandedPrice?.Amount || bp?.ListingPrice?.Amount || 0)
          .filter((p: number) => p > 0);
        
        if (validPrices.length > 0) {
          // Use the highest price as that's typically the actual Buy Box with shipping
          price = Math.max(...validPrices);
          console.log('Using highest Buy Box price (with shipping):', price);
        }
      } else {
        // Fallback 1: FBM lowest price from Summary.LowestPrices
        const lowestPrices = summary?.LowestPrices || [];
        console.log('Lowest Prices:', JSON.stringify(lowestPrices, null, 2));
        const fbmLowest = lowestPrices.find((p: any) => p.fulfillmentChannel === 'Merchant') || lowestPrices[0];

        if (fbmLowest) {
          // Prioritize LandedPrice (with shipping) over ListingPrice
          price = fbmLowest?.LandedPrice?.Amount || fbmLowest?.ListingPrice?.Amount || 0;
          console.log('Using lowest FBM price (with shipping if available):', price);
        } else {
          // Fallback 2: first offer price
          const offers = pricingData?.payload?.Offers || [];
          console.log('All offers:', JSON.stringify(offers, null, 2));
          if (offers.length > 0) {
            // Prioritize LandedPrice (with shipping) over ListingPrice
            price = offers[0]?.LandedPrice?.Amount || offers[0]?.ListingPrice?.Amount || 0;
            console.log('Using first offer price (with shipping if available):', price);
          } else {
            console.log('No pricing data found from Amazon API');
          }
        }
      }
    } catch (error) {
      console.error('Error fetching pricing:', error);
    }

    // If no price from Amazon API but priceOverride provided, use it for fee calculation
    if (price === 0 && priceOverride && priceOverride > 0) {
      price = priceOverride;
      console.log('Using priceOverride for fee calculation:', price);
    }

    // Amazon Fees API rejects mismatched currency codes (e.g. USD price on a CA
    // marketplaceId returns InvalidParameterValue). Use the marketplace's local
    // currency so CA/MX/BR/UK/EU/JP/AU fees are estimated correctly.
    const MARKETPLACE_CURRENCY: Record<string, string> = {
      ATVPDKIKX0DER: 'USD', A2EUQ1WTGCTBG2: 'CAD', A1AM78C64UM0Y8: 'MXN', A2Q3Y263D00KWC: 'BRL',
      A1F83G8C2ARO7P: 'GBP', A1PA6795UKMFR9: 'EUR', A1RKKUPIHCS9HS: 'EUR', A13V1IB3VIYBER: 'EUR',
      APJ6JRA9NG5V4: 'EUR',  A1805IZSGTT6HS: 'EUR', A2NODRKZP88ZB9: 'SEK', A1C3SOZRARQ6R3: 'PLN',
      ARBP9OOSHTCHU: 'EGP',  A33AVAJ2PDY3EV: 'TRY', A39IBJ37TRP1C6: 'AUD', A21TJRUUN4KGV: 'INR',
      A1VC38T7YXB528: 'JPY', A19VAU5U5O7RUS: 'SGD', A2VIGQ35RCS4UG: 'AED', A17E79C6D8DWNP: 'SAR',
      AMEN7PMS3EDWL: 'EUR',
    };
    const feesCurrency = MARKETPLACE_CURRENCY[marketplaceId] || 'USD';

    // Get FBM fees using Product Fees API
    let amazonFeeFbm = 0;
    try {
      const feesPayload = {
        FeesEstimateRequest: {
          MarketplaceId: marketplaceId,
          IsAmazonFulfilled: false, // FBM
          PriceToEstimateFees: {
            ListingPrice: {
              CurrencyCode: feesCurrency,
              Amount: price
            }
          },
          Identifier: asin
        }
      };

      console.log('Fees API request payload:', JSON.stringify(feesPayload, null, 2));

      await waitForApiToken(adminClient, 'fees_api');
      const feesData = await callSpApi(
        `/products/fees/v0/items/${asin}/feesEstimate`,
        accessToken,
        {},
        'POST',
        feesPayload
      );

      console.log('Fees API response:', JSON.stringify(feesData, null, 2));

      const fees = feesData?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList || [];
      amazonFeeFbm = fees.reduce((sum: number, fee: any) => sum + (fee?.FinalFee?.Amount || 0), 0);
      console.log('Calculated FBM fees:', amazonFeeFbm);
    } catch (error) {
      console.error('Error fetching fees:', error);
    }

    // Get FBA fees using Product Fees API (for ROI calculation on Create Listing)
    let fbaFees = { referralFee: 0, fbaFee: 0, variableClosingFee: 0, totalFees: 0, fromCache: false };
    let feesUnavailableReason: string | null = null;
    const marketplaceCode = marketplaceCodeFromId(marketplaceId);
    try {
      const fbaFeesPayload = {
        FeesEstimateRequest: {
          MarketplaceId: marketplaceId,
          IsAmazonFulfilled: true, // FBA
          PriceToEstimateFees: {
            ListingPrice: {
              CurrencyCode: feesCurrency,
              Amount: price
            }
          },
          Identifier: asin + '-FBA'
        }
      };

      console.log('FBA Fees API request payload:', JSON.stringify(fbaFeesPayload, null, 2));

      await waitForApiToken(adminClient, 'fees_api');
      const fbaFeesData = await callSpApi(
        `/products/fees/v0/items/${asin}/feesEstimate`,
        accessToken,
        {},
        'POST',
        fbaFeesPayload
      );

      console.log('FBA Fees API response:', JSON.stringify(fbaFeesData, null, 2));

      const feeList = fbaFeesData?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList || [];
      for (const fee of feeList) {
        const feeType = fee?.FeeType || '';
        // Match the web ROI calculator (`calculate-roi`): Product Fees API
        // returns the usable per-fee value under FeeAmount.Amount in our live
        // responses. FinalFee is kept only as a fallback for older payloads.
        const amount = Number(
          fee?.FeeAmount?.Amount ??
          fee?.FeeAmount?.CurrencyAmount ??
          fee?.FinalFee?.Amount ??
          0
        ) || 0;
        
        if (feeType === 'ReferralFee') {
          fbaFees.referralFee = amount;
        } else if (feeType === 'FBAFees' || feeType === 'FulfillmentFees') {
          fbaFees.fbaFee = amount;
        } else if (feeType === 'VariableClosingFee') {
          fbaFees.variableClosingFee = amount;
        }
        fbaFees.totalFees += amount;
      }
      console.log('Calculated FBA fees breakdown:', fbaFees);
    } catch (error) {
      console.error('Error fetching FBA fees:', error);
      feesUnavailableReason = isQuotaOrThrottleError(error) ? 'THROTTLED' : 'ERROR';
      const cachedFees = await readCachedFbaFees(adminClient, user.id, asin, marketplaceCode, price);
      if (cachedFees) {
        fbaFees = cachedFees;
        feesUnavailableReason = null;
        console.log('Using cached FBA fees after Fees API failure:', fbaFees);
      }
    }

    // ⚠️ A PARTIAL FEE ESTIMATE IS NOT A VALID ESTIMATE.
    //
    // The payload below already refuses an ALL-ZERO estimate, for the reason
    // its own comment gives: returning {0,0,0} silently inflates ROI because
    // profit = price - cost - 0. But the same thing happens, less visibly, when
    // Amazon returns an FBA estimate containing ReferralFee and
    // VariableClosingFee but NO FBAFees/FulfillmentFees line. totalFees is then
    // non-zero, passes the `> 0` test, and is presented as a complete figure.
    //
    // Observed 2026-08-24 on two Sonny Angel blind boxes -- same product line,
    // same size, so the fulfilment fee must be identical:
    //
    //   B09XFCCC9B  fees $7.07 = $3.21 referral + $3.86 fulfilment   ROI 30%
    //   B09XFDB61N  fees $3.31 = $3.00 referral + $0.31 closing      ROI 52%
    //                            ^ no fulfilment fee at all
    //
    // The second card therefore recommended BUY at 52% ROI on a product whose
    // real ROI is roughly 19%, and Max Cost was derived from the same number,
    // so it would also have authorised overpaying. A sourcing decision made on
    // a fee estimate missing its largest component.
    //
    // Amazon omits the fulfilment line when it cannot compute one -- typically
    // missing catalogue dimensions or weight. That is "unknown", not "free",
    // and the existing feesUnavailable path already exists to say so.
    const fbaEstimateComplete = fbaFees.totalFees > 0 && fbaFees.fbaFee > 0;
    if (fbaFees.totalFees > 0 && !(fbaFees.fbaFee > 0)) {
      console.warn(
        `[LISTING_SNAPSHOT] INCOMPLETE_FEE_ESTIMATE ${asin}: total=$${fbaFees.totalFees} ` +
        `referral=$${fbaFees.referralFee} closing=$${fbaFees.variableClosingFee} ` +
        `fulfilment=$${fbaFees.fbaFee} — no FBAFees/FulfillmentFees line returned; ` +
        `treating fees as UNAVAILABLE rather than showing a falsely low total`,
      );
      feesUnavailableReason = feesUnavailableReason || 'INCOMPLETE_NO_FULFILMENT_FEE';
    }

    // Get FBA inventory status using sellerSkus parameter for direct lookup
    let available = 0;
    let reserved = 0;
    let inbound = 0;
    let unfulfilled = 0;
    
    if (sku) {
      try {
        // Query by sellerSku for single-item direct lookup
        await waitForApiToken(adminClient, 'inventory_api');
        const inventoryData = await callSpApi(
          '/fba/inventory/v1/summaries',
          accessToken,
          {
            sellerSkus: sku,
            granularityType: 'Marketplace',
            granularityId: marketplaceId,
            marketplaceIds: marketplaceId,
            details: 'true'
          }
        );

        console.log('FBA Inventory API response (single SKU):', JSON.stringify(inventoryData, null, 2));

        const summaries = inventoryData?.payload?.inventorySummaries || [];
        const inventorySummary = summaries.find((s: any) => 
          s.sellerSku === sku || s.asin === asin
        );

        if (inventorySummary) {
          const details = inventorySummary.inventoryDetails || {};
          
          // Available = fulfillableQuantity (ready to sell)
          available = details.fulfillableQuantity || 0;
          
          // Reserved = totalReservedQuantity (held for customer orders)
          reserved = details.reservedQuantity?.totalReservedQuantity || 0;
          
          // Inbound = sum of all inbound quantities
          const inboundWorking = details.inboundWorkingQuantity || 0;
          const inboundShipped = details.inboundShippedQuantity || 0;
          const inboundReceiving = details.inboundReceivingQuantity || 0;
          inbound = inboundWorking + inboundShipped + inboundReceiving;
          
          // Unfulfillable = totalUnfulfillableQuantity (damaged/defective)
          unfulfilled = details.unfulfillableQuantity?.totalUnfulfillableQuantity || 0;
          
          console.log('Extracted inventory status:', { available, reserved, inbound, unfulfilled });
        } else {
          console.log('No inventory summary found for SKU:', sku, 'or ASIN:', asin);
        }
      } catch (error) {
        console.error('Error fetching inventory status:', error);
      }
    } else {
      console.log('No SKU provided, skipping FBA inventory lookup');
    }

    // Check listing restrictions (gating status) for ALL marketplaces in parallel
    // Primary gating status for backward compatibility
    let gatingStatus = 'UNKNOWN';
    let gatingReasons: string[] = [];
    
    // Multi-marketplace gating results
    interface MarketplaceGating {
      marketplace: string;
      marketplaceId: string;
      name: string;
      flag: string;
      status: string;
      reasons: string[];
    }
    const marketplaceGating: MarketplaceGating[] = [];
    
    // Full marketplace registry — only those the user is connected to will be checked
    const MARKETPLACE_REGISTRY: Record<string, { id: string; marketplaceId: string; name: string; flag: string; region: string }> = {
      'ATVPDKIKX0DER':  { id: 'US', marketplaceId: 'ATVPDKIKX0DER',  name: 'United States',  flag: '🇺🇸', region: 'NA' },
      'A2EUQ1WTGCTBG2': { id: 'CA', marketplaceId: 'A2EUQ1WTGCTBG2', name: 'Canada',          flag: '🇨🇦', region: 'NA' },
      'A1AM78C64UM0Y8': { id: 'MX', marketplaceId: 'A1AM78C64UM0Y8', name: 'Mexico',          flag: '🇲🇽', region: 'NA' },
      'A2Q3Y263D00KWC': { id: 'BR', marketplaceId: 'A2Q3Y263D00KWC', name: 'Brazil',          flag: '🇧🇷', region: 'NA' },
      'A1F83G8C2ARO7P': { id: 'UK', marketplaceId: 'A1F83G8C2ARO7P', name: 'United Kingdom',  flag: '🇬🇧', region: 'EU' },
      'A1PA6795UKMFR9': { id: 'DE', marketplaceId: 'A1PA6795UKMFR9', name: 'Germany',         flag: '🇩🇪', region: 'EU' },
      'A1RKKUPIHCS9HS': { id: 'ES', marketplaceId: 'A1RKKUPIHCS9HS', name: 'Spain',           flag: '🇪🇸', region: 'EU' },
      'A13V1IB3VIYBER': { id: 'FR', marketplaceId: 'A13V1IB3VIYBER', name: 'France',          flag: '🇫🇷', region: 'EU' },
      'APJ6JRA9NG5V4':  { id: 'IT', marketplaceId: 'APJ6JRA9NG5V4',  name: 'Italy',           flag: '🇮🇹', region: 'EU' },
      'A1805IZSGTT6HS': { id: 'NL', marketplaceId: 'A1805IZSGTT6HS', name: 'Netherlands',     flag: '🇳🇱', region: 'EU' },
      'A2NODRKZP88ZB9': { id: 'SE', marketplaceId: 'A2NODRKZP88ZB9', name: 'Sweden',          flag: '🇸🇪', region: 'EU' },
      'A1C3SOZRARQ6R3': { id: 'PL', marketplaceId: 'A1C3SOZRARQ6R3', name: 'Poland',          flag: '🇵🇱', region: 'EU' },
      'ARBP9OOSHTCHU':  { id: 'EG', marketplaceId: 'ARBP9OOSHTCHU',  name: 'Egypt',           flag: '🇪🇬', region: 'EU' },
      'A33AVAJ2PDY3EV': { id: 'TR', marketplaceId: 'A33AVAJ2PDY3EV', name: 'Turkey',          flag: '🇹🇷', region: 'EU' },
      'A39IBJ37TRP1C6': { id: 'AU', marketplaceId: 'A39IBJ37TRP1C6', name: 'Australia',       flag: '🇦🇺', region: 'FE' },
      'A21TJRUUN4KGV':  { id: 'IN', marketplaceId: 'A21TJRUUN4KGV',  name: 'India',           flag: '🇮🇳', region: 'FE' },
      'A1VC38T7YXB528': { id: 'JP', marketplaceId: 'A1VC38T7YXB528', name: 'Japan',           flag: '🇯🇵', region: 'FE' },
      'A19VAU5U5O7RUS': { id: 'SG', marketplaceId: 'A19VAU5U5O7RUS', name: 'Singapore',       flag: '🇸🇬', region: 'FE' },
      'A2VIGQ35RCS4UG': { id: 'AE', marketplaceId: 'A2VIGQ35RCS4UG', name: 'UAE',             flag: '🇦🇪', region: 'EU' },
      'A17E79C6D8DWNP': { id: 'SA', marketplaceId: 'A17E79C6D8DWNP', name: 'Saudi Arabia',   flag: '🇸🇦', region: 'EU' },
    };
    
    try {
      // Get all seller authorizations for this user (multi-marketplace)
      const supabaseAdmin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: authRows } = await supabaseAdmin
        .from('seller_authorizations')
        .select('seller_id, marketplace_id, refresh_token')
        .eq('user_id', user.id);

      // Prefer US marketplace for backward compatibility
      const usAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER');
      const primaryAuth = usAuth || authRows?.[0];
      
      // Helper function to check restrictions for a single marketplace
      async function checkMarketplaceRestrictions(
        mp: { id: string; marketplaceId: string; name: string; flag: string; region: string },
        sellerId: string,
        token: string
      ): Promise<MarketplaceGating> {
        try {
          // Select the correct SP-API endpoint based on region
          const endpoint = mp.region === 'EU' 
            ? 'sellingpartnerapi-eu.amazon.com' 
            : 'sellingpartnerapi-na.amazon.com';
          
          // Build a custom SP-API call for this marketplace
          const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
          const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
          const region = mp.region === 'EU' ? 'eu-west-1' : (Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1');
          
          if (!awsAccessKeyId || !awsSecretAccessKey) {
            return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'ERROR', reasons: ['AWS credentials missing'] };
          }
          
          const path = '/listings/2021-08-01/restrictions';
          const queryParams = `asin=${asin}&sellerId=${sellerId}&marketplaceIds=${mp.marketplaceId}&conditionType=new_new`;
          const url = `https://${endpoint}${path}?${queryParams}`;
          
          // SigV4 signing
          const now = new Date();
          const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
          const dateStamp = amzDate.slice(0, 8);
          const service = 'execute-api';
          
          const canonicalHeaders = `host:${endpoint}\nx-amz-date:${amzDate}\n`;
          const signedHeaders = 'host;x-amz-date';
          const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
          const canonicalRequest = `GET\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
          
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
          
          // fetchWithRetry, NOT fetchWithTimeout. This call had no retry at
          // all, which is why a single throttled response became a permanent
          // "ERROR" chip for that marketplace until the user pressed Find
          // again.
          const response = await fetchWithRetry(url, {
            method: 'GET',
            headers: {
              'host': endpoint,
              'x-amz-date': amzDate,
              'x-amz-access-token': token,
              'Authorization': authorizationHeader,
            },
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.warn(`Restrictions check failed for ${mp.id}:`, response.status, errorText);
            // 403/401 typically means not authorized for this marketplace
            if (response.status === 403 || response.status === 401) {
              return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'NO_AUTH', reasons: ['Not authorized for this marketplace'] };
            }
            // Distinct from ERROR on purpose. A throttle says nothing about
            // whether the ASIN is sellable -- it means we never got to ask.
            // Reporting it as ERROR next to a real gating result invites the
            // reading that Amazon refused the listing, which it did not.
            if (response.status === 429) {
              return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'THROTTLED', reasons: ['Amazon rate-limited this check after retries — press Find again in a few seconds.'] };
            }
            return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'ERROR', reasons: [`API error: ${response.status}`] };
          }
          
          const restrictionsData = await response.json();
          console.log(`[${mp.id}] Raw restrictions response:`, JSON.stringify(restrictionsData, null, 2));
          
          const restrictions = (restrictionsData?.restrictions || []).filter((restriction: any) =>
            isRestrictionForCondition(restriction, 'new_new')
          );
          
          if (restrictions.length === 0) {
            return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'APPROVED', reasons: ['Amazon returned no listing restrictions for New condition.'] };
          }
          
          // Seller-account verified-approval override — mirrors
          // check-fba-listing-eligibility's sellerVerifiedApproved logic,
          // which this function was entirely missing. Amazon's brand-level
          // APPROVAL_REQUIRED restriction can lag well behind reality: if the
          // user already has an active listing/inventory row for this ASIN,
          // or a repricer assignment in THIS marketplace, Amazon has already
          // let them sell it — a stale APPROVAL_REQUIRED must not keep
          // showing "needs approval" after that. Hard NOT_ELIGIBLE blocks
          // still apply regardless (those mean Amazon revoked eligibility).
          let sellerVerifiedApproved = false;
          try {
            const [{ data: invRows }, { data: clRows }, { data: raRows }] = await Promise.all([
              supabaseAdmin.from('inventory').select('listing_status').eq('user_id', user.id).eq('asin', asin),
              supabaseAdmin.from('created_listings').select('validation_status').eq('user_id', user.id).eq('asin', asin),
              supabaseAdmin.from('repricer_assignments').select('id').eq('user_id', user.id).eq('asin', asin).eq('marketplace', mp.id).limit(1),
            ]);
            const hasActiveInventory = (invRows || []).some((r: any) => {
              const s = String(r.listing_status || '').toUpperCase();
              return s !== 'NOT_IN_CATALOG' && s !== 'DELETED';
            });
            const hasActiveCreatedListing = (clRows || []).some((r: any) => {
              const s = String(r.validation_status || 'ACTIVE').toUpperCase();
              return s === 'ACTIVE' || s === 'PENDING_VALIDATION';
            });
            const hasRepricerAssignment = Array.isArray(raRows) && raRows.length > 0;
            sellerVerifiedApproved = hasActiveInventory || hasActiveCreatedListing || hasRepricerAssignment;
          } catch (_) {
            // Non-fatal — fall back to the raw restriction status.
          }

          let hasActionableRestriction = false;
          let status = 'APPROVED';
          const reasons: string[] = [];

          for (const restriction of restrictions) {
            const reasonList = restriction?.reasons || [];
            for (const reason of reasonList) {
              const message = reason.message || reason.reasonCode || 'Unknown restriction';
              const reasonCode = String(reason.reasonCode || '').toUpperCase();

              if (reasonCode === 'APPROVAL_REQUIRED' && sellerVerifiedApproved) {
                reasons.push(`Amazon returned "${message}" but you already have an active listing for this ASIN in ${mp.id} — approval is verified at the seller-account level.`);
                console.log(`[${mp.id}] APPROVAL_REQUIRED overridden — seller already has an active listing for ${asin}`);
                continue;
              }

              if (reasonCode === 'APPROVAL_REQUIRED' || reasonCode === 'NOT_ELIGIBLE') {
                hasActionableRestriction = true;
                reasons.push(message);
                if (reasonCode === 'APPROVAL_REQUIRED') {
                  status = 'APPROVAL_REQUIRED';
                } else {
                  status = 'RESTRICTED';
                }
              } else {
                reasons.push(message);
                console.log(`[${mp.id}] Informational restriction:`, message);
              }
            }
          }
          
          // If no actionable restrictions found, seller is approved
          if (!hasActionableRestriction) {
            console.log(`[${mp.id}] No actionable restrictions - seller is approved`);
            return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'APPROVED', reasons: [] };
          }
          
          return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status, reasons };
        } catch (err) {
          console.error(`Error checking ${mp.id}:`, err);
          return { marketplace: mp.id, marketplaceId: mp.marketplaceId, name: mp.name, flag: mp.flag, status: 'ERROR', reasons: [String(err)] };
        }
      }
      
      if (primaryAuth?.seller_id && authRows && authRows.length > 0) {
        // Build marketplace list from user's actual connections
        const connectedMarketplaces = authRows
          .map(a => MARKETPLACE_REGISTRY[a.marketplace_id])
          .filter(Boolean);

        if (connectedMarketplaces.length === 0) {
          console.log('No recognized marketplaces in user authorizations');
          gatingStatus = 'NO_SELLER_AUTH';
        } else {
          console.log(`Checking gating for ${connectedMarketplaces.length} connected marketplaces:`, connectedMarketplaces.map(m => m.id));
          
          const tokenByMarketplaceId: Record<string, string> = {};
          const sellerIdByMarketplaceId: Record<string, string> = {};
          for (const authRow of authRows) {
            const mp = MARKETPLACE_REGISTRY[authRow.marketplace_id];
            if (!mp) continue;
            if (authRow.seller_id) sellerIdByMarketplaceId[authRow.marketplace_id] = authRow.seller_id;
            if (!authRow.refresh_token) continue;
            try {
              tokenByMarketplaceId[authRow.marketplace_id] = await getLwaAccessToken(mp.region === 'EU' ? 'EU' : 'NA', authRow.refresh_token);
            } catch (tokenErr) {
              console.warn(`Could not obtain ${mp.id} marketplace token:`, tokenErr instanceof Error ? tokenErr.message : String(tokenErr));
            }
          }

          // Get EU access token if any connected marketplace is EU
          let euAccessToken: string | null = null;
          if (connectedMarketplaces.some(m => m.region === 'EU')) {
            try {
              euAccessToken = await getLwaAccessToken('EU');
              console.log('Successfully obtained EU access token');
            } catch (euErr) {
              console.warn('EU access token not available:', euErr instanceof Error ? euErr.message : String(euErr));
            }
          }
          
          const gatingPromises = connectedMarketplaces.map(mp => {
            const tokenToUse = tokenByMarketplaceId[mp.marketplaceId] || (mp.region === 'EU' && euAccessToken ? euAccessToken : accessToken);
            // CRITICAL: each marketplace must use its OWN seller_id from
            // seller_authorizations. Reusing primaryAuth.seller_id (US) for
            // CA/MX/BR/EU caused Amazon to answer "approval required" because
            // the US seller wasn't approved on the regional account.
            const sellerIdToUse = sellerIdByMarketplaceId[mp.marketplaceId] || primaryAuth.seller_id;
            return checkMarketplaceRestrictions(mp, sellerIdToUse, tokenToUse);
          });
          
          const results = await Promise.all(gatingPromises);
          marketplaceGating.push(...results);

          console.log('Multi-marketplace gating results:', JSON.stringify(marketplaceGating, null, 2));
          
          // Set primary gating status based on first connected marketplace
          const usResult = marketplaceGating.find(g => g.marketplace === 'US');
          const primaryResult = usResult || marketplaceGating[0];
          if (primaryResult) {
            gatingStatus = primaryResult.status;
            gatingReasons = primaryResult.reasons;
          }
        }
      } else {
        console.log('No seller authorization found, skipping gating check');
        gatingStatus = 'NO_SELLER_AUTH';
      }
    } catch (error) {
      console.error('Error checking gating status:', error);
      gatingStatus = 'ERROR';
    }

    return new Response(
      JSON.stringify({
        asin,
        title,
        imageUrl,
        price,
        amazonFeeFbm,
        // Only return fees when SP-API actually returned a non-zero estimate.
        // Returning {0,0,0} on throttle/error silently inflates ROI in the
        // extension (profit = price - cost - 0). Null forces UI to show
        // "fees unavailable" instead of a fake number.
        fees: fbaEstimateComplete ? fbaFees : null,
        feesUnavailable: !fbaEstimateComplete,
        feesUnavailableReason,
        feesSource: fbaFees.fromCache ? 'asin_fee_cache' : (fbaEstimateComplete ? 'amazon_fees_api' : null),
        available,
        reserved,
        inbound,
        unfulfilled,
        gatingStatus,
        gatingReasons,
        marketplaceGating  // New: array of eligibility per marketplace
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    const message = (error as Error).message || 'Unknown error';
    if (message.includes('LWA token error') || message.includes('unauthorized_client') || message.includes('invalid_client')) {
      return new Response(
        JSON.stringify({
          error: 'AMAZON_AUTH_FAILED',
          message: 'Amazon authorization failed. Please reconnect Amazon from settings, then try again.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
