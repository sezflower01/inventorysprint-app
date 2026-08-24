import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getListingUnitCost, getInventoryUnitCost } from "../_shared/cost-contract.ts";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
import { computeBbOwnEstimateFields, makeSellerIdCache } from "../_shared/bbOwnEstimate.ts";
import { waitForApiToken } from "../_shared/rate-limiter.ts";
let _currentUserId: string | null = null;

type CostResolution = { unitCost: number | null; source: string | null };

function isValidAsinForCost(asin?: string | null): asin is string {
  return !!asin && asin !== 'UNKNOWN' && asin !== 'PENDING';
}

function getOrderDateBoundary(orderDate?: string | null): string | null {
  if (!orderDate) return null;
  const d = new Date(`${orderDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function getListingDate(listing: any): string {
  return String(listing?.date_created || listing?.created_at || listing?.updated_at || '').slice(0, 10);
}

function pickNewestListingForMetadata(existing: any | undefined, candidate: any) {
  if (!existing) return candidate;
  const existingTs = existing?.updated_at ? Date.parse(existing.updated_at) : Date.parse(existing?.created_at || existing?.date_created || '') || 0;
  const candidateTs = candidate?.updated_at ? Date.parse(candidate.updated_at) : Date.parse(candidate?.created_at || candidate?.date_created || '') || 0;
  return candidateTs >= existingTs ? candidate : existing;
}

function pickHistoricalListingForCost(rows: any[] | undefined, orderDate?: string | null): any | null {
  const list = rows || [];
  if (!list.length) return null;
  const day = orderDate?.slice(0, 10) || null;
  const eligible = day ? list.filter(r => {
    const d = getListingDate(r);
    return !!d && d <= day;
  }) : list;
  return eligible.sort((a, b) => {
    const ad = getListingDate(a), bd = getListingDate(b);
    if (ad !== bd) return bd.localeCompare(ad);
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  })[0] || null;
}

function pickHistoricalPurchaseForCost(rows: any[] | undefined, orderDate?: string | null): any | null {
  const boundary = getOrderDateBoundary(orderDate);
  if (!boundary) return null;
  return (rows || [])
    .filter(r => Number(r?.unit_cost) > 0 && String(r?.purchase_date || '') < boundary)
    .sort((a, b) => {
      const ap = String(a?.purchase_date || ''), bp = String(b?.purchase_date || '');
      if (ap !== bp) return bp.localeCompare(ap);
      const ac = String(a?.created_at || ''), bc = String(b?.created_at || '');
      if (ac !== bc) return bc.localeCompare(ac);
      return String(b?.id || '').localeCompare(String(a?.id || ''));
    })[0] || null;
}

function getHistoricalCostEventTs(row: any): string {
  return row?.purchase_date
    || (row?.date_created ? `${String(row.date_created).slice(0, 10)}T00:00:00.000Z` : '')
    || row?.created_at
    || '';
}

function pickHistoricalCostForCost(purchases: any[] | undefined, listings: any[] | undefined, costHistory: any[] | undefined, orderDate?: string | null): CostResolution {
  const candidates: Array<{ unitCost: number; source: string; costTs: string; createdAt: string; tieRank: number; id: string }> = [];
  const boundary = getOrderDateBoundary(orderDate);
  const day = orderDate?.slice(0, 10) || null;

  // Tier A — immutable cost_history (preferred)
  for (const row of costHistory || []) {
    const unit = Number(row?.cost) || 0;
    if (unit <= 0) continue;
    const eff = String(row?.effective_date || '').slice(0, 10);
    const rec = String(row?.recorded_at || '').slice(0, 10);
    if (day && (!eff || eff > day)) continue;
    if (day && rec && rec > day) continue;
    candidates.push({ unitCost: unit, source: 'cost_history', costTs: `${eff}T00:00:00.000Z`, createdAt: String(row?.recorded_at || ''), tieRank: -1, id: String(row?.id || '') });
  }

  for (const row of purchases || []) {
    const unit = Number(row?.unit_cost) || 0;
    if (unit <= 0 || (boundary && String(row?.purchase_date || '') >= boundary)) continue;
    candidates.push({ unitCost: unit, source: 'purchase_batch', costTs: getHistoricalCostEventTs(row), createdAt: String(row?.created_at || ''), tieRank: 0, id: String(row?.id || '') });
  }

  // STRICT 3-clause guard on created_listings.
  for (const row of listings || []) {
    const d = getListingDate(row);
    if (day && (!d || d > day)) continue;
    const createdDay = String(row?.created_at || '').slice(0, 10);
    if (day && createdDay && createdDay > day) continue;
    const updatedDay = String(row?.updated_at || '').slice(0, 10);
    if (day && updatedDay && updatedDay > day) continue;
    const unit = getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units });
    if (unit === null || unit <= 0) continue;
    candidates.push({ unitCost: unit, source: 'created_listings_historical', costTs: getHistoricalCostEventTs(row), createdAt: String(row?.created_at || ''), tieRank: 1, id: String(row?.id || '') });
  }

  const best = candidates.sort((a, b) => {
    if (a.costTs !== b.costTs) return b.costTs.localeCompare(a.costTs);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
    return b.id.localeCompare(a.id);
  })[0];

  return best ? { unitCost: best.unitCost, source: best.source } : { unitCost: null, source: null };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Debug: targeted order logging
const DEBUG_ORDER_ID = '701-6613435-3082665';
const isDebugOrder = (orderId: string) => orderId === DEBUG_ORDER_ID;

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
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
    const error = await response.text();
    console.error('LWA token error:', error);
    if (_currentUserId) {
      HealthSignals.spApiAuthError(_currentUserId, 'fetch-live-orders', error.slice(0, 500));
    }
    throw new Error('Failed to get LWA access token');
  }

  const data = await response.json();
  return data.access_token;
}

// Amazon business day = midnight-to-midnight in Pacific Time
const AMAZON_BUSINESS_TZ = 'America/Los_Angeles';

// Convert ISO timestamp to Pacific Time date string (YYYY-MM-DD)
// This is the CORRECT approach: format directly in PT, no hour shifting
function getPacificDateString(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: AMAZON_BUSINESS_TZ });
  } catch {
    return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  }
}

// Legacy alias for compatibility - now just uses PT directly
function getCutoffDateStringInTimeZone(isoDate: string, _timeZone: string): string {
  return getPacificDateString(isoDate);
}

function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns the timezone offset (minutes) for a given instant.
// Positive means the timezone is ahead of UTC.
function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const y = map.get('year');
  const m = map.get('month');
  const d = map.get('day');
  const hh = map.get('hour');
  const mm = map.get('minute');
  const ss = map.get('second');
  if (!y || !m || !d || !hh || !mm || !ss) return 0;

  // Interpreting the formatted local time as UTC gives us the delta.
  const asUTC = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`);
  return (asUTC.getTime() - date.getTime()) / 60000;
}

// Convert a local date-time (YYYY-MM-DDTHH:mm:ss.sss) in a timezone to a UTC Date.
function zonedTimeToUtc(localIsoNoZ: string, timeZone: string): Date {
  const assumedUtc = new Date(`${localIsoNoZ}Z`);
  const offsetMinutes = getTimeZoneOffsetMinutes(assumedUtc, timeZone);
  return new Date(assumedUtc.getTime() - offsetMinutes * 60000);
}

// Business-day window in UTC for [startDate..endDate] inclusive,
// where business days = midnight-to-midnight in Pacific Time
function getBusinessDayUtcWindow(startDate: string, endDate: string, _timeZone: string): { start: Date; end: Date } {
  // Always use Pacific Time for Amazon business day boundaries
  const startLocal = `${startDate}T00:00:00.000`;
  const endPlusOne = addDaysISO(endDate, 1);
  const endLocalExclusive = `${endPlusOne}T00:00:00.000`;

  const start = zonedTimeToUtc(startLocal, AMAZON_BUSINESS_TZ);
  const endExclusive = zonedTimeToUtc(endLocalExclusive, AMAZON_BUSINESS_TZ);
  const end = new Date(endExclusive.getTime() - 1);

  return { start, end };
}

interface LiveOrder {
  orderId: string;
  asin: string;
  sku: string | null;
  title: string | null;
  imageUrl: string | null;
  quantity: number;
  soldPrice: number;
  totalSaleAmount: number;
  orderDate: string;
  orderStatus: string;
  orderType: string | null;
  unitCost: number | null;
  referralFee: number;
  fbaFee: number;
  closingFee: number;
  shippingLabelFee: number;
  totalFees: number;
}

// STRICT MODE: No fee estimation fallbacks allowed
// If Fees API fails, return NULL - fees will be "unavailable" until settlement
// This prevents corrupting ROI calculations with guessed values
function estimateFees(
  soldPrice: number,
  isMedia: boolean = false
): { referralFee: number | null; fbaFee: number | null; closingFee: number | null; shippingLabelFee: number; totalFees: number | null; feesUnavailable: boolean } {
  // STRICT: No fallback guessing - return nulls, show "Fees unavailable" in UI
  // Actual fees come from Financial Events API after settlement
  return { referralFee: null, fbaFee: null, closingFee: null, shippingLabelFee: 0, totalFees: null, feesUnavailable: true };
}

// Fetch actual fees from Amazon Product Fees API using proportional scaling.
// We call the Fees API at `referencePrice` (Buy Box / listing price) and then
// scale the fees proportionally to match `actualSalePrice`.
// For non-US marketplaces, we must send the price in LOCAL CURRENCY, then convert returned fees to USD.
async function getProductFees(
  supabase: ReturnType<typeof createClient>,
  asin: string,
  referencePriceUsd: number, // This is always in USD
  accessToken: string,
  marketplaceId: string = 'ATVPDKIKX0DER',
  actualSalePriceUsd?: number, // If provided, fees are scaled proportionally (always USD)
  fxRates?: Record<string, number>, // FX rates for currency conversion
  isAmazonFulfilled: boolean = true // false = FBM (Merchant Fulfilled)
): Promise<{ referralFee: number; fbaFee: number; closingFee: number; totalFees: number; feeSource: string; currency?: string } | null> {
  if (!asin || asin === 'UNKNOWN' || asin === 'PENDING' || referencePriceUsd <= 0) return null;

  const salePriceUsd = actualSalePriceUsd && actualSalePriceUsd > 0 ? actualSalePriceUsd : referencePriceUsd;

  // Determine the currency code based on marketplace
  const marketplaceToCurrency: Record<string, string> = {
    'ATVPDKIKX0DER': 'USD', // US
    'A2EUQ1WTGCTBG2': 'CAD', // CA
    'A1AM78C64UM0Y8': 'MXN', // MX
    'A2Q3Y263D00KWC': 'BRL', // BR
  };
  const currencyCode = marketplaceToCurrency[marketplaceId] || 'USD';
  const isNonUs = currencyCode !== 'USD';
  
  // CRITICAL FIX: For non-US marketplaces, convert USD price to LOCAL currency before calling Fees API
  // Amazon expects the price in local currency for accurate fee calculation
  const fxRate = (fxRates && fxRates[currencyCode]) ? fxRates[currencyCode] : 1;
  const referencePriceLocal = isNonUs ? referencePriceUsd * fxRate : referencePriceUsd;
  const salePriceLocal = isNonUs ? salePriceUsd * fxRate : salePriceUsd;
  
  if (isNonUs) {
    console.log(`[FEES_API] ${asin} Converting USD $${referencePriceUsd.toFixed(2)} → ${currencyCode} ${referencePriceLocal.toFixed(2)} for Fees API`);
  }

  const feesUrl = `https://sellingpartnerapi-na.amazon.com/products/fees/v0/items/${asin}/feesEstimate`;
  const feesBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: isAmazonFulfilled,
      ...(isAmazonFulfilled ? { OptionalFulfillmentProgram: 'FBA_CORE' } : {}),
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currencyCode, Amount: referencePriceLocal },
      },
      Identifier: asin,
    },
  });
  
  console.log(`[FEES_API] ${asin} Requesting fees with IsAmazonFulfilled=${isAmazonFulfilled}`);
  // Fees API: shared budget with sync-sales-orders so both don't collide.
  await waitForApiToken(supabase, 'fees_api');

  const parseMoney = (m: any): number => {
    const raw = m?.Amount ?? m?.CurrencyAmount ?? m?.amount ?? m?.value;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0'));
    return Number.isFinite(n) ? n : 0;
  };

  const getCurrency = (m: any): string => {
    return m?.CurrencyCode ?? m?.currencyCode ?? 'USD';
  };

  const extract = (feesData: any) => {
    const result = feesData?.payload?.FeesEstimateResult;
    const status = String(result?.Status ?? '').toLowerCase();
    if (status && status !== 'success') {
      const reason = result?.ErrorMessage ?? feesData?.payload?.Errors?.[0]?.message;
      console.warn(`[FEES_API] ${asin} non-success status: ${result?.Status} ${reason ? `- ${reason}` : ''}`);
      return null;
    }

    const feeDetails = result?.FeesEstimate?.FeeDetailList;
    if (!Array.isArray(feeDetails) || feeDetails.length === 0) return null;

    let apiReferralFee = 0;
    let apiFbaFee = 0;
    let apiClosingFee = 0;
    let feeCurrency = 'USD';

    for (const fee of feeDetails) {
      const type = String(fee?.FeeType ?? '');
      const amount = parseMoney(fee?.FeeAmount);
      feeCurrency = getCurrency(fee?.FeeAmount) || feeCurrency;

      if (type === 'ReferralFee' || type.includes('Referral')) {
        apiReferralFee += amount;
      } else if (type === 'VariableClosingFee' || type === 'FixedClosingFee' || type.includes('ClosingFee')) {
        // Capture closing fee from API (applies to media products: Books, Music, DVD, etc.)
        apiClosingFee += amount;
        if (amount > 0) console.log(`[FEES_API] ${asin} ${type}=$${amount} (media closing fee captured)`);
      } else if (type === 'FBAFees' || type.startsWith('FBA') || type.includes('Fulfillment')) {
        apiFbaFee += amount;
      }
    }

    // Convert fees to USD if they're in local currency
    // Note: fxRate from outer scope already available for the marketplace
    
    if (isNonUs) {
      console.log(`[FEES_API] ${asin} Converting fees from ${feeCurrency} to USD (rate=${fxRate})`);
      apiReferralFee = apiReferralFee / fxRate;
      apiFbaFee = apiFbaFee / fxRate;
      apiClosingFee = apiClosingFee / fxRate;
    }

    // FBA fee is FIXED (based on size/weight tier) - do NOT scale proportionally
    // Only referral fee scales proportionally with price
    // Closing fee is also FIXED per item (not scaled)
    // IMPORTANT: After converting fees to USD, use USD prices for ratio calculation
    const referralRatio = referencePriceUsd > 0 ? apiReferralFee / referencePriceUsd : 0;
    const scaledReferralFee = salePriceUsd * referralRatio;
    const fixedFbaFee = apiFbaFee; // FBA fee is fixed, not scaled (already in USD)
    const fixedClosingFee = apiClosingFee; // Closing fee is fixed (media products only, already in USD)

    const totalFees = scaledReferralFee + fixedFbaFee + fixedClosingFee;
    
    console.log(`[FEES_API] ${asin} Final USD fees: referral=$${scaledReferralFee.toFixed(2)}, fba=$${fixedFbaFee.toFixed(2)}, total=$${totalFees.toFixed(2)}`);

    return {
      referralFee: scaledReferralFee,
      fbaFee: fixedFbaFee,
      closingFee: fixedClosingFee,
      totalFees,
      feeSource: isNonUs ? 'fees_api_fx' : (referencePriceUsd === salePriceUsd ? 'fees_api' : 'fees_api_proportional'),
      currency: 'USD', // Always return USD fees
    };
  };

  try {
    const feesHeaders = await signRequest('POST', feesUrl, feesBody, accessToken);

    const doRequest = async () =>
      fetch(feesUrl, {
        method: 'POST',
        headers: { ...feesHeaders, 'Content-Type': 'application/json' },
        body: feesBody,
      });

    let feesResp = await doRequest();
    if (feesResp.status === 429) {
      console.warn(`[FEES_API] Rate limited for ${asin}, retrying once...`);
      if (_currentUserId) HealthSignals.feesApiThrottled(_currentUserId, 'fetch-live-orders', asin);
      await new Promise((r) => setTimeout(r, 1000));
      feesResp = await doRequest();
    }

    if (!feesResp.ok) {
      const text = await feesResp.text().catch(() => '');
      console.warn(`[FEES_API] Failed for ${asin}: ${feesResp.status} ${text.slice(0, 300)}`);
      return null;
    }

    const feesData = await feesResp.json();
    const parsed = extract(feesData);
    if (!parsed) {
      console.warn(`[FEES_API] No usable fee details for ${asin}`);
      return null;
    }

    const scaling = referencePriceUsd !== salePriceUsd
      ? ` (scaled from $${referencePriceUsd.toFixed(2)} → $${salePriceUsd.toFixed(2)})`
      : '';
    const fxNote = parsed.currency !== 'USD' ? ` [converted from ${parsed.currency}]` : '';
    console.log(
      `[FEES_API] ✓ ${asin} @ $${salePriceUsd.toFixed(2)}: referral=$${parsed.referralFee.toFixed(2)}, fba=$${parsed.fbaFee.toFixed(2)}, total=$${parsed.totalFees.toFixed(2)}${scaling}${fxNote}`
    );

    return parsed;
  } catch (err) {
    console.warn(`[FEES_API] Error for ${asin}:`, err);
    return null;
  }
}

// MARKETPLACE_TO_CURRENCY map for currency conversion
const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  'ATVPDKIKX0DER': 'USD', // US
  'A2EUQ1WTGCTBG2': 'CAD', // CA
  'A1AM78C64UM0Y8': 'MXN', // MX
  'A2Q3Y263D00KWC': 'BRL', // BR
};

// NEW: Fetch SELLER'S OWN listing price using Listings API (SKU-based)
// This returns YOUR price, not competitor/buy box price
async function getSellerListingPrice(
  sku: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string,
  fxRates: Record<string, number>
): Promise<{ priceUsd: number | null; localPrice: number | null; currency: string; fxRate: number }> {
  const currency = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
  const fxRate = fxRates[currency] || 1;
  
  try {
    const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
    const url = `https://sellingpartnerapi-na.amazon.com${path}?marketplaceIds=${marketplaceId}&includedData=offers,summaries`;
    
    console.log(`[LISTINGS_API] Fetching seller's price for SKU ${sku} in marketplace ${marketplaceId} (${currency})`);
    
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { method: 'GET', headers });
    
    if (response.status === 429) {
      console.log(`[LISTINGS_API] Rate limited for SKU ${sku}`);
      return { priceUsd: null, localPrice: null, currency, fxRate };
    }
    if (response.status === 403) {
      console.log(`[LISTINGS_API] Authorization required for SKU ${sku}`);
      return { priceUsd: null, localPrice: null, currency, fxRate };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[LISTINGS_API] Error for SKU ${sku}: ${response.status} ${text.slice(0, 200)}`);
      return { priceUsd: null, localPrice: null, currency, fxRate };
    }
    
    const data = await response.json();
    let localPrice: number | null = null;
    
    // Extract price from offers (same logic as backfill-my-price-cache)
    if (data.offers && Array.isArray(data.offers)) {
      for (const offer of data.offers) {
        const rawAmount = 
          offer.price?.amount ||
          offer.price?.listingPrice?.amount ||
          offer.listingPrice?.amount ||
          offer.ourPrice?.amount;
        const priceValue = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
        if (priceValue && typeof priceValue === 'number' && !isNaN(priceValue) && priceValue > 0) {
          localPrice = priceValue;
          break;
        }
      }
    }
    
    // Fallback: check summaries
    if (!localPrice && data.summaries && Array.isArray(data.summaries)) {
      for (const summary of data.summaries) {
        const priceValue = summary.price?.listingPrice?.amount || summary.price?.amount;
        if (priceValue && typeof priceValue === 'number' && priceValue > 0) {
          localPrice = priceValue;
          break;
        }
      }
    }
    
    // Fallback: check attributes.purchasable_offer
    if (!localPrice && data.attributes?.purchasable_offer) {
      const purchasableOffer = data.attributes.purchasable_offer;
      if (Array.isArray(purchasableOffer)) {
        for (const po of purchasableOffer) {
          const ourPrice = po.our_price?.[0]?.schedule?.[0]?.value_with_tax;
          if (ourPrice && typeof ourPrice === 'number' && ourPrice > 0) {
            localPrice = ourPrice;
            break;
          }
        }
      }
    }
    
    if (localPrice === null || localPrice <= 0) {
      console.log(`[LISTINGS_API] No valid price found for SKU ${sku} (${marketplaceId})`);
      return { priceUsd: null, localPrice: null, currency, fxRate };
    }
    
    // Convert to USD using database FX rates
    const priceUsd = currency === 'USD' ? localPrice : localPrice / fxRate;
    
    console.log(`[LISTINGS_API] ✓ SKU ${sku} (${marketplaceId}): ${currency} ${localPrice.toFixed(2)} / ${fxRate} = USD $${priceUsd.toFixed(2)}`);
    return { priceUsd, localPrice, currency, fxRate };
  } catch (err) {
    console.error(`[LISTINGS_API] Error fetching price for SKU ${sku}:`, err);
    return { priceUsd: null, localPrice: null, currency, fxRate };
  }
}

// LEGACY: Fetch listing price from Pricing API (returns ALL sellers' offers, not your specific price)
// DEPRECATED for pending order estimation - use getSellerListingPrice instead
// Kept for fallback when SKU is not available
async function getMarketplacePricingPrice(
  supabase: any,
  asin: string,
  marketplaceId: string,
  accessToken: string,
  fxRates: Record<string, number>
): Promise<{ priceUsd: number | null; localPrice: number | null; currency: string; fxRate: number }> {
  try {
    const endpoint = 'https://sellingpartnerapi-na.amazon.com';
    const path = `/products/pricing/v0/items/${asin}/offers`;
    const queryParams = `MarketplaceId=${marketplaceId}&ItemCondition=New`;
    const url = `${endpoint}${path}?${queryParams}`;

    const headers = await signRequest('GET', url, '', accessToken);
    await waitForApiToken(supabase, 'pricing_api');
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[PRICING_API] Error for ASIN ${asin} (${marketplaceId}): ${response.status} ${text.slice(0, 200)}`);
      return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
    }

    const data = await response.json();
    const summary = data?.payload?.Summary;
    const offers = data?.payload?.Offers || [];

    let listingPrice: number | null = null;
    let currency = 'USD';

    // PRIORITY 1: Get listing price from first offer (matches Fetch Listing Price tool)
    // WARNING: This is the first offer in the list, NOT necessarily YOUR offer!
    if (offers.length > 0) {
      const firstOffer = offers[0];
      listingPrice = firstOffer.ListingPrice?.Amount || null;
      currency = firstOffer.ListingPrice?.CurrencyCode || 'USD';
      if (listingPrice) {
        console.log(`[PRICING_API] Found listing price from Offers: ${currency} ${listingPrice} (WARNING: may not be seller's price)`);
      }
    }

    // PRIORITY 2: Fallback to LowestPrices for FBA items
    if (listingPrice === null && summary?.LowestPrices) {
      const newLowest = summary.LowestPrices.find((p: any) => p.condition === 'New' && p.fulfillmentChannel === 'Amazon');
      if (newLowest) {
        listingPrice = newLowest.ListingPrice?.Amount || newLowest.LandedPrice?.Amount || null;
        currency = newLowest.ListingPrice?.CurrencyCode || newLowest.LandedPrice?.CurrencyCode || 'USD';
        if (listingPrice) {
          console.log(`[PRICING_API] Found listing price from LowestPrices: ${currency} ${listingPrice}`);
        }
      }
    }

    // PRIORITY 3: Last resort - BuyBox price (only if no listing price available)
    if (listingPrice === null) {
      const buyBoxPrices = summary?.BuyBoxPrices || [];
      if (buyBoxPrices.length > 0) {
        const newBuyBox = buyBoxPrices.find((p: any) => p.condition === 'New');
        if (newBuyBox) {
          listingPrice = newBuyBox.ListingPrice?.Amount || newBuyBox.LandedPrice?.Amount || null;
          currency = newBuyBox.ListingPrice?.CurrencyCode || newBuyBox.LandedPrice?.CurrencyCode || 'USD';
          console.log(`[PRICING_API] Fallback to BuyBox price: ${currency} ${listingPrice}`);
        }
      }
    }

    if (listingPrice === null || listingPrice <= 0) {
      console.log(`[PRICING_API] No valid price found for ASIN ${asin} (${marketplaceId})`);
      return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
    }

    // Convert to USD using database FX rates
    const fxRate = fxRates[currency] || 1;
    const priceUsd = listingPrice / fxRate;

    console.log(`[PRICING_API] ✓ ASIN ${asin} (${marketplaceId}): ${currency} ${listingPrice} / ${fxRate} = USD $${priceUsd.toFixed(2)}`);
    return { priceUsd, localPrice: listingPrice, currency, fxRate };
  } catch (err) {
    console.error(`[PRICING_API] Error fetching price for ASIN ${asin}:`, err);
    return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
  }
}

// Fetch FBM shipping label costs from ServiceFeeEventList
async function fetchShippingLabelCosts(
  accessToken: string,
  startDate: string,
  endDate: string,
  timeZone: string
): Promise<Map<string, number>> {
  const shippingCostMap = new Map<string, number>();

  try {
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

    const { start: postedAfter, end: postedBeforeCandidate } = getBusinessDayUtcWindow(startDate, endDate, timeZone);
    const postedBefore = postedBeforeCandidate < twoMinutesAgo ? postedBeforeCandidate : twoMinutesAgo;
    
    let nextToken: string | undefined;
    let pageCount = 0;
    const maxPages = 5;
    
    do {
      const financeUrl = new URL('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents');
      financeUrl.searchParams.set('PostedAfter', postedAfter.toISOString());
      financeUrl.searchParams.set('PostedBefore', postedBefore.toISOString());
      if (nextToken) {
        financeUrl.searchParams.set('NextToken', nextToken);
      }
      
      const headers = await signRequest('GET', financeUrl.toString(), '', accessToken);
      const response = await fetch(financeUrl.toString(), { method: 'GET', headers });
      
      if (!response.ok) {
        console.warn(`[SHIPPING_LABELS] Financial Events API error: ${response.status}`);
        break;
      }
      
      const data = await response.json();
      const events = data?.payload?.FinancialEvents;
      
      // Extract shipping label costs from ServiceFeeEventList
      const serviceFees = events?.ServiceFeeEventList || [];
      for (const fee of serviceFees) {
        // Amazon Buy Shipping fees have FeeType like "ShippingServices" or contain shipping-related terms
        const feeType = fee.FeeType || '';
        const feeReason = fee.FeeReason || '';
        const amazonOrderId = fee.SellerOrderId || fee.AmazonOrderId;
        
        // Match shipping-related service fees
        if ((feeType.toLowerCase().includes('shipping') || 
             feeReason.toLowerCase().includes('shipping') ||
             feeType === 'ShippingServices' ||
             feeType === 'ShippingLabel') && amazonOrderId) {
          
          const feeList = fee.FeeList || [];
          let totalShippingCost = 0;
          
          for (const feeItem of feeList) {
            const amount = parseFloat(feeItem?.FeeAmount?.CurrencyAmount || '0');
            // Shipping costs are typically negative (charges)
            totalShippingCost += Math.abs(amount);
          }
          
          if (totalShippingCost > 0) {
            // Accumulate in case of multiple shipping fees per order
            const existing = shippingCostMap.get(amazonOrderId) || 0;
            shippingCostMap.set(amazonOrderId, existing + totalShippingCost);
            console.log(`[SHIPPING_LABELS] Found shipping cost from ServiceFee for ${amazonOrderId}: $${totalShippingCost.toFixed(2)} (type: ${feeType})`);
          }
        }
      }
      
      // Also check ShipmentEventList for FBM shipping costs (Buy Shipping charges appear here)
      const shipmentEvents = events?.ShipmentEventList || [];
      for (const shipment of shipmentEvents) {
        const amazonOrderId = shipment.AmazonOrderId;
        if (!amazonOrderId) continue;
        
        // Check ShipmentFeeList for shipping costs
        const shipmentFees = shipment.ShipmentFeeList || [];
        for (const fee of shipmentFees) {
          const feeType = fee.FeeType || '';
          // FBM Buy Shipping costs appear as "ShippingChargeback" or similar
          if (feeType.toLowerCase().includes('shipping') || 
              feeType === 'ShippingChargeback' ||
              feeType === 'ShippingHB') {
            const amount = parseFloat(fee?.FeeAmount?.CurrencyAmount || '0');
            if (amount !== 0) {
              const existing = shippingCostMap.get(amazonOrderId) || 0;
              shippingCostMap.set(amazonOrderId, existing + Math.abs(amount));
              console.log(`[SHIPPING_LABELS] Found shipping cost from ShipmentFee for ${amazonOrderId}: $${Math.abs(amount).toFixed(2)} (type: ${feeType})`);
            }
          }
        }
        
        // Also check DirectPaymentList for shipping label costs
        const directPayments = shipment.DirectPaymentList || [];
        for (const payment of directPayments) {
          const paymentType = payment.DirectPaymentType || '';
          if (paymentType.toLowerCase().includes('shipping') || 
              paymentType === 'ShippingLabel' ||
              paymentType === 'BuyShipping') {
            const amount = parseFloat(payment?.DirectPaymentAmount?.CurrencyAmount || '0');
            if (amount !== 0) {
              const existing = shippingCostMap.get(amazonOrderId) || 0;
              shippingCostMap.set(amazonOrderId, existing + Math.abs(amount));
              console.log(`[SHIPPING_LABELS] Found shipping cost from DirectPayment for ${amazonOrderId}: $${Math.abs(amount).toFixed(2)} (type: ${paymentType})`);
            }
          }
        }
      }
      
      nextToken = data?.payload?.NextToken;
      pageCount++;
      
      if (nextToken && pageCount < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } while (nextToken && pageCount < maxPages);
    
    console.log(`[SHIPPING_LABELS] Found shipping costs for ${shippingCostMap.size} orders`);
    
  } catch (error) {
    console.error('[SHIPPING_LABELS] Error fetching shipping costs:', error);
  }
  
  return shippingCostMap;
}

// Media product types that qualify for $1.80 closing fee
// Reference: https://sellercentral.amazon.com/gp/help/G201411300
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
  // Related media
  'DIGITAL_TEXT', 'KINDLE_EBOOK', 'AUDIBLE_AUDIOBOOK',
]);

// Check if a product type is a media category (qualifies for closing fee)
function isMediaProductType(productType: string | null): boolean {
  if (!productType) return false;
  const normalizedType = productType.toUpperCase().replace(/[-\s]/g, '_');
  return MEDIA_PRODUCT_TYPES.has(normalizedType);
}

// Fetch product data (title, image, productType) from Amazon Catalog API
async function fetchCatalogData(
  asin: string,
  accessToken: string,
  marketplaceId: string
): Promise<{ title: string | null; imageUrl: string | null; productType: string | null; isMedia: boolean }> {
  try {
    const endpoint = `https://sellingpartnerapi-na.amazon.com`;
    const path = `/catalog/2022-04-01/items/${asin}`;
    // Include classifications to get productType for media detection
    const queryParams = `marketplaceIds=${marketplaceId}&includedData=summaries,images,classifications`;
    const url = `${endpoint}${path}?${queryParams}`;

    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`[CATALOG] Rate limited for ${asin}`);
      } else {
        console.warn(`[CATALOG] Failed to fetch for ${asin}: ${response.status}`);
      }
      return { title: null, imageUrl: null, productType: null, isMedia: false };
    }

    const data = await response.json();
    
    // Extract title from summaries
    let title: string | null = null;
    let productType: string | null = null;
    const summaries = data?.summaries || [];
    if (summaries.length > 0) {
      title = summaries[0]?.itemName || null;
    }
    
    // Extract productType from classifications
    const classifications = data?.classifications || [];
    if (classifications.length > 0) {
      // Classifications array has marketplace-specific entries
      // productType is the Amazon internal category identifier
      productType = classifications[0]?.classifications?.[0]?.productType || null;
      
      // Also check browseClassification for backup
      if (!productType && classifications[0]?.browseClassification) {
        const displayName = classifications[0]?.browseClassification?.displayName || '';
        // Map common browse display names to product types
        if (displayName.toLowerCase().includes('book')) productType = 'ABIS_BOOK';
        else if (displayName.toLowerCase().includes('music') || displayName.toLowerCase().includes('cd')) productType = 'ABIS_MUSIC';
        else if (displayName.toLowerCase().includes('dvd') || displayName.toLowerCase().includes('blu-ray')) productType = 'ABIS_DVD';
        else if (displayName.toLowerCase().includes('video game')) productType = 'VIDEO_GAMES';
        else if (displayName.toLowerCase().includes('software')) productType = 'SOFTWARE';
      }
    }
    
    // Extract image from images
    let imageUrl: string | null = null;
    const images = data?.images || [];
    if (images.length > 0) {
      const imageVariants = images[0]?.images || [];
      if (imageVariants.length > 0) {
        imageUrl = imageVariants[0]?.link || null;
      }
    }

    const isMedia = isMediaProductType(productType);
    
    if (title || imageUrl || productType) {
      console.log(`[CATALOG] Got data for ${asin}: title=${title ? 'yes' : 'no'}, image=${imageUrl ? 'yes' : 'no'}, productType=${productType || 'none'}, isMedia=${isMedia}`);
    }

    return { title, imageUrl, productType, isMedia };
  } catch (err) {
    console.warn(`[CATALOG] Error fetching for ${asin}:`, err);
    return { title: null, imageUrl: null, productType: null, isMedia: false };
  }
}

async function captureMissingBbEstimateForOrders(
  supabase: any,
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
  startDate: string,
  endDate: string,
  fxRates: Record<string, number>,
): Promise<number> {
  const { data: rawOrders, error } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, sku, seller_sku, marketplace, purchase_timestamp_utc, order_date, fulfillment_channel, bb_estimate_captured_at, bb_estimate_snapshot_fetched_at, bb_estimate_snapshot_age_seconds, sold_price, estimated_price, price_confidence, price_source')
    .eq('user_id', userId)
    .not('order_id', 'like', '%-REFUND')
    .not('asin', 'in', '(PENDING,UNKNOWN)')
    .not('asin', 'is', null)
    .gte('order_date', startDate)
    .lte('order_date', endDate)
    .order('purchase_timestamp_utc', { ascending: false })
    .limit(200);

  if (error) {
    console.warn('[LIVE_ORDERS] BB_CAPTURE_BACKFILL_SELECT_ERROR:', error.message);
    return 0;
  }
  const orders = (rawOrders || []).filter((order: any) => {
    if (!order.bb_estimate_captured_at) return true;
    if (!order.bb_estimate_snapshot_fetched_at) return true;
    if (order.purchase_timestamp_utc && typeof order.bb_estimate_snapshot_age_seconds === 'number') {
      const purchaseMs = new Date(order.purchase_timestamp_utc).getTime();
      const snapshotMs = new Date(order.bb_estimate_snapshot_fetched_at).getTime();
      if (Number.isFinite(purchaseMs) && Number.isFinite(snapshotMs)) {
        const actualAgeSec = Math.round((purchaseMs - snapshotMs) / 1000);
        // Older rows could be evaluated against the DATE-only order_date
        // (midnight UTC), which made same-day BB captures look ~14h late.
        // Recompute those rows once the true Amazon PurchaseDate is present.
        if (Math.abs(actualAgeSec - order.bb_estimate_snapshot_age_seconds) > 60) return true;
      }
    }
    const capturedMs = new Date(order.bb_estimate_captured_at).getTime();
    const snapshotMs = new Date(order.bb_estimate_snapshot_fetched_at).getTime();
    // If a prior enrichment wrote an old scheduled snapshot, force one live
    // SP-API capture. Once snapshot_fetched_at is close to captured_at, do not
    // retry on every refresh even when Pedu did not own BB.
    return Number.isFinite(capturedMs) && Number.isFinite(snapshotMs) && snapshotMs < capturedMs - 10 * 60 * 1000;
  });
  if (!orders || orders.length === 0) return 0;

  const byMarketplace = new Map<string, Map<string, any>>();
  for (const order of orders) {
    const marketplace = order.marketplace || 'US';
    if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, new Map());
    const sku = order.seller_sku || order.sku || '';
    const key = `${order.asin}|${sku}`;
    if (!byMarketplace.get(marketplace)!.has(key)) {
      byMarketplace.get(marketplace)!.set(key, { asin: order.asin, sku });
    }
  }

  for (const [marketplace, itemMap] of byMarketplace.entries()) {
    const items = Array.from(itemMap.values());
    for (let i = 0; i < items.length; i += 20) {
      const chunk = items.slice(i, i + 20);
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
          body: JSON.stringify({ internal: true, user_id: userId, batch: true, marketplace, items: chunk }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || payload?.success !== true) {
          console.warn(`[LIVE_ORDERS] BB_CAPTURE_SPAPI_BATCH_FAILED ${marketplace}:`, payload?.error || res.status);
          continue;
        }

        const snapshots = Object.values(payload.results || {})
          .filter((r: any) => r?.success === true && r?.data)
          .map((r: any) => {
            const d = r.data;
            return {
              user_id: userId,
              asin: d.asin,
              sku: r.sku || null,
              marketplace: d.marketplace || marketplace,
              fetched_at: d.fetchedAt || new Date().toISOString(),
              buybox_price: d.buyboxPrice ?? null,
              buybox_is_fba: d.buyboxIsFba ?? null,
              buybox_seller_id: d.buyboxSellerId ?? null,
              buybox_seller_name: d.buyboxSellerType || null,
              lowest_fba_price: d.lowestFbaPrice ?? null,
              lowest_fbm_price: d.lowestFbmPrice ?? null,
              lowest_overall_price: d.lowestOverallPrice ?? null,
              offers_count: d.totalOfferCount ?? 0,
              offers_json: d.offerBreakdown || [],
              credits_used: 0,
              source: 'sp-api-order-bb-capture',
              fetch_reason: 'sales_order_bb_capture',
            };
          });

        if (snapshots.length > 0) {
          const { error: insertError } = await supabase.from('repricer_competitor_snapshots').insert(snapshots);
          if (insertError) console.warn('[LIVE_ORDERS] BB_CAPTURE_SNAPSHOT_INSERT_ERROR:', insertError.message);
        }
      } catch (e: any) {
        console.warn(`[LIVE_ORDERS] BB_CAPTURE_BATCH_EXCEPTION ${marketplace}:`, e?.message || e);
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  let updated = 0;
  const cache = makeSellerIdCache();
  for (const order of orders) {
    try {
      const bbFields = await computeBbOwnEstimateFields(
        supabase,
        {
          userId,
          asin: order.asin,
          marketplace: order.marketplace || 'US',
          orderDateIso: order.purchase_timestamp_utc || order.order_date || new Date().toISOString(),
          fulfillmentChannel: order.fulfillment_channel || null,
        },
        cache,
      );
      const updatePayload: Record<string, any> = { ...bbFields };
      // Own-BB capture is diagnostic only for pending orders. Never promote
      // bb_estimate_price into estimated_price: even a qualified Buy Box price
      // can be another offer's price. Pending order display must use seller-
      // derived values only (exact order snapshot, repricer action, Listings).
      const currentSoldPrice = Number(order.sold_price || 0);
      const currentConfidence = order.price_confidence;
      const currentSource = String(order.price_source || '').toLowerCase();
      const currentEst = Number(order.estimated_price || 0);
      const exactSnapshot = await getExactOrderSnapshotEstimate(supabase, userId, order.order_id, order.asin, order.marketplace || 'US', fxRates);
      const exactSnapshotEstimate = exactSnapshot?.price ?? null;
      // Only pricing_api/orders_api snapshots are genuine live reads taken at
      // order-discovery time. 'inventory'-sourced snapshots just freeze
      // whatever inventory.price happened to be at that moment, which can
      // itself be a stale local cache lagging the true live listing (see
      // order 113-6385372-8887439: inventory.price read $10 in the snapshot
      // while the live Buy Box read $20 one second later, and inventory.price
      // wasn't corrected to $20 until 10+ hours after). Only the live-read
      // sources get to unconditionally restore/overwrite the current estimate.
      const exactSnapshotIsLiveRead = exactSnapshot !== null && (exactSnapshot.source === 'pricing_api' || exactSnapshot.source === 'orders_api');
      if (
        exactSnapshotIsLiveRead &&
        currentSoldPrice === 0 &&
        currentConfidence !== 'CONFIRMED' &&
        Math.abs(currentEst - exactSnapshotEstimate!) > 0.001
      ) {
        updatePayload.estimated_price = exactSnapshotEstimate;
        updatePayload.locked_est_price = exactSnapshotEstimate;
        updatePayload.price_source = 'seller_derived:snapshot';
        updatePayload.price_confidence = 'HIGH_CONFIDENCE_PENDING';
        updatePayload.needs_price_enrich = true;
        updatePayload.price_enrich_status = 'pending';
        updatePayload.price_last_error = null;
        console.log(`🛡️ SNAPSHOT_BACKFILL_RESTORED: ${order.order_id}/${order.asin} estimated_price ${currentEst} -> ${exactSnapshotEstimate}`);
      }
      // Seller-derived sources OUTRANK BB estimate. Never overwrite a positive
      // seller-derived estimated_price (live snapshot/repricer/order_total/
      // listings_api) with a BB competitor snapshot — the seller's own listing
      // price is the source of truth for pending orders.
      // ⚠️ repricer_* IS NOT A READ OF OUR PRICE. It is a log of what the
      // repricer SUBMITTED, and it goes stale the moment the listing price
      // changes without a clean action behind it -- a manual edit, another
      // system, or an action that moved the price without logging.
      //
      // It used to sit in the trusted tier below, on the premise (see the old
      // comment) that repricer_action was "tied to THIS order's actual live
      // price". Order 112-0854205-5253012 on 2026-08-24 disproved that:
      //
      //   repricer_price_actions (submitted)   $32.87   <- what we estimated
      //   own-BB snapshots, 28 consecutive     $25.94   <- what was live
      //   Amazon Seller Central (buyer paid)   $25.94
      //
      // Twenty-eight consecutive snapshots across the 5.8h before the sale, all
      // $25.94, all Pedu-owned, all FBA, the closest 11 SECONDS before the
      // order -- and the code logged BB_BACKFILL_SKIPPED_SELLER_DERIVED and kept
      // $32.87. A 27% overstatement, with the correct figure already on screen
      // in BB Discovery and marked Qualified.
      //
      // A qualified + owner-matched BB estimate IS seller-derived: it is our own
      // featured offer, OBSERVED near this order's purchase time rather than
      // assumed from an intent log. So repricer_* belongs in the soft tier by
      // this file's own reasoning.
      //
      // order_total / listings_api / a live pricing_api|orders_api snapshot stay
      // TRUSTED -- those are real reads of our price, not submissions.
      const isSellerDerivedTrusted = exactSnapshotIsLiveRead || currentEst > 0 && (
        currentSource.startsWith('snapshot_price') ||
        currentSource.startsWith('order_total') ||
        currentSource.startsWith('listings_api') ||
        currentSource.startsWith('seller_derived:order_total') ||
        currentSource.startsWith('seller_derived:listings_api')
      );
      // recent_sale (this ASIN's last confirmed sale, up to 14 days old) and
      // an inventory-backed seller_derived:snapshot tag are both "soft"
      // estimates -- neither is tied to THIS order's actual live price the
      // way repricer_action/order_total/listings_api/a live snapshot are. A
      // qualified+owner-matched BB estimate (our own featured offer, anchored
      // near this order's purchase time) is a stronger signal for what we
      // actually charged than either.
      const isSoftEstimate = !isSellerDerivedTrusted && currentEst > 0 && (
        currentSource.startsWith('recent_sale') ||
        currentSource.startsWith('seller_derived:recent') ||
        currentSource.startsWith('seller_derived:snapshot') ||
        // moved here 2026-08-24 -- see the note above the trusted list
        currentSource.startsWith('repricer_') ||
        currentSource.startsWith('seller_derived:repricer')
      );
      const bbPromotesOverSoftEstimate = isSoftEstimate
        && bbFields.bb_estimate_qualified && bbFields.bb_estimate_owner_match
        && (bbFields.bb_estimate_price ?? 0) > 0
        && Math.abs((bbFields.bb_estimate_price ?? 0) - currentEst) > 0.001;
      if (bbPromotesOverSoftEstimate) {
        updatePayload.estimated_price = bbFields.bb_estimate_price;
        updatePayload.locked_est_price = bbFields.bb_estimate_price;
        updatePayload.locked_from = 'bb_estimate:own_buybox';
        updatePayload.price_source = 'bb_estimate:own_buybox';
        updatePayload.price_confidence = 'HIGH_CONFIDENCE_PENDING';
        console.log(`🛡️ BB_PROMOTED_OVER_SOFT_ESTIMATE: ${order.order_id}/${order.asin} estimated_price ${currentEst} -> ${bbFields.bb_estimate_price} (${currentSource} replaced by own-BB anchored near order time)`);
      } else if (bbFields.bb_estimate_qualified && !isSellerDerivedTrusted && !isSoftEstimate) {
        console.log(`🛡️ BB_BACKFILL_CAPTURE_ONLY: ${order.order_id}/${order.asin} did not promote BB=$${bbFields.bb_estimate_price}; pending prices require seller-derived source`);
      } else if ((isSellerDerivedTrusted || isSoftEstimate) && bbFields.bb_estimate_qualified) {
        console.log(`🛡️ BB_BACKFILL_SKIPPED_SELLER_DERIVED: ${order.order_id}/${order.asin} kept ${currentSource}=$${currentEst} over BB=$${bbFields.bb_estimate_price}`);
      }
      const { error: updateError } = await supabase.from('sales_orders').update(updatePayload).eq('id', order.id);
      if (updateError) console.warn(`[LIVE_ORDERS] BB_CAPTURE_ORDER_UPDATE_ERROR ${order.order_id}:`, updateError.message);
      else updated++;
    } catch (e: any) {
      console.warn(`[LIVE_ORDERS] BB_CAPTURE_ORDER_EXCEPTION ${order.order_id}:`, e?.message || e);
    }
  }

  console.log(`[LIVE_ORDERS] BB_CAPTURE_BACKFILL updated ${updated}/${orders.length} missing rows`);
  return updated;
}

async function getExactOrderSnapshotEstimate(
  supabase: any,
  userId: string,
  orderId: string,
  asin: string,
  marketplace: string,
  fxRates: Record<string, number>,
): Promise<{ price: number; source: string } | null> {
  if (!userId || !orderId || !asin || asin === 'UNKNOWN' || asin === 'PENDING') return null;
  const { data, error } = await supabase
    .from('order_price_snapshots')
    .select('snapshot_item_price, snapshot_price, snapshot_source, currency_code, currency')
    .eq('user_id', userId)
    .eq('order_id', orderId)
    .eq('asin', asin)
    .or('snapshot_item_price.gt.0,snapshot_price.gt.0')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[LIVE_ORDERS] Exact order snapshot lookup failed for ${orderId}/${asin}:`, error.message);
    return null;
  }

  const snapshotPrice = Number(data?.snapshot_item_price || data?.snapshot_price || 0);
  if (snapshotPrice <= 0) return null;

  // estimated_price/locked_est_price contract is NATIVE marketplace currency
  // for non-US (see architecture-audit.md "Sold price (pending)"). Snapshots
  // recorded from inventory are always USD (see SNAPSHOT_CAPTURE_CURRENCY_FIX
  // comment near snapshot-capture) and must be converted to native before use
  // here — this is the read side of that same currency fix.
  const marketplaceToCurrency: Record<string, string> = { 'US': 'USD', 'CA': 'CAD', 'MX': 'MXN', 'BR': 'BRL' };
  const nativeCurrency = marketplaceToCurrency[marketplace] || 'USD';
  const snapshotCurrency = data?.currency_code || data?.currency ||
    (data?.snapshot_source === 'pricing_api' || data?.snapshot_source === 'orders_api' ? nativeCurrency : 'USD');
  const nativePrice = snapshotCurrency === 'USD' && nativeCurrency !== 'USD' && fxRates?.[nativeCurrency]
    ? snapshotPrice * fxRates[nativeCurrency]
    : snapshotPrice;

  return { price: Math.round(nativePrice * 100) / 100, source: String(data?.snapshot_source || 'inventory') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user from auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No auth header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    _currentUserId = user.id;
    console.log(`[LIVE_ORDERS] Fetching orders for user ${user.id}`);

    // Parse request body for date range and timezone
    let startDateParam: string | null = null;
    let endDateParam: string | null = null;
    let userTimezone: string = 'America/Los_Angeles'; // Default to Pacific
    try {
      const body = await req.json();
      startDateParam = body?.start_date || null;
      endDateParam = body?.end_date || null;
      userTimezone = body?.timezone || 'America/Los_Angeles';
    } catch {
      // No body, use defaults
    }

    // Default to "today" in Amazon business day terms (midnight-to-midnight PT)
    // NOTE: `userTimezone` is kept for compatibility, but the canonical business-day key is PT.
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: AMAZON_BUSINESS_TZ });
    const queryStartDate = startDateParam || todayPT;
    const queryEndDate = endDateParam || todayPT;

    console.log(`[LIVE_ORDERS] Date range: ${queryStartDate} to ${queryEndDate}, timezone: ${userTimezone}`);

    // STEP 0.5: One-time cleanup of historical PENDING duplicates
    // Delete PENDING rows where a real ASIN row exists for the same order
    // This runs once per sync but is fast (indexed queries) and prevents legacy duplicates
    const { error: cleanupError } = await supabase.rpc('cleanup_pending_duplicates_noop');
    // Note: The cleanup is now done via a simple subquery approach
    const { count: cleanedUp } = await supabase
      .from('sales_orders')
      .delete()
      .eq('user_id', user.id)
      .eq('asin', 'PENDING')
      .gte('order_date', queryStartDate)
      .lte('order_date', queryEndDate)
      .in('order_id', 
        // Subquery: order_ids that have real ASIN rows
        (await supabase
          .from('sales_orders')
          .select('order_id')
          .eq('user_id', user.id)
          .neq('asin', 'PENDING')
          .neq('asin', 'UNKNOWN')
          .gte('order_date', queryStartDate)
          .lte('order_date', queryEndDate)
        ).data?.map(r => r.order_id) || []
      );
    
    if (cleanedUp && cleanedUp > 0) {
      console.log(`[LIVE_ORDERS] 🧹 Cleaned up ${cleanedUp} PENDING duplicate rows`);
    }

    // STEP 1: First, get ALL existing orders from database for this date range (this is our cache)
    const { data: dbOrders, error: dbError } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, sku, seller_sku, title, image_url, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, locked_from, referral_fee, fba_fee, closing_fee, shipping_label_fee, total_fees, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, order_status, order_date, price_source, price_confidence, price_calc_mode, fulfillment_channel')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .not('order_id', 'like', '%-REFUND%')
      .not('order_status', 'in', '("Canceled","Cancelled")')
      .gte('order_date', queryStartDate)
      .lte('order_date', queryEndDate);

    if (dbError) {
      console.error('[LIVE_ORDERS] Database query error:', dbError);
    }

    const existingOrdersMap = new Map<string, any>();
    for (const o of dbOrders || []) {
      existingOrdersMap.set(o.order_id, o);
    }

    console.log(`[LIVE_ORDERS] Found ${dbOrders?.length || 0} orders in database cache`);

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const auth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    const sellerId = auth?.selling_partner_id || auth?.seller_id || null;
    if (authFetchError || !auth?.refresh_token) {
      // No Amazon connection - just return database data
      console.log('[LIVE_ORDERS] No Amazon auth, returning DB data only');
      const liveOrders = (dbOrders || []).map(o => ({
        orderId: o.order_id,
        asin: o.asin,
        sku: o.sku,
        title: o.title,
        imageUrl: o.image_url,
        quantity: o.quantity || 1,
        soldPrice: o.sold_price || 0,
        totalSaleAmount: o.total_sale_amount || 0,
        orderDate: queryStartDate,
        orderStatus: o.order_status || 'Pending',
        unitCost: o.unit_cost,
        referralFee: o.referral_fee || 0,
        fbaFee: o.fba_fee || 0,
        closingFee: o.closing_fee || 0,
        shippingLabelFee: o.shipping_label_fee || 0,
        totalFees: o.total_fees || 0,
      }));
      
      return new Response(JSON.stringify({ success: true, orders: liveOrders, count: liveOrders.length, totalOrdersFromApi: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(auth.refresh_token);
    const primaryMarketplaceId = auth.marketplace_id || 'ATVPDKIKX0DER';
    
    // LOAD DYNAMIC FX RATES from database (no hardcoded rates!)
    const { data: fxRows, error: fxError } = await supabase
      .from('fx_rates')
      .select('quote, rate');
    
    const fxRates: Record<string, number> = { 'USD': 1 };
    if (!fxError && fxRows) {
      for (const row of fxRows) {
        fxRates[row.quote] = row.rate;
      }
    } else {
      console.warn('[LIVE_ORDERS] Failed to load fx_rates, using fallbacks:', fxError?.message);
      // Fallback rates (should rarely be used)
      fxRates['MXN'] = 20.50;
      fxRates['CAD'] = 1.44;
      fxRates['BRL'] = 6.20;
    }
    console.log(`[LIVE_ORDERS] Loaded FX rates: MXN=${fxRates['MXN']}, CAD=${fxRates['CAD']}, BRL=${fxRates['BRL']}`);
    
    // ALL North American marketplaces (US, CA, MX, BR)
    const NA_MARKETPLACE_IDS = [
      'ATVPDKIKX0DER',  // US
      'A2EUQ1WTGCTBG2', // CA
      'A1AM78C64UM0Y8', // MX
      'A2Q3Y263D00KWC', // BR
    ];
    const allNAMarketplaces = NA_MARKETPLACE_IDS.join(',');
    
    // STEP 2: Fetch ONLY order IDs from Amazon to discover NEW orders
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

    // Use business-day boundaries (2 AM cutoff) in the user's timezone.
    // This matches Sellerboard's day attribution and prevents missing orders after midnight UTC.
    const { start: createdAfter, end: createdBeforeCandidate } = getBusinessDayUtcWindow(queryStartDate, queryEndDate, userTimezone);
    const createdBefore = createdBeforeCandidate < twoMinutesAgo ? createdBeforeCandidate : twoMinutesAgo;
    
    console.log(`[LIVE_ORDERS] Calling Amazon API: ${createdAfter.toISOString()} to ${createdBefore.toISOString()}`);
    console.log(`[LIVE_ORDERS] Fetching from ALL NA marketplaces: ${allNAMarketplaces}`);
    
    // Fetch orders from Amazon - just to get order IDs
    const amazonOrderIds = new Set<string>();
    const amazonOrders: any[] = [];
    let nextToken: string | undefined;
    let pageCount = 0;
    const maxPages = 10;
    
    // Track cancelled orders separately for status updates
    const cancelledOrderIds: string[] = [];
    
    do {
      const ordersUrl = new URL('https://sellingpartnerapi-na.amazon.com/orders/v0/orders');
      ordersUrl.searchParams.set('MarketplaceIds', allNAMarketplaces);
      ordersUrl.searchParams.set('CreatedAfter', createdAfter.toISOString());
      ordersUrl.searchParams.set('CreatedBefore', createdBefore.toISOString());
      // Include Canceled status so we can detect and update cancelled orders
      ordersUrl.searchParams.set('OrderStatuses', 'Unshipped,PartiallyShipped,Shipped,Pending,PendingAvailability,Canceled');
      ordersUrl.searchParams.set('SortOrder', 'Descending');
      if (nextToken) {
        ordersUrl.searchParams.set('NextToken', nextToken);
      }
      
      // Orders API's getOrders: Amazon default ~0.0167 req/sec (1/min), burst
      // 20 — the tightest limit of any operation this app calls. Shared
      // across every caller so this cron doesn't collide with anything else
      // hitting the same endpoint.
      await waitForApiToken(supabase, 'orders_api');
      const headers = await signRequest('GET', ordersUrl.toString(), '', accessToken);
      const response = await fetch(ordersUrl.toString(), { method: 'GET', headers });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LIVE_ORDERS] Orders API error: ${response.status} - ${errorText}`);
        break;
      }
      
      const data = await response.json();
      const orderList = data?.payload?.Orders || [];
      
      console.log(`[LIVE_ORDERS] Page ${pageCount + 1}: Found ${orderList.length} orders from Amazon`);
      
      for (const order of orderList) {
        if (order.OrderStatus === 'Canceled') {
          // Track cancelled orders - don't add to main list, but we'll update DB status
          cancelledOrderIds.push(order.AmazonOrderId);
        } else {
          amazonOrderIds.add(order.AmazonOrderId);
          amazonOrders.push(order);
        }
      }
      
      nextToken = data?.payload?.NextToken;
      pageCount++;
      
      if (nextToken && pageCount < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } while (nextToken && pageCount < maxPages);
    
    console.log(`[LIVE_ORDERS] Total orders from Amazon: ${amazonOrderIds.size} active, ${cancelledOrderIds.length} cancelled`);
    
    // STEP 2.2: Update cancelled orders in database (Sellerboard-style immediate cancellation detection)
    // This prevents drift by ensuring cancelled orders are marked correctly every sync
    if (cancelledOrderIds.length > 0) {
      console.log(`[LIVE_ORDERS] 🚫 Updating ${cancelledOrderIds.length} cancelled orders in database`);
      
      const now = new Date().toISOString();
      for (const orderId of cancelledOrderIds) {
        // Update with full cancellation data including zeroing out financial fields
        const { error: cancelError } = await supabase
          .from('sales_orders')
          .update({ 
            order_status: 'Canceled',
            is_cancelled: true,
            cancelled_at: now,
            last_status_sync_at: now,
            status_source: 'amazon',
            // Zero out financial fields for cancelled orders
            quantity: 0,
            sold_price: 0,
            total_sale_amount: 0,
            referral_fee: 0,
            fba_fee: 0,
            closing_fee: 0,
            total_fees: 0,
            updated_at: now
          })
          .eq('user_id', user.id)
          .like('order_id', `${orderId}%`); // Match refund variants too
        
        if (cancelError) {
          console.warn(`[LIVE_ORDERS] Failed to update cancelled order ${orderId}:`, cancelError.message);
        } else {
          console.log(`[LIVE_ORDERS] ✅ Marked order ${orderId} as Canceled (zeroed, is_cancelled=true)`);
        }
      }
    }
    
    // STEP 2.5: Fetch FBM shipping label costs from Financial Events API
    console.log(`[LIVE_ORDERS] Fetching FBM shipping label costs...`);
    const shippingLabelCosts = await fetchShippingLabelCosts(accessToken, queryStartDate, queryEndDate, userTimezone);
    
    // STEP 3: Find NEW orders (in Amazon but not in DB) and orders needing enrichment
    // Skip orders that are already fully enriched (have valid ASIN, sold_price > 0, and fees > 0)
    // ALSO re-enrich orders that were Pending (no price) but have now transitioned to Unshipped (payment authorized)
    const newOrderIds: string[] = [];
    const ordersNeedingEnrichment: string[] = [];
    
    for (const orderId of amazonOrderIds) {
      const existing = existingOrdersMap.get(orderId);
      const amazonOrder = amazonOrders.find(o => o.AmazonOrderId === orderId);
      const currentAmazonStatus = amazonOrder?.OrderStatus || 'Pending';
      
      if (!existing) {
        newOrderIds.push(orderId);
      } else {
        // Only re-enrich if missing critical data
        const hasValidAsin = existing.asin && existing.asin !== 'PENDING';
        const hasValidPrice = existing.sold_price > 0;
        const hasValidFees = existing.total_fees > 0;
        // fulfillment_channel unknown means the fee estimate above could be
        // wrong — it may have defaulted to assuming FBA (see the sticky
        // fulfillment_channel comment in the enrichment loop below) simply
        // because Amazon's Orders API hadn't populated FulfillmentChannel
        // yet on an earlier sync. Without this, "has some total_fees value"
        // short-circuited re-enrichment forever, even when that value was
        // computed under a wrong FBA/FBM assumption. Confirmed live
        // 2026-08-07 on order 112-5948809-4229822 (real FBM order stuck
        // with a phantom $10.50 FBA fee because it never got re-checked).
        const hasKnownFulfillmentChannel = !!existing.fulfillment_channel;
        
        // CRITICAL: Protect repaired non-US prices from being overwritten
        // If price_source starts with 'pricing_api_' (from repair-pending-prices), don't re-enrich
        // This prevents the sync from replacing correctly-repaired MX/CA/BR prices with US estimates
        const priceSource = existing.price_source || '';
        const hasRepairedPrice = priceSource.startsWith('pricing_api_') || priceSource === 'orders_itemprice';
        
        // IMPORTANT: Also re-enrich if status changed from Pending to Unshipped/Shipped
        // (payment was just authorized - prices should now be available from GetOrderItems)
        const dbStatus = existing.order_status || 'Pending';
        const statusChangedFromPending = 
          dbStatus === 'Pending' && 
          (currentAmazonStatus === 'Unshipped' || currentAmazonStatus === 'PartiallyShipped' || currentAmazonStatus === 'Shipped');
        
        // Allow re-enrichment when status changes (to get actual Amazon price), but only if we don't have a repaired price already
        if (statusChangedFromPending && !hasValidPrice && !hasRepairedPrice) {
          console.log(`[LIVE_ORDERS] 🔄 Order ${orderId} status changed: ${dbStatus} → ${currentAmazonStatus} - re-enriching to get real price`);
          ordersNeedingEnrichment.push(orderId);
          continue;
        }
        
        // If already fully enriched, skip API call entirely
        if (hasValidAsin && hasValidPrice && hasValidFees && hasKnownFulfillmentChannel) {
          // Already complete - no API call needed
          continue;
        }
        
        // PROTECT REPAIRED PRICES: If price was repaired via pricing_api, don't re-enrich
        // (the only thing missing is fees, which repair-pending-prices will handle)
        if (hasRepairedPrice && hasValidPrice) {
          console.log(`[LIVE_ORDERS] 🛡️ Order ${orderId} has repaired price (${priceSource}) - skipping re-enrichment to protect`);
          continue;
        }
        
        // Needs enrichment - missing ASIN, price, or fees
        ordersNeedingEnrichment.push(orderId);
      }
    }
    
    console.log(`[LIVE_ORDERS] New orders to insert: ${newOrderIds.length}, Orders needing enrichment: ${ordersNeedingEnrichment.length}, Already complete: ${amazonOrderIds.size - newOrderIds.length - ordersNeedingEnrichment.length}`);
    
    // STEP 4: Fetch item details for orders
    // Use high limit to ensure all orders get prices (critical for accurate sales totals)
    // With 0.8s delay between calls, 100 orders = ~80 seconds which is within edge function timeout
    const maxItemFetches = 100; // High enough to cover most daily order volumes
    const ordersToEnrich = [...newOrderIds, ...ordersNeedingEnrichment].slice(0, maxItemFetches);
    
    // Get local data for enrichment
    // Contract A: include `amount` (= UNIT cost) so getListingUnitCost prefers it over cost/units.
    const { data: createdListings } = await supabase
      .from('created_listings')
      .select('id, asin, sku, title, image_url, cost, units, amount, date_created, created_at, updated_at')
      .eq('user_id', user.id);

    const { data: inventoryData } = await supabase
      .from('inventory')
      .select('asin, sku, title, image_url, price, my_price, cost, units, amount, unit_cost_manual')
      .eq('user_id', user.id);

    const createdListingsMap = new Map<string, any>();
    const createdListingCostRowsByAsin = new Map<string, any[]>();
    const createdListingCostRowsBySku = new Map<string, any[]>();
    const createdListingById = new Map<string, any>();
    const purchaseCostRowsByAsin = new Map<string, any[]>();
    const purchaseCostRowsBySku = new Map<string, any[]>();
    const inventoryMap = new Map<string, any>();

    for (const item of createdListings || []) {
      if (item.id) createdListingById.set(String(item.id), item);
      if (item.asin) {
        createdListingsMap.set(item.asin, pickNewestListingForMetadata(createdListingsMap.get(item.asin), item));
        (createdListingCostRowsByAsin.get(item.asin) || createdListingCostRowsByAsin.set(item.asin, []).get(item.asin)!).push(item);
      }
      if (item.sku) {
        createdListingsMap.set(`sku:${item.sku}`, pickNewestListingForMetadata(createdListingsMap.get(`sku:${item.sku}`), item));
        (createdListingCostRowsBySku.get(item.sku) || createdListingCostRowsBySku.set(item.sku, []).get(item.sku)!).push(item);
      }
    }

    const createdListingIds = [...createdListingById.keys()];
    for (let i = 0; i < createdListingIds.length; i += 100) {
      const batch = createdListingIds.slice(i, i + 100);
      const { data: purchaseRows } = await supabase
        .from('created_listing_purchases')
        .select('id, listing_id, unit_cost, purchase_date, created_at')
        .eq('user_id', user.id)
        .in('listing_id', batch)
        .gt('unit_cost', 0);
      for (const p of purchaseRows || []) {
        const listing = createdListingById.get(String(p.listing_id));
        if (!listing) continue;
        const enriched = { ...p, asin: listing.asin, sku: listing.sku };
        if (listing.asin) (purchaseCostRowsByAsin.get(listing.asin) || purchaseCostRowsByAsin.set(listing.asin, []).get(listing.asin)!).push(enriched);
        if (listing.sku) (purchaseCostRowsBySku.get(listing.sku) || purchaseCostRowsBySku.set(listing.sku, []).get(listing.sku)!).push(enriched);
      }
    }

    // cost_history (immutable ledger) by ASIN and SKU — preferred over listings/purchases
    const costHistoryByAsin = new Map<string, any[]>();
    const costHistoryBySku = new Map<string, any[]>();
    {
      const { data: chRows } = await supabase
        .from('cost_history')
        .select('id, asin, sku, cost, effective_date, recorded_at')
        .eq('user_id', user.id);
      for (const r of chRows || []) {
        if (r.asin) (costHistoryByAsin.get(r.asin) || costHistoryByAsin.set(r.asin, []).get(r.asin)!).push(r);
        if (r.sku) (costHistoryBySku.get(r.sku) || costHistoryBySku.set(r.sku, []).get(r.sku)!).push(r);
      }
    }

    for (const item of inventoryData || []) {
      inventoryMap.set(item.asin, item);
      if (item.sku) inventoryMap.set(`sku:${item.sku}`, item);
    }

    const resolveHistoricalUnitCost = (asin: string | null, sku: string | null, orderDate: string | null): CostResolution => {
      const skuCost = sku ? pickHistoricalCostForCost(purchaseCostRowsBySku.get(sku), createdListingCostRowsBySku.get(sku), costHistoryBySku.get(sku), orderDate) : { unitCost: null, source: null };
      if (skuCost.unitCost !== null && skuCost.unitCost > 0) return { unitCost: skuCost.unitCost, source: `${skuCost.source}:sku` };

      const asinCost = isValidAsinForCost(asin) ? pickHistoricalCostForCost(purchaseCostRowsByAsin.get(asin), createdListingCostRowsByAsin.get(asin), costHistoryByAsin.get(asin), orderDate) : { unitCost: null, source: null };
      if (asinCost.unitCost !== null && asinCost.unitCost > 0) return { unitCost: asinCost.unitCost, source: `${asinCost.source}:asin` };

      const invItem = sku ? inventoryMap.get(`sku:${sku}`) : null;
      const invAsinFallback = !invItem && isValidAsinForCost(asin) ? inventoryMap.get(asin) : null;
      const effectiveInvItem = invItem || invAsinFallback;
      if (effectiveInvItem) {
        const invUnit = getInventoryUnitCost({ cost: effectiveInvItem.cost, amount: effectiveInvItem.amount, units: effectiveInvItem.units });
        if (invUnit !== null && invUnit > 0) return { unitCost: invUnit, source: invItem ? 'fallback_current_inventory:sku' : 'fallback_current_inventory:asin' };
      }

      return { unitCost: null, source: null };
    };

    // Fetch items for orders needing enrichment
    const orderItemsMap = new Map<string, any[]>();
    let rateLimitHits = 0;
    const rateLimitedOrderIds: string[] = []; // Track orders that hit rate limits (leave as $0 until next sync)
    
    for (const orderId of ordersToEnrich) {
      // If we start hitting rate limits, stop immediately and leave remaining orders as "needs price".
      if (rateLimitHits >= 2) {
        console.log(`[LIVE_ORDERS] Too many rate limits, stopping item fetches - leaving remaining orders with $0 (needs enrichment)`);
        const remainingOrders = ordersToEnrich.slice(ordersToEnrich.indexOf(orderId));
        rateLimitedOrderIds.push(...remainingOrders);
        break;
      }
      
      try {
        // Order Items API: shared budget with sync-sales-orders so both don't collide.
        await waitForApiToken(supabase, 'order_items_api');
        const itemsUrl = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}/orderItems`;
        const headers = await signRequest('GET', itemsUrl, '', accessToken);
        const response = await fetch(itemsUrl, { method: 'GET', headers });
        
        if (response.status === 429) {
          rateLimitHits++;
          console.warn(`[LIVE_ORDERS] Rate limited on ${orderId} - leaving as $0 (needs enrichment)`);
          rateLimitedOrderIds.push(orderId);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        
        if (response.ok) {
          const data = await response.json();
          const items = data?.payload?.OrderItems || [];
          orderItemsMap.set(orderId, items);
          console.log(`[LIVE_ORDERS] Fetched ${items.length} items for order ${orderId}`);
        } else {
          // Non-OK response: don't guess pricing; mark for enrichment later.
          rateLimitedOrderIds.push(orderId);
        }
        
        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (err) {
        console.warn(`[LIVE_ORDERS] Failed to fetch items for ${orderId} - leaving as $0 (needs enrichment)`);
        rateLimitedOrderIds.push(orderId);
      }
    }
    
    // For rate-limited/failed item fetches, log them and leave as $0.
    console.log(`[LIVE_ORDERS] ${rateLimitedOrderIds.length} orders could not be enriched (rate limit/failed) - leaving as $0 until next sync`);
    for (const orderId of rateLimitedOrderIds) {
      console.log(`[LIVE_ORDERS] Order ${orderId} needs enrichment later`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4.5: REFRESH PRICES FROM LISTINGS API FOR NEW ORDERS
    // This ensures we use LIVE Amazon prices for estimates, not stale DB values.
    // CRITICAL FIX: Now fetches from the ORDER'S MARKETPLACE, not just US!
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Marketplace ID to currency mapping for conversion
    const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
      'ATVPDKIKX0DER': 'USD',  // US
      'A2EUQ1WTGCTBG2': 'CAD', // CA
      'A1AM78C64UM0Y8': 'MXN', // MX
      'A2Q3Y263D00KWC': 'BRL', // BR
    };
    
    if (sellerId && newOrderIds.length > 0) {
      // Collect unique SKUs from new orders WITH their marketplace context
      // Key: SKU, Value: { marketplaceId, orderId }
      const skusToRefresh = new Map<string, { marketplaceId: string; orderId: string }>();
      
      for (const orderId of newOrderIds) {
        const order = amazonOrders.find(o => o.AmazonOrderId === orderId);
        const orderMarketplaceId = order?.MarketplaceId || primaryMarketplaceId;
        
        const items = orderItemsMap.get(orderId) || [];
        for (const item of items) {
          const sku = item.SellerSKU;
          if (sku && !skusToRefresh.has(sku)) {
            skusToRefresh.set(sku, { marketplaceId: orderMarketplaceId, orderId });
          }
        }
      }
      
      if (skusToRefresh.size > 0) {
        console.log(`[LIVE_ORDERS] 🔄 Refreshing prices from Listings API for ${skusToRefresh.size} SKUs in new orders (marketplace-aware)`);
        
        // Helper to call Listings API for fresh price WITH marketplace support
        const fetchFreshListingPrice = async (
          sku: string, 
          marketplaceId: string
        ): Promise<{ priceUsd: number | null; priceLocal: number | null; currency: string; error?: string }> => {
          const currency = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
          const fxRate = fxRates[currency] || 1;
          
          try {
            const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
            // CRITICAL: Use the order's marketplace, not hardcoded US!
            const url = `https://sellingpartnerapi-na.amazon.com${path}?marketplaceIds=${marketplaceId}&includedData=offers,summaries`;
            
            console.log(`[LIVE_ORDERS] 🌎 Fetching SKU ${sku} from marketplace ${marketplaceId} (${currency})`);
            
            const headers = await signRequest('GET', url, '', accessToken);
            const response = await fetch(url, { method: 'GET', headers });
            
            if (response.status === 429) {
              return { priceUsd: null, priceLocal: null, currency, error: 'rate_limit' };
            }
            if (response.status === 403) {
              return { priceUsd: null, priceLocal: null, currency, error: 'authorization_required' };
            }
            if (!response.ok) {
              return { priceUsd: null, priceLocal: null, currency, error: `API ${response.status}` };
            }
            
            const data = await response.json();
            let priceLocal: number | null = null;
            
            // Extract price from offers (same logic as backfill-my-price-cache)
            if (data.offers && Array.isArray(data.offers)) {
              for (const offer of data.offers) {
                const rawAmount = 
                  offer.price?.amount ||
                  offer.price?.listingPrice?.amount ||
                  offer.listingPrice?.amount ||
                  offer.ourPrice?.amount;
                const priceValue = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
                if (priceValue && typeof priceValue === 'number' && !isNaN(priceValue) && priceValue > 0) {
                  priceLocal = priceValue;
                  break;
                }
              }
            }
            
            // Fallback: check summaries
            if (!priceLocal && data.summaries && Array.isArray(data.summaries)) {
              for (const summary of data.summaries) {
                const priceValue = summary.price?.listingPrice?.amount || summary.price?.amount;
                if (priceValue && typeof priceValue === 'number' && priceValue > 0) {
                  priceLocal = priceValue;
                  break;
                }
              }
            }
            
            // Fallback: check attributes
            if (!priceLocal && data.attributes?.purchasable_offer) {
              const purchasableOffer = data.attributes.purchasable_offer;
              if (Array.isArray(purchasableOffer)) {
                for (const po of purchasableOffer) {
                  const ourPrice = po.our_price?.[0]?.schedule?.[0]?.value_with_tax;
                  if (ourPrice && typeof ourPrice === 'number' && ourPrice > 0) {
                    priceLocal = ourPrice;
                    break;
                  }
                }
              }
            }
            
            if (priceLocal === null) {
              return { priceUsd: null, priceLocal: null, currency, error: 'no_price_found' };
            }
            
            // CRITICAL: Convert local currency to USD!
            const priceUsd = currency === 'USD' ? priceLocal : priceLocal / fxRate;
            
            console.log(`[LIVE_ORDERS] 💱 SKU ${sku}: ${currency} ${priceLocal.toFixed(2)} → USD ${priceUsd.toFixed(2)} (rate: ${fxRate})`);
            
            return { priceUsd, priceLocal, currency };
          } catch (err) {
            return { priceUsd: null, priceLocal: null, currency, error: String(err) };
          }
        };
        
        // Refresh prices in batches with rate limiting
        let refreshed = 0;
        let skipped = 0;
        const skuArray = Array.from(skusToRefresh.entries());
        
        for (let i = 0; i < skuArray.length && i < 20; i++) { // Limit to 20 to avoid timeout
          const [sku, { marketplaceId }] = skuArray[i];
          const result = await fetchFreshListingPrice(sku, marketplaceId);
          
          if (result.priceUsd !== null && result.priceUsd > 0) {
            // Update inventoryMap with fresh USD price
            const existingItem = inventoryMap.get(`sku:${sku}`);
            if (existingItem) {
              const oldPrice = existingItem.price;
              existingItem.price = result.priceUsd;
              inventoryMap.set(`sku:${sku}`, existingItem);
              console.log(`[LIVE_ORDERS] ✅ Refreshed SKU ${sku}: $${oldPrice || 0} → $${result.priceUsd.toFixed(2)} (from ${result.currency})`);
            } else {
              // Create a minimal entry
              inventoryMap.set(`sku:${sku}`, { sku, price: result.priceUsd, my_price: result.priceUsd });
              console.log(`[LIVE_ORDERS] ✅ Added fresh price for SKU ${sku}: $${result.priceUsd.toFixed(2)} (from ${result.currency})`);
            }
            
            // Also update the database for persistence (store USD price)
            await supabase
              .from('inventory')
              .update({ 
                price: result.priceUsd, 
                my_price: result.priceUsd,
                updated_at: new Date().toISOString() 
              })
              .eq('user_id', user.id)
              .eq('sku', sku);
            
            refreshed++;
          } else {
            if (result.error === 'authorization_required') {
              console.warn(`[LIVE_ORDERS] ⚠️ Listings API requires Product Listing role - skipping price refresh`);
              break; // Stop trying if we don't have permission
            }
            if (result.error === 'rate_limit') {
              console.warn(`[LIVE_ORDERS] ⚠️ Listings API rate limited - stopping refresh`);
              break;
            }
            console.log(`[LIVE_ORDERS] ⚠️ SKU ${sku}: ${result.error || 'no price found'}`);
            skipped++;
          }
          
          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        console.log(`[LIVE_ORDERS] 🔄 Price refresh complete: ${refreshed} refreshed, ${skipped} skipped`);
      }
    }
    
    // Currency and marketplace detection helpers
    // REMOVED HARDCODED RATES - using fxRates from database instead
    const CURRENCY_TO_MARKETPLACE: Record<string, string> = { 'USD': 'US', 'MXN': 'MX', 'CAD': 'CA', 'BRL': 'BR' };
    const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
      'ATVPDKIKX0DER': 'US',
      'A2EUQ1WTGCTBG2': 'CA',
      'A1AM78C64UM0Y8': 'MX',
      'A2Q3Y263D00KWC': 'BR',
    };
    const SALES_MARKETPLACES = new Set(['US', 'CA', 'MX', 'BR']);
    const isValidSalesAsin = (asin: unknown): asin is string =>
      typeof asin === 'string' && !!asin.trim() && !['PENDING', 'UNKNOWN'].includes(asin.trim().toUpperCase());

    const ensureRepricerAssignmentFromSale = async (
      asin: string,
      sku: string | null | undefined,
      marketplace: string,
      fulfillmentType: string = 'FBA'
    ): Promise<void> => {
      const mkt = String(marketplace || 'US').toUpperCase();
      const cleanSku = typeof sku === 'string' ? sku.trim() : '';
      if (!SALES_MARKETPLACES.has(mkt) || !isValidSalesAsin(asin) || !cleanSku) return;

      const { data: existingBySku } = await supabase
        .from('repricer_assignments')
        .select('id, rule_id')
        .eq('user_id', user.id)
        .eq('marketplace', mkt)
        .eq('sku', cleanSku)
        .limit(1)
        .maybeSingle();
      const existing = existingBySku;

      const { data: sourceBySku } = await supabase
        .from('repricer_assignments')
        .select('rule_id, is_enabled, min_price_override, max_price_override, min_roi_override, fulfillment_type, item_condition, status')
        .eq('user_id', user.id)
        .eq('sku', cleanSku)
        .not('rule_id', 'is', null)
        .order('marketplace', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: sourceByAsin } = sourceBySku?.rule_id ? { data: null } : await supabase
        .from('repricer_assignments')
        .select('rule_id, is_enabled, min_price_override, max_price_override, min_roi_override, fulfillment_type, item_condition, status')
        .eq('user_id', user.id)
        .eq('asin', asin)
        .not('rule_id', 'is', null)
        .order('marketplace', { ascending: false })
        .limit(1)
        .maybeSingle();
      const sourceAssignment = sourceBySku || sourceByAsin;

      let ruleId = sourceAssignment?.rule_id || null;
      if (!ruleId) {
        const { data: rule } = await supabase
          .from('repricer_rules')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_enabled', true)
          .contains('marketplaces', [mkt])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        ruleId = rule?.id || null;
      }

      if (!ruleId) {
        console.warn(`[LIVE_ORDERS] ⚠️ SALES_REPRICER_ASSIGNMENT_SKIPPED_NO_RULE: ${asin}/${cleanSku} ${mkt}`);
        return;
      }

      if (existing?.id) {
        if (!existing.rule_id || mkt !== 'US') {
          const repairData: any = { rule_id: existing.rule_id || ruleId, status: sourceAssignment?.status || 'active', updated_at: new Date().toISOString() };
          if (mkt !== 'US') {
            repairData.intl_listing_status = '["BUYABLE"]';
            repairData.marketplace_sellable = true;
            repairData.marketplace_sellability_reason = 'sales_order_observed';
            repairData.marketplace_checked_at = new Date().toISOString();
          }
          await supabase.from('repricer_assignments').update(repairData).eq('id', existing.id);
        }
        return;
      }

      const insertData: any = {
        user_id: user.id,
        asin,
        sku: cleanSku,
        marketplace: mkt,
        rule_id: ruleId,
        is_enabled: sourceAssignment?.is_enabled ?? true,
        min_price_override: sourceAssignment?.min_price_override ?? null,
        max_price_override: sourceAssignment?.max_price_override ?? null,
        min_roi_override: sourceAssignment?.min_roi_override ?? null,
        fulfillment_type: sourceAssignment?.fulfillment_type || fulfillmentType || 'FBA',
        item_condition: sourceAssignment?.item_condition || 'New',
        status: sourceAssignment?.status || 'active',
        updated_at: new Date().toISOString(),
      };
      if (mkt !== 'US') {
        insertData.intl_listing_status = '["BUYABLE"]';
        insertData.marketplace_sellable = true;
        insertData.marketplace_sellability_reason = 'sales_order_observed';
        insertData.marketplace_checked_at = new Date().toISOString();
      }
      const { error } = await supabase.from('repricer_assignments').insert(insertData);
      if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
        console.error(`[LIVE_ORDERS] ❌ SALES_REPRICER_ASSIGNMENT_ERROR: ${asin}/${cleanSku} ${mkt}`, error.message);
      } else if (!error) {
        console.log(`[LIVE_ORDERS] ✅ SALES_REPRICER_ASSIGNMENT_CREATED: ${asin}/${cleanSku} ${mkt} rule=${ruleId}`);
      }
    };
    
    // Helper to detect marketplace.
    // IMPORTANT: Marketplace (CA/MX/BR) does NOT always imply the order is charged in that currency.
    // Use MarketplaceId/SalesChannel for marketplace, but use CurrencyCode for conversion.
    // NOW USES fxRates from database (dynamic, not hardcoded)
    const detectMarketplace = (order: any): { marketplace: string; currencyRate: number } => {
      // 1) Marketplace (where the order was placed)
      let marketplace: string | undefined;

      if (order?.MarketplaceId && MARKETPLACE_ID_TO_CODE[order.MarketplaceId]) {
        marketplace = MARKETPLACE_ID_TO_CODE[order.MarketplaceId];
      }

      if (!marketplace) {
        const salesChannel = order?.SalesChannel || '';
        if (salesChannel.includes('.ca')) marketplace = 'CA';
        else if (salesChannel.includes('.com.mx')) marketplace = 'MX';
        else if (salesChannel.includes('.com.br')) marketplace = 'BR';
        else if (salesChannel.includes('.com')) marketplace = 'US';
      }

      // 2) Currency conversion using DYNAMIC fx_rates (not hardcoded!)
      // fx_rates stores: 1 USD = X foreign currency
      // So currencyRate = 1/rate to convert foreign to USD
      const currencyCode = order?.OrderTotal?.CurrencyCode || 'USD';
      let currencyRate = 1;
      if (currencyCode !== 'USD' && fxRates[currencyCode]) {
        currencyRate = 1 / fxRates[currencyCode]; // CORRECT: divide to convert to USD
      }

      return { marketplace: marketplace || (CURRENCY_TO_MARKETPLACE[currencyCode] || 'US'), currencyRate };
    };
    
    // STEP 4.6: We do NOT backfill sold_price from OrderTotal.
    // OrderTotal is an aggregate and can be wrong at item-level (currency/tax/shipping issues).
    // If we couldn't get OrderItems, we leave sold_price as $0 so the UI shows "Pending (needs price)".
    // (The next sync will enrich when rate limits reset.)

    // Fix orders that were previously stored with the wrong local date (timezone drift around midnight).
    // Example: user is America/Chicago but we previously stored Pacific, pushing early-morning orders into "yesterday".
    for (const amazonOrder of amazonOrders) {
      const orderId = amazonOrder?.AmazonOrderId;
      if (!orderId) continue;

      const purchaseDate = amazonOrder?.PurchaseDate || amazonOrder?.LastUpdateDate;
      if (!purchaseDate) continue;

      const correctLocalDate = getCutoffDateStringInTimeZone(purchaseDate, userTimezone);

      // Update any rows for this order that have a different date.
      const { error: tzFixError } = await supabase
        .from('sales_orders')
        .update({ order_date: correctLocalDate, purchase_timestamp_utc: purchaseDate || undefined, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('order_id', orderId)
        .neq('order_date', correctLocalDate);

      if (tzFixError) {
        console.warn('[LIVE_ORDERS] timezone date fix failed', { orderId, tzFixError: tzFixError.message });
      }
    }

    const isReplacementOrderType = (t?: string | null) => (t || '').toLowerCase().includes('replacement');

    // If an order already exists in our DB but Amazon says it's a replacement,
    // OR if the order has $0 OrderTotal (hidden replacement), force it into Replacement mode.
    for (const amazonOrder of amazonOrders) {
      const orderId = amazonOrder?.AmazonOrderId;
      if (!orderId) continue;
      
      const isExplicitReplacement = isReplacementOrderType(amazonOrder?.OrderType);
      // NEW: Amazon also exposes IsReplacementOrder (bool) + ReplacedOrderId (string)
      // on the Order object. This flag is set on the parent-link as soon as the order
      // is discovered — including while OrderStatus='Pending' and OrderType='StandardOrder'.
      // Using it lets us flag replacements immediately instead of waiting for the order
      // to leave Pending (where the $0-OrderTotal branch would otherwise catch it).
      const isReplacementFlag = amazonOrder?.IsReplacementOrder === true
        || amazonOrder?.IsReplacementOrder === 'true'
        || String(amazonOrder?.IsReplacementOrder || '').toLowerCase() === 'true';
      const replacedOrderId = amazonOrder?.ReplacedOrderId || null;
      const orderTotal = parseFloat(amazonOrder?.OrderTotal?.Amount || '0');
      const orderStatus = amazonOrder?.OrderStatus || '';
      // Hidden replacement: non-Pending order with $0 total, or any order Amazon flags as replacement
      const isHiddenReplacement = !isExplicitReplacement && !isReplacementFlag && orderTotal === 0 && orderStatus !== 'Pending' && orderStatus !== 'Canceled';
      
      if (!isExplicitReplacement && !isReplacementFlag && !isHiddenReplacement) continue;

      const detectionSource = isExplicitReplacement
        ? 'orders_api_replacement'
        : isReplacementFlag
          ? 'orders_api_is_replacement_flag'
          : 'fec_zero_principal_shipped';

      console.log(`[LIVE_ORDERS] 🔧 Converting existing order ${orderId} to Replacement (source=${detectionSource}, status=${orderStatus}, replacedOrderId=${replacedOrderId || 'n/a'})`);

      const { data: rows } = await supabase
        .from('sales_orders')
        .select('id, asin, fba_fee, shipping_label_fee, order_type, sold_price, quantity, unit_cost')
        .eq('user_id', user.id)
        .eq('order_id', orderId);

      for (const row of rows || []) {
        // Skip if already marked as Replacement
        if ((row.order_type || '').toLowerCase().includes('replacement')) continue;
        
        const fbaFee = Number(row.fba_fee || 0);
        const shippingLabelFee = Number(row.shipping_label_fee || 0);
        const totalFees = Math.round((fbaFee + shippingLabelFee) * 100) / 100;

        await supabase
          .from('sales_orders')
          .update({
            order_type: 'Replacement',
            is_replacement: true,
            replacement_reason: detectionSource,
            related_order_id: replacedOrderId,
            sold_price: 0,
            item_price: 0,
            shipping_price: 0,
            total_sale_amount: 0,
            referral_fee: 0,
            closing_fee: 0,
            total_fees: totalFees,
            price_source: 'replacement_detected',
            price_confidence: 'REPLACEMENT_ZERO_REVENUE',
            needs_price_enrich: false,
            needs_fee_enrich: false,
            price_enrich_status: 'enriched',
          })
          .eq('id', row.id);

        // Audit log
        try {
          await supabase.from('replacement_detection_audit').insert({
            user_id: userId,
            order_id: orderId,
            asin: (row as any).asin || null,
            detection_source: detectionSource,
            prior_is_replacement: false,
            prior_sold_price: (row as any).sold_price ?? null,
            quantity: (row as any).quantity ?? null,
            unit_cost: (row as any).unit_cost ?? null,
            cogs_impact:
              Number((row as any).unit_cost || 0) * Number((row as any).quantity || 0) || null,
            details: { order_status: orderStatus, order_total: orderTotal, replaced_order_id: replacedOrderId },
          });
        } catch (_) { /* non-fatal */ }
        
        console.log(`[LIVE_ORDERS] ✅ Order ${orderId} row ${row.id} converted to Replacement`);
      }
    }

    // Classifier pass DISABLED — over-fired on Pending $0 orders and inflated
    // Replacement/Free-shipment COGS. Only Amazon's native IsReplacementOrder
    // flag (handled above) and Shipped-$0 heuristic are trusted.
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000; // retained for other callers


    // STEP 5: Insert/update new orders to database (so they're cached for next time)
    const ordersToUpsert: any[] = [];
    
    for (const orderId of newOrderIds) {
      const amazonOrder = amazonOrders.find(o => o.AmazonOrderId === orderId);
      const items = orderItemsMap.get(orderId) || [];
      const purchaseDate = amazonOrder?.PurchaseDate || amazonOrder?.LastUpdateDate;
      const orderDate = purchaseDate ? getCutoffDateStringInTimeZone(purchaseDate, userTimezone) : queryStartDate;
      const orderStatus = amazonOrder?.OrderStatus || 'Pending';
      const orderTypeRaw = amazonOrder?.OrderType || 'StandardOrder';
      let isReplacement = (orderTypeRaw || '').toLowerCase().includes('replacement');

      // PRIMARY REPLACEMENT FLAG: Amazon Orders API IsReplacementOrder (+ ReplacedOrderId).
      // This is set as soon as the order is discovered — including while it is still
      // Pending with OrderType='StandardOrder'. Honor it immediately so the Replacement /
      // Free Shipping tile deducts the COGS hit without waiting for status to leave Pending.
      const isReplacementFlag = amazonOrder?.IsReplacementOrder === true
        || amazonOrder?.IsReplacementOrder === 'true'
        || String(amazonOrder?.IsReplacementOrder || '').toLowerCase() === 'true';
      const replacedOrderId = amazonOrder?.ReplacedOrderId || null;
      if (!isReplacement && isReplacementFlag) {
        isReplacement = true;
        console.log(`[LIVE_ORDERS] 🔧 DETECTED replacement via IsReplacementOrder flag: ${orderId} (status=${orderStatus}, replacedOrderId=${replacedOrderId || 'n/a'})`);
      }

      // SECONDARY REPLACEMENT DETECTION: Amazon sometimes returns replacement orders
      // as "StandardOrder" with $0 order total. If a Shipped order has $0 total, it's a replacement.
      const orderTotalAmount = parseFloat(amazonOrder?.OrderTotal?.Amount || '0');
      const isShippedWithZeroTotal = (orderStatus === 'Shipped' || orderStatus === 'Unshipped') && orderTotalAmount === 0;
      if (!isReplacement && isShippedWithZeroTotal) {
        isReplacement = true;
        console.log(`[LIVE_ORDERS] 🔧 DETECTED hidden replacement: Order ${orderId} is ${orderStatus} with $0 total (Amazon reported as ${orderTypeRaw})`);
      }

      // TERTIARY CLASSIFIER DISABLED — over-fired on Pending $0 orders and wiped real profit.
      // Only Amazon's native IsReplacementOrder flag + Shipped-$0 heuristic are trusted.
      const fulfillmentChannelRaw = amazonOrder?.FulfillmentChannel || 'AFN';
      const zeroPrincipalAfnClassifierHit = false;

      const orderType = isReplacement ? 'Replacement' : orderTypeRaw;
      
      // Detect FBA vs FBM: AFN = Amazon Fulfilled Network (FBA), MFN = Merchant Fulfilled Network (FBM)
      const fulfillmentChannel = amazonOrder?.FulfillmentChannel || 'AFN';
      const isFbmOrder = fulfillmentChannel === 'MFN';
      if (isFbmOrder) {
        console.log(`[LIVE_ORDERS] 📦 FBM order detected: ${orderId} (FulfillmentChannel=${fulfillmentChannel})`);
      }

      if (isReplacement) {
        console.log(`[LIVE_ORDERS] 🔄 Processing REPLACEMENT order ${orderId} (tracking cost loss)`);
      }
      
      // Detect marketplace using improved logic
      const { marketplace, currencyRate } = detectMarketplace(amazonOrder);

      if (isDebugOrder(orderId)) {
        console.log('[LIVE_ORDERS][DEBUG_ORDER] Order header', {
          orderId,
          orderType,
          marketplace,
          currencyRate,
          marketplaceId: amazonOrder?.MarketplaceId,
          salesChannel: amazonOrder?.SalesChannel,
          orderTotal: amazonOrder?.OrderTotal,
          purchaseDate: amazonOrder?.PurchaseDate,
          lastUpdateDate: amazonOrder?.LastUpdateDate,
        });
      }

      console.log(`[LIVE_ORDERS] Order ${orderId}: type=${orderType}, marketplace=${marketplace}, rate=${currencyRate}, currency=${amazonOrder?.OrderTotal?.CurrencyCode || 'N/A'}, SalesChannel=${amazonOrder?.SalesChannel || 'N/A'}`);
      
      // MULTI-ITEM ORDER DETECTION: If order has multiple items, OrderTotal/qty is unsafe
      const isMultiItemOrder = items.length > 1 || items.reduce((sum: number, i: any) => sum + parseInt(i.QuantityOrdered || '1', 10), 0) > 1;
      
      if (items.length === 0) {
        // No items yet - DO NOT persist to database with asin='PENDING' (causes duplicates)
        // Instead, just log and skip - this order will be fetched again on next sync
        const orderTotalRaw = parseFloat(amazonOrder?.OrderTotal?.Amount || '0');
        const orderTotalCurrency = amazonOrder?.OrderTotal?.CurrencyCode || 'USD';
        // Use dynamic fxRates: divide by rate to convert foreign to USD
        const orderTotalUSD = orderTotalCurrency !== 'USD' && fxRates[orderTotalCurrency]
          ? orderTotalRaw / fxRates[orderTotalCurrency]
          : orderTotalRaw;
        
        if (orderTotalUSD > 0) {
          console.log(`[LIVE_ORDERS] ⏳ Order ${orderId}: No items yet, OrderTotal=$${orderTotalUSD.toFixed(2)} - NOT saving (will retry next sync)`);
        } else {
          console.log(`[LIVE_ORDERS] ⏳ Order ${orderId}: No items and no OrderTotal - NOT saving (will retry next sync)`);
        }
        // Skip adding to ordersToUpsert - don't persist until we have real item data
        continue;
      } else {
        // Insert each item
        for (const item of items) {
          const asin = item.ASIN || 'UNKNOWN';
          const sku = item.SellerSKU || null;
          const quantity = parseInt(item.QuantityOrdered || '1', 10);
          let totalSaleAmount = 0;
          let soldPrice = 0;
          let itemPrice = 0; // Pure item price without shipping
          let shippingPriceComponent = 0; // Shipping component (kept separate)
          
          // Get currency from item; if missing, fall back to order-level currency; otherwise assume USD
          const itemCurrency =
            item.ItemPrice?.CurrencyCode || amazonOrder?.OrderTotal?.CurrencyCode || 'USD';
          // Use dynamic fxRates: 1/rate to convert foreign to USD
          const itemRate = itemCurrency !== 'USD' && fxRates[itemCurrency] ? 1 / fxRates[itemCurrency] : currencyRate;

          if (isDebugOrder(orderId)) {
            console.log('[LIVE_ORDERS][DEBUG_ORDER] Item price inputs', {
              orderId,
              asin,
              quantity,
              itemPrice: item.ItemPrice,
              orderTotal: amazonOrder?.OrderTotal,
              itemCurrency,
              itemRate,
              orderCurrencyRate: currencyRate,
            });
          }

          // SEPARATE item_price from shipping_price (for clean ROI calculation)
          const itemPriceRaw = parseFloat(item.ItemPrice?.Amount || '0') || 0;
          const shippingPriceRaw = parseFloat(item.ShippingPrice?.Amount || '0') || 0;
          const rawTotal = itemPriceRaw + shippingPriceRaw;
          
          // IMPORTANT: Amazon's GetOrderItems does NOT return pricing data when order is "Pending" status.
          // Only accept prices when order has transitioned to Unshipped/Shipped (payment authorized).
          // This prevents us from saving $0 or wrong prices.
          const isPendingStatus = orderStatus === 'Pending';
          
          // Track price_source and price_calc_mode for this order
          let priceSource: string | null = null;
          let priceCalcMode: string = 'unknown';
          let roiSource: string = 'unknown';
          // NEW: Store estimated price separately - NEVER lock pending estimates into sold_price/item_price
          let estimatedPrice: number | null = null;
          // CONFIDENCE TIER: 'CONFIRMED' | 'HIGH_CONFIDENCE_PENDING' | 'LOW_CONFIDENCE_HINT'
          // Live Sales (strict mode) accepts only CONFIRMED + HIGH_CONFIDENCE_PENDING.
          let priceConfidence: string | null = null;
          
          if (isPendingStatus && rawTotal === 0) {
            // Order is Pending and no ItemPrice available from Amazon
            // FIX: Write estimates to estimated_price, NOT to sold_price/item_price
            // This allows prices to update when inventory changes
            //
            // === SELLER-DERIVED RESOLVER (HIGH CONFIDENCE) ===
            // Try YOUR own pricing history before any market/Keepa estimate.
            // All sources must be timestamped <= purchaseDate so post-sale repricer
            // moves can never pollute the estimate.
            const purchaseTs = amazonOrder?.PurchaseDate || new Date().toISOString();
            try {
              // ──────────────────────────────────────────────────────────────
              // Tier A (PRIMARY): latest successful repricer applied price
              // ≤ purchaseDate. This is the EXACT price Amazon had live at
              // the moment of purchase, regardless of how many times the
              // repricer has bounced since. MUST run BEFORE the live
              // Listings API call — Listings API returns "price now", which
              // for an oscillating ASIN can differ from the price at
              // purchase (per the time-direction contract: every fallback
              // query uses ≤ purchaseDate).
              // ──────────────────────────────────────────────────────────────
              if (asin && asin !== 'UNKNOWN' && asin !== 'PENDING') {
                const { data: rpaRow } = await supabase
                  .from('repricer_price_actions')
                  .select('new_price, amazon_accepted_price, created_at')
                  .eq('user_id', user.id)
                  .eq('asin', asin)
                  .eq('marketplace', marketplace || 'US')
                  .eq('success', true)
                  .lte('created_at', purchaseTs)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .maybeSingle();
                const rpaPrice = Number(rpaRow?.amazon_accepted_price || rpaRow?.new_price || 0);
                if (rpaPrice > 0) {
                  // repricer_price_actions stores native marketplace price.
                  estimatedPrice = rpaPrice;
                  priceSource = 'seller_derived:repricer_action';
                  priceCalcMode = 'seller_derived_repricer';
                  roiSource = 'estimated';
                  priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                  console.log(`[LIVE_ORDERS] 🟢 SELLER-DERIVED repricer (PRIMARY) for ${orderId}/${asin} ${marketplace || 'US'} (set ${rpaRow?.created_at}, purchase ${purchaseTs}): ${rpaPrice.toFixed(2)}`);
                }
              }

              // Tier B: order_price_snapshots (frozen at order discovery).
              if (!estimatedPrice) {
                const { data: snapRow } = await supabase
                  .from('order_price_snapshots')
                  .select('snapshot_item_price, snapshot_source, currency_code, currency')
                  .eq('user_id', user.id)
                  .eq('order_id', orderId)
                  .eq('asin', asin)
                  .gt('snapshot_item_price', 0)
                  .order('captured_at', { ascending: false })
                  .limit(1)
                  .maybeSingle();
                if (snapRow?.snapshot_item_price && Number(snapRow.snapshot_item_price) > 0) {
                  const snapRawPrice = Number(snapRow.snapshot_item_price);
                  // CONTRACT: estimated_price is NATIVE marketplace currency for
                  // non-US. Inventory-sourced snapshots are always USD — convert
                  // before use (read side of SNAPSHOT_CAPTURE_CURRENCY_FIX).
                  const snapMpToCurrency: Record<string, string> = { 'US': 'USD', 'CA': 'CAD', 'MX': 'MXN', 'BR': 'BRL' };
                  const snapNativeCurrency = snapMpToCurrency[marketplace || 'US'] || 'USD';
                  const snapCurrency = snapRow.currency_code || snapRow.currency ||
                    (snapRow.snapshot_source === 'pricing_api' || snapRow.snapshot_source === 'orders_api' ? snapNativeCurrency : 'USD');
                  estimatedPrice = snapCurrency === 'USD' && snapNativeCurrency !== 'USD' && fxRates?.[snapNativeCurrency]
                    ? snapRawPrice * fxRates[snapNativeCurrency]
                    : snapRawPrice;
                  priceSource = 'seller_derived:snapshot';
                  priceCalcMode = 'seller_derived_snapshot';
                  roiSource = 'estimated';
                  priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                  console.log(`[LIVE_ORDERS] 🟢 SELLER-DERIVED snapshot for ${orderId}/${asin}: $${estimatedPrice.toFixed(2)}`);
                }
              }

              // Tier C (FALLBACK): Live SP-API Listings price — only when no
              // repricer action exists ≤ purchaseDate AND no snapshot exists.
              // Returns "price now", which may differ from price at purchase
              // for oscillating ASINs. Acceptable for ASINs the repricer
              // doesn't manage.
              if (!estimatedPrice && sku && sellerId && asin && asin !== 'UNKNOWN' && asin !== 'PENDING') {
                const mp0 = marketplace || 'US';
                const mpId0 = mp0 === 'MX' ? 'A1AM78C64UM0Y8'
                            : mp0 === 'CA' ? 'A2EUQ1WTGCTBG2'
                            : mp0 === 'BR' ? 'A2Q3Y263D00KWC'
                            : 'ATVPDKIKX0DER';
                try {
                  const live0 = await getSellerListingPrice(sku, sellerId, mpId0, accessToken, fxRates);
                  if (live0.priceUsd && live0.priceUsd > 0) {
                    const isNonUs0 = mp0 !== 'US';
                    // CONTRACT: non-US stores NATIVE in estimated_price; US stores USD.
                    estimatedPrice = isNonUs0 ? (live0.localPrice ?? live0.priceUsd) : live0.priceUsd;
                    priceSource = `seller_derived:listings_api_${mp0.toLowerCase()}`;
                    priceCalcMode = 'listings_api';
                    roiSource = 'estimated';
                    priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                    console.log(`[LIVE_ORDERS] 🟡 SELLER-DERIVED Listings API (fallback, no repricer action ≤ purchase) for ${orderId}/${asin} ${mp0} SKU=${sku}: $${live0.priceUsd.toFixed(2)} USD${isNonUs0 ? ` (native ${live0.currency} ${live0.localPrice})` : ''}`);
                    await new Promise(r => setTimeout(r, 250));
                  }
                } catch (eT0) {
                  console.warn(`[LIVE_ORDERS] Listings API fallback failed for ${orderId}/${sku}: ${(eT0 as Error).message}`);
                }
              }

              // Tier C: most recent confirmed sold_price for same user+ASIN+marketplace, last 14d before purchase
              if (!estimatedPrice && asin && asin !== 'UNKNOWN' && asin !== 'PENDING') {
                const fourteenDaysBefore = new Date(new Date(purchaseTs).getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
                const { data: soRow } = await supabase
                  .from('sales_orders')
                  .select('sold_price, order_date')
                  .eq('user_id', user.id)
                  .eq('asin', asin)
                  .eq('marketplace', marketplace || 'US')
                  .gt('sold_price', 0)
                  .lte('order_date', purchaseTs)
                  .gte('order_date', fourteenDaysBefore)
                  .order('order_date', { ascending: false })
                  .limit(1)
                  .maybeSingle();
                if (soRow?.sold_price && Number(soRow.sold_price) > 0) {
                  estimatedPrice = Number(soRow.sold_price);
                  priceSource = 'seller_derived:recent_sale';
                  priceCalcMode = 'seller_derived_recent_sale';
                  roiSource = 'estimated';
                  priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                  console.log(`[LIVE_ORDERS] 🟢 SELLER-DERIVED recent sale for ${orderId}/${asin} (${soRow.order_date}): $${estimatedPrice.toFixed(2)}`);
                }
              }
            } catch (e) {
              console.warn(`[LIVE_ORDERS] Seller-derived resolver failed for ${orderId}/${asin}: ${(e as Error).message}`);
            }
            
            
            // NEW: For non-US marketplaces, use Listings API (SKU-based) to get SELLER'S OWN price
            // This is more accurate than Pricing API which returns competitor/buy box prices
            const isNonUsMarketplace = ['MX', 'CA', 'BR'].includes(marketplace);
            if (!estimatedPrice && isNonUsMarketplace && asin !== 'UNKNOWN' && asin !== 'PENDING') {
              const marketplaceIdForPricing = amazonOrder?.MarketplaceId || 
                (marketplace === 'MX' ? 'A1AM78C64UM0Y8' : marketplace === 'CA' ? 'A2EUQ1WTGCTBG2' : 'A2Q3Y263D00KWC');
              
              // PRIORITY 1: Use Listings API with SKU (returns YOUR price, not buy box) — SELLER-DERIVED
              if (sku && sellerId) {
                console.log(`[LIVE_ORDERS] 🌎 NON-US order ${orderId}: Using Listings API for ${marketplace} marketplace price (SKU: ${sku})`);
                
                const listingResult = await getSellerListingPrice(sku, sellerId, marketplaceIdForPricing, accessToken, fxRates);
                
                if (listingResult.priceUsd !== null && listingResult.priceUsd > 0) {
                  // CONTRACT: store NATIVE marketplace currency in estimated_price.
                  // Frontend converts to home currency at read time via shared helper.
                  estimatedPrice = listingResult.localPrice ?? listingResult.priceUsd;
                  priceSource = `seller_derived:listings_api_${marketplace.toLowerCase()}`;
                  priceCalcMode = 'listings_api';
                  roiSource = 'estimated';
                  priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                  console.log(`[LIVE_ORDERS] 🟢 LISTINGS API (seller-derived, NATIVE): Order ${orderId} item ${asin} SKU=${sku} - storing ${listingResult.currency} ${listingResult.localPrice?.toFixed(2)} (USD ref $${listingResult.priceUsd.toFixed(2)})`);
                  // Small delay for rate limiting
                  await new Promise(resolve => setTimeout(resolve, 300));
                } else {
                  console.log(`[LIVE_ORDERS] ⚠️ LISTINGS API returned no price for SKU ${sku} (${marketplace}) - trying Pricing API fallback`);
                }
              }
              
              // PRIORITY 2: Fallback to Pricing API (competitor BB) — LOW CONFIDENCE
              if (!estimatedPrice) {
                console.log(`[LIVE_ORDERS] 🌎 NON-US order ${orderId}: Fallback to Pricing API for ${marketplace} (no SKU or Listings API failed)`);
                
                const pricingResult = await getMarketplacePricingPrice(supabase, asin, marketplaceIdForPricing, accessToken, fxRates);
                
                if (pricingResult.priceUsd !== null && pricingResult.priceUsd > 0) {
                  // CONTRACT: store NATIVE marketplace currency.
                  estimatedPrice = pricingResult.localPrice ?? pricingResult.priceUsd;
                  priceSource = `hint:pricing_api_${marketplace.toLowerCase()}`;
                  priceCalcMode = 'pricing_api';
                  roiSource = 'estimated';
                  priceConfidence = 'LOW_CONFIDENCE_HINT';
                  console.log(`[LIVE_ORDERS] 🟡 PRICING API (low-confidence hint, NATIVE): Order ${orderId} item ${asin} - storing ${pricingResult.currency} ${pricingResult.localPrice} (USD ref $${pricingResult.priceUsd.toFixed(2)})`);
                  await new Promise(resolve => setTimeout(resolve, 300));
                } else {
                  console.log(`[LIVE_ORDERS] ⚠️ PRICING API returned no price for ${asin} (${marketplace}) - falling back to inventory`);
                }
              }
            }
            
            // If Pricing API didn't set a price (or this is a US order), use existing logic
            if (!estimatedPrice) {
            // FIX #1: For MULTI-ITEM orders, NEVER use OrderTotal/qty (produces garbage per-item prices)
            if (isMultiItemOrder) {
              console.log(`[LIVE_ORDERS] ⚠️ Order ${orderId} is MULTI-ITEM (${items.length} items) - estimating from inventory/buy_box`);
              // SKU-FIRST PRICING: Prioritize SKU lookup over ASIN for multi-offer ASINs
              const invItemForPrice = sku ? inventoryMap.get(`sku:${sku}`) : null;
              const asinFallback = !invItemForPrice ? inventoryMap.get(asin) : null;
              const effectiveInvItem = invItemForPrice || asinFallback;
              
              const inventoryPrice = effectiveInvItem?.price ? parseFloat(effectiveInvItem.price) : 0;
              const myPrice = effectiveInvItem?.my_price ? parseFloat(effectiveInvItem.my_price) : 0;
              const amazonPrice = effectiveInvItem?.amazon_price ? parseFloat(effectiveInvItem.amazon_price) : 0;
              
              let actualPrice = inventoryPrice > 0 ? inventoryPrice : (amazonPrice > 0 ? amazonPrice : myPrice);
              
              // NOTE: We do NOT use buy_box_cache for estimated_price.
              // estimated_price should only come from inventory.price (user's listing price).
              // Buy Box is used only for FEE calculation reference, not for sales price estimation.
              
              if (actualPrice > 0) {
                // Store as ESTIMATE only - NOT in sold_price/item_price
                estimatedPrice = actualPrice;
                const source = invItemForPrice ? 'inventory_sku' : (inventoryPrice > 0 ? 'inventory_asin' : (amazonPrice > 0 ? 'amazon_price' : 'buy_box_cache'));
                priceSource = `hint:${source}`;
                priceCalcMode = 'estimated_multi_item';
                roiSource = 'estimated';
                priceConfidence = 'LOW_CONFIDENCE_HINT';
                console.log(`[LIVE_ORDERS] 🟡 Order ${orderId} MULTI-ITEM item ${asin} SKU=${sku || 'none'} - LOW-CONFIDENCE HINT: $${actualPrice.toFixed(2)} USD/unit via ${source}`);
              } else {
                priceCalcMode = 'skipped_multi_item';
                roiSource = 'unknown';
                console.log(`[LIVE_ORDERS] ⏳ Order ${orderId} MULTI-ITEM item ${asin}: no price available for estimate`);
              }
            } else {
              // Single-item order
              const orderTotalRaw = parseFloat(amazonOrder?.OrderTotal?.Amount || '0');
              const orderTotalCurrency = amazonOrder?.OrderTotal?.CurrencyCode || 'USD';
              // Use dynamic fxRates: divide by rate to convert foreign to USD
              const orderTotalRate = orderTotalCurrency !== 'USD' && fxRates[orderTotalCurrency] ? 1 / fxRates[orderTotalCurrency] : 1;
              const orderTotalUSD = orderTotalRaw * orderTotalRate;
              
              if (orderTotalUSD > 0) {
                // OrderTotal from Amazon — actual transaction total at order time. HIGH confidence.
                const estPrice = quantity > 0 ? orderTotalUSD / quantity : orderTotalUSD;
                estimatedPrice = estPrice;
                priceSource = 'seller_derived:order_total';
                priceCalcMode = 'estimated_order_total';
                roiSource = 'estimated';
                priceConfidence = 'HIGH_CONFIDENCE_PENDING';
                console.log(`[LIVE_ORDERS] 🟢 Order ${orderId} Pending - SELLER-DERIVED OrderTotal: $${estPrice.toFixed(2)} USD/unit`);
              } else {
                // LOW-CONFIDENCE FALLBACK CHAIN (never written to sold_price, gated out of Live Sales strict mode):
                //   1. Keepa historical price at order_date
                //   2. inventory.price / amazon_price / my_price
                let actualPrice = 0;
                let estSourceLabel = '';

                // Step 1: Try Keepa historical price (LOW CONFIDENCE — competitor/market estimate)
                try {
                  const keepaResp = await fetch(`${supabaseUrl}/functions/v1/keepa-historical-price`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${supabaseKey}`,
                    },
                    body: JSON.stringify({
                      asin,
                      marketplace: marketplace || 'US',
                      timestamp: amazonOrder?.PurchaseDate || new Date().toISOString(),
                    }),
                  });
                  if (keepaResp.ok) {
                    const k = await keepaResp.json();
                    if (k?.price_usd && k.price_usd > 0) {
                      actualPrice = k.price_usd;
                      estSourceLabel = `keepa_historical:${k.source}`;
                      console.log(`[LIVE_ORDERS] 🟣 Keepa fallback for ${orderId}/${asin}: $${k.price_usd} (source=${k.source}, cached=${k.cached})`);
                    }
                  }
                } catch (e) {
                  console.warn(`[LIVE_ORDERS] Keepa fallback failed for ${orderId}/${asin}: ${(e as Error).message}`);
                }

                // Step 2: Inventory fallback if Keepa returned nothing
                if (actualPrice <= 0) {
                  const invItemForPrice = inventoryMap.get(asin) || (sku ? inventoryMap.get(`sku:${sku}`) : null);
                  const inventoryPrice = invItemForPrice?.price ? parseFloat(invItemForPrice.price) : 0;
                  const myPrice = invItemForPrice?.my_price ? parseFloat(invItemForPrice.my_price) : 0;
                  const amazonPrice = invItemForPrice?.amazon_price ? parseFloat(invItemForPrice.amazon_price) : 0;
                  actualPrice = inventoryPrice > 0 ? inventoryPrice : (amazonPrice > 0 ? amazonPrice : myPrice);
                  estSourceLabel = inventoryPrice > 0 ? 'inventory' : (amazonPrice > 0 ? 'amazon_price' : 'my_price');
                }

                if (actualPrice > 0) {
                  estimatedPrice = actualPrice;
                  priceSource = `hint:${estSourceLabel}`;
                  priceCalcMode = estSourceLabel.startsWith('keepa') ? 'estimated_keepa' : 'estimated_inventory';
                  roiSource = 'estimated';
                  priceConfidence = 'LOW_CONFIDENCE_HINT';
                  console.log(`[LIVE_ORDERS] 🟡 Order ${orderId} Pending - LOW-CONFIDENCE HINT: $${actualPrice.toFixed(2)} USD/unit via ${estSourceLabel}`);
                } else {
                  console.log(`[LIVE_ORDERS] ⏳ Order ${orderId} item ${asin}: Status=Pending, no price available for estimate`);
                  priceCalcMode = 'unknown';
                  roiSource = 'unknown';
                }
              }
            }
          } // end if (!estimatedPrice)
          } else if (rawTotal > 0) {
            // FIX #2: Separate item_price from shipping_price
            const itemPriceUSD = itemRate !== 1 ? itemPriceRaw * itemRate : itemPriceRaw;
            const shippingPriceUSD = itemRate !== 1 ? shippingPriceRaw * itemRate : shippingPriceRaw;
            
            totalSaleAmount = itemPriceUSD + shippingPriceUSD;
            itemPrice = quantity > 0 ? itemPriceUSD / quantity : itemPriceUSD;
            shippingPriceComponent = quantity > 0 ? shippingPriceUSD / quantity : shippingPriceUSD;
            soldPrice = itemPrice; // ROI uses item_price only
            priceSource = itemCurrency === 'USD' ? 'orders_itemprice' : 'orders_itemprice_usd';
            priceCalcMode = itemCurrency === 'USD' ? 'orders_itemprice' : 'orders_itemprice_usd';
            roiSource = 'actual'; // Actual price from Orders API

            if (isDebugOrder(orderId)) {
              console.log('[LIVE_ORDERS][DEBUG_ORDER] Item price computed (separated)', {
                orderId,
                asin,
                itemPriceRaw,
                shippingPriceRaw,
                itemPriceUSD,
                shippingPriceUSD,
                itemPricePerUnit: itemPrice,
                shippingPricePerUnit: shippingPriceComponent,
              });
            }
            
            console.log(`[LIVE_ORDERS] ✅ Order ${orderId} item ${asin}: Status=${orderStatus}, ItemPrice=$${itemPriceRaw}→$${itemPrice.toFixed(2)}/unit, Shipping=$${shippingPriceRaw}→$${shippingPriceComponent.toFixed(2)}/unit | price_calc_mode=orders_itemprice`);
          }
          
          if (shippingPriceRaw > 0) {
            console.log(`[LIVE_ORDERS] 📦 Order ${orderId} item ${asin}: ItemPrice=$${itemPriceRaw}, ShippingPrice=$${shippingPriceRaw}, Total=$${rawTotal}`);
          }
          
      // If no price from order items, leave as-is - do NOT use Buy Box (would be wrong price)
          
          // Enrich from local data
          let title = item.Title || null;
          let imageUrl: string | null = null;
          let unitCost: number | null = null;

          // SKU-FIRST PRICING: Prioritize SKU lookup over ASIN for multi-offer ASINs
          const clItem = sku ? createdListingsMap.get(`sku:${sku}`) : null;
          const clAsinFallback = !clItem ? createdListingsMap.get(asin) : null;
          const effectiveClItem = clItem || clAsinFallback;

          const invItem = sku ? inventoryMap.get(`sku:${sku}`) : null;
          const invAsinFallback = !invItem ? inventoryMap.get(asin) : null;
          const effectiveInvItem = invItem || invAsinFallback;

          if (effectiveClItem) {
            if (!title) title = effectiveClItem.title;
            if (!imageUrl) imageUrl = effectiveClItem.image_url;
          }

          if (effectiveInvItem) {
            if (!title) title = effectiveInvItem.title;
            if (!imageUrl) imageUrl = effectiveInvItem.image_url;
          }

          const costResolution = resolveHistoricalUnitCost(asin, sku, orderDate);
          unitCost = costResolution.unitCost;
          if (unitCost !== null && unitCost > 0) {
            console.log(`[LIVE_ORDERS] Cost LOCK for ASIN ${asin} SKU=${sku || 'none'} orderDate=${orderDate}: ${costResolution.source}, unitCost=$${unitCost.toFixed(2)}`);
          }

          
          // Fallback to Catalog API if still missing image/title (limit API calls)
          // Also use it to detect media category for closing fee
          let isMediaProduct = false;
          if (asin !== 'UNKNOWN' && asin !== 'PENDING') {
            // Always call Catalog API to detect media category if we don't have complete data
            if (!title || !imageUrl) {
              const catalogData = await fetchCatalogData(asin, accessToken, primaryMarketplaceId);
              if (!title && catalogData.title) title = catalogData.title;
              if (!imageUrl && catalogData.imageUrl) imageUrl = catalogData.imageUrl;
              isMediaProduct = catalogData.isMedia;
              if (isMediaProduct) {
                console.log(`[LIVE_ORDERS] 📚 MEDIA detected for ${asin}: productType=${catalogData.productType}`);
              }
              // Small delay to avoid rate limits
              await new Promise(resolve => setTimeout(resolve, 300));
            } else {
              // We already have title/image from local data, but still need to check media category
              // Only call if we need accurate closing fee (for non-zero prices)
              if (soldPrice > 0) {
                const catalogData = await fetchCatalogData(asin, accessToken, primaryMarketplaceId);
                isMediaProduct = catalogData.isMedia;
                if (isMediaProduct) {
                  console.log(`[LIVE_ORDERS] 📚 MEDIA detected for ${asin}: productType=${catalogData.productType}`);
                }
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            }
          }
          
          // Fetch fees using proportional scaling:
          // 1. Get Buy Box / listing reference price (for Fees API call)
          // 2. Scale fees proportionally to actual sale price
          let fees: { referralFee: number | null; fbaFee: number | null; closingFee: number | null; totalFees: number | null; feesUnavailable?: boolean } = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null, feesUnavailable: true };
          let feesUnavailable = true;
          
          if (soldPrice > 0 && asin !== 'UNKNOWN' && asin !== 'PENDING') {
            // MARKETPLACE-AWARE FEES: Use correct marketplace ID for non-US orders
            const orderMarketplaceId = amazonOrder?.MarketplaceId || 
              (marketplace === 'MX' ? 'A1AM78C64UM0Y8' : 
               marketplace === 'CA' ? 'A2EUQ1WTGCTBG2' : 
               marketplace === 'BR' ? 'A2Q3Y263D00KWC' : primaryMarketplaceId);
            
            // CRITICAL FIX: For non-US orders, use soldPrice as reference (it's already USD from the actual marketplace)
            // Buy Box/inventory prices are US-centric and would result in wrong fee calculations
            const isNonUsOrder = ['MX', 'CA', 'BR'].includes(marketplace);
            
            let referencePrice = soldPrice; // Default for non-US
            
            if (!isNonUsOrder) {
              // For US orders, try to get a Buy Box reference price for better fee accuracy
              const { data: buyBoxCache } = await supabase
                .from('buy_box_cache')
                .select('price')
                .eq('asin', asin)
                .maybeSingle();
              
              // Use inventory's amazon_price as fallback reference
              let invAmazonPrice = 0;
              const { data: invData } = await supabase
                .from('inventory')
                .select('amazon_price')
                .eq('user_id', user.id)
                .eq('asin', asin)
                .maybeSingle();
              if (invData?.amazon_price) invAmazonPrice = invData.amazon_price;
              
              referencePrice = buyBoxCache?.price || invAmazonPrice || soldPrice;
            }
            
            console.log(`[LIVE_ORDERS] 📍 Fetching ${isFbmOrder ? 'FBM' : 'FBA'} fees for ${asin} in marketplace ${marketplace} (${orderMarketplaceId}) ref=$${referencePrice.toFixed(2)}${isNonUsOrder ? ' (using soldPrice for non-US)' : ''}`);
            
            // Pass fxRates for non-US marketplaces to convert fees to USD
            // For FBM orders: IsAmazonFulfilled=false to get correct FBM fee structure
            const apiFees = await getProductFees(supabase, asin, referencePrice, accessToken, orderMarketplaceId, soldPrice, fxRates, !isFbmOrder);
            if (apiFees) {
              // QUANTITY FIX: Fees API returns PER-UNIT fees (priced for a single
              // unit). Multiply by order quantity so multi-unit orders don't
              // under-report fees and overstate ROI. Mirrors sync-sales-orders
              // pending enrichment (lines 1607-1610 / 1672-1674).
              const qtyMul = Math.max(1, Number(quantity || 1));
              if (isFbmOrder) {
                // FBM: Bundle ALL fees into fba_fee column (now labeled FBA/FBM), zero out referral/closing
                const totalFbmFeesPerUnit = apiFees.referralFee + apiFees.fbaFee + apiFees.closingFee;
                const totalFbmFees = totalFbmFeesPerUnit * qtyMul;
                fees = { referralFee: 0, fbaFee: totalFbmFees, closingFee: 0, totalFees: totalFbmFees };
                console.log(`[LIVE_ORDERS] 💰 FBM fees for ${asin}: bundled $${totalFbmFees.toFixed(2)} (per-unit $${totalFbmFeesPerUnit.toFixed(2)} × qty ${qtyMul}) into FBA/FBM column (referral=$${apiFees.referralFee.toFixed(2)}, closing=$${apiFees.closingFee.toFixed(2)})`);
              } else {
                fees = {
                  referralFee: apiFees.referralFee * qtyMul,
                  fbaFee: apiFees.fbaFee * qtyMul,
                  closingFee: apiFees.closingFee * qtyMul,
                  totalFees: apiFees.totalFees * qtyMul,
                };
                if (qtyMul > 1) {
                  console.log(`[LIVE_ORDERS] 💰 FBA fees for ${asin} multiplied by qty ${qtyMul}: referral=$${fees.referralFee!.toFixed(2)}, fba=$${fees.fbaFee!.toFixed(2)}, closing=$${fees.closingFee!.toFixed(2)}, total=$${fees.totalFees!.toFixed(2)}`);
                }
              }
              feesUnavailable = false;
              console.log(`[LIVE_ORDERS] 💰 Using ${isFbmOrder ? 'FBM' : 'proportional'} API fees for ${asin} (${marketplace}) (ref=$${referencePrice.toFixed(2)}, sale=$${soldPrice.toFixed(2)})`);
            } else {
              // API failed - fees are unavailable (NULL, not 0)
              fees = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null, feesUnavailable: true };
              feesUnavailable = true;
              console.log(`[LIVE_ORDERS] ⚠️ Fees UNAVAILABLE for ${asin} (${marketplace}) (API failed) - will be NULL`);
            }
            // Small delay to avoid rate limits on Fees API
            await new Promise(resolve => setTimeout(resolve, 200));
          } else {
            // No price yet - fees are unavailable
            fees = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null, feesUnavailable: true };
            feesUnavailable = true;
          }
          
          // Get shipping label cost for this order (FBM)
          const shippingLabelFee = shippingLabelCosts.get(orderId) || 0;
          // Only add shipping to total if we have valid fees
          const totalFeesWithShipping = fees.totalFees !== null ? fees.totalFees + shippingLabelFee : null;
          
          if (shippingLabelFee > 0) {
            console.log(`[LIVE_ORDERS] Order ${orderId} has FBM shipping label cost: $${shippingLabelFee.toFixed(2)}`);
          }
          // For replacement orders, set all revenue and fees to $0 (no charge to customer)
          // but still track the unit cost (loss to seller)
          const finalSoldPrice = isReplacement ? 0 : Math.round(soldPrice * 100) / 100;
          const finalItemPrice = isReplacement ? 0 : Math.round(itemPrice * 100) / 100;
          const finalShippingPrice = isReplacement ? 0 : Math.round(shippingPriceComponent * 100) / 100;
          const finalTotalSaleAmount = isReplacement ? 0 : Math.round(totalSaleAmount * 100) / 100;
          
          // Use NULL for unavailable fees - DB trigger will enforce this
          const finalReferralFee = isReplacement ? 0 : (fees.referralFee !== null ? Math.round(fees.referralFee * 100) / 100 : null);
          const finalFbaFee = isReplacement 
            ? (fees.fbaFee !== null ? Math.round(fees.fbaFee * 100) / 100 : null) 
            : (fees.fbaFee !== null ? Math.round(fees.fbaFee * 100) / 100 : null);
          const finalClosingFee = isReplacement ? 0 : (fees.closingFee !== null ? Math.round(fees.closingFee * 100) / 100 : null);
          const finalTotalFees = isReplacement 
            ? finalFbaFee 
            : (totalFeesWithShipping !== null ? Math.round(totalFeesWithShipping * 100) / 100 : null);
          
          // Determine fees_source based on how fees were obtained
          const feesSource = feesUnavailable ? 'unavailable' : 'fees_api';
          
          // FIX #6: Only mark ROI as 'actual' when we have trusted inputs
          const hasActualPrice = priceCalcMode === 'orders_itemprice';
          const hasActualFees = !feesUnavailable;
          const hasActualCost = unitCost !== null && unitCost > 0;
          const computedRoiSource = hasActualPrice && hasActualFees && hasActualCost ? 'actual' : 
                                   (hasActualPrice || hasActualFees || hasActualCost ? 'estimated' : 'unknown');
          
          // NEW FIX: For pending estimates, leave sold_price/item_price as 0, store in estimated_price
          // This prevents "locking" estimates and allows UI to use latest inventory.price
          // CRITICAL: Pricing API prices for pending orders are ESTIMATES, not actual sale prices!
          // They do NOT include shipping breakdown - only settled orders have that.
          const isEstimatedPrice = priceSource?.startsWith('estimated:') ||
            priceSource?.startsWith('pricing_api_') ||
            priceSource?.startsWith('listings_api_') ||
            priceSource?.startsWith('seller_derived:') ||
            priceSource?.startsWith('hint:') ||
            priceSource === 'snapshot_price' ||
            priceSource === 'order_total_pending' ||
            false;
          
          // For estimated prices: sold_price, item_price, shipping_price = 0 (unknown until settled)
          // The estimate goes ONLY into estimated_price for display/reporting purposes
          const actualSoldPrice = isEstimatedPrice ? 0 : finalSoldPrice;
          const actualItemPrice = isEstimatedPrice ? 0 : finalItemPrice;
          const actualTotalSaleAmount = isEstimatedPrice ? 0 : finalTotalSaleAmount;
          const finalEstimatedPrice = estimatedPrice ? Math.round(estimatedPrice * 100) / 100 : null;
          const finalLockedEstPrice = isEstimatedPrice && finalEstimatedPrice && finalEstimatedPrice > 0
            ? finalEstimatedPrice
            : null;
          // CONFIRMED if we have a real Orders API price; otherwise use the tier set above.
          const finalPriceConfidence = !isEstimatedPrice && actualSoldPrice > 0
            ? 'CONFIRMED'
            : priceConfidence;
          
          const orderDataWithItems: any = {
            user_id: user.id,
            order_id: orderId,
            asin,
            sku,
            seller_sku: sku, // SKU-level pricing: store seller_sku for accurate price matching
            title,
            image_url: imageUrl,
            quantity,
            sold_price: actualSoldPrice,
            item_price: actualItemPrice,
            shipping_price: isEstimatedPrice ? 0 : finalShippingPrice,
            total_sale_amount: actualTotalSaleAmount,
            estimated_price: finalEstimatedPrice, // NEW: Store estimate separately
            locked_est_price: finalLockedEstPrice,
            locked_from: finalLockedEstPrice ? (priceSource || priceCalcMode || 'order_discovery') : null,
            referral_fee: finalReferralFee,
            fba_fee: finalFbaFee,
            closing_fee: finalClosingFee,
            shipping_label_fee: isReplacement ? 0 : Math.round(shippingLabelFee * 100) / 100,
            total_fees: finalTotalFees,
            unit_cost: unitCost ? Math.round(unitCost * 100) / 100 : 0,
            unit_cost_at_sale: unitCost ? Math.round(unitCost * 100) / 100 : null,
            cost_source_at_sale: costResolution.source,
            cost_locked: !!(unitCost && unitCost > 0),
            cost_locked_at: unitCost && unitCost > 0 ? new Date().toISOString() : null,
            total_cost: unitCost ? Math.round(unitCost * quantity * 100) / 100 : 0,
            roi: 0, // ROI will be calculated elsewhere based on roi_source
            order_date: orderDate,
            purchase_timestamp_utc: purchaseDate || new Date().toISOString(),
            status: 'pending',
            order_status: orderStatus,
            order_type: orderType,
            is_replacement: isReplacement,
            replacement_reason: isReplacement
              ? (orderTypeRaw && orderTypeRaw.toLowerCase().includes('replacement')
                  ? 'orders_api_replacement'
                  : isReplacementFlag
                    ? 'orders_api_is_replacement_flag'
                    : zeroPrincipalAfnClassifierHit
                      ? 'replacement_classifier_zero_principal_afn'
                      : 'fec_zero_principal_shipped')
              : null,
            related_order_id: isReplacement ? replacedOrderId : null,
            marketplace,
            fulfillment_channel: fulfillmentChannel, // AFN=FBA, MFN=FBM
            refund_amount: 0,
            refund_quantity: 0,
            // NEW FIELDS for debugging and accuracy
            is_multi_item_order: isMultiItemOrder,
            price_calc_mode: priceCalcMode,
            roi_source: computedRoiSource,
            fees_source: feesSource,
            fees_missing: feesUnavailable,
            // Ensure repair-pending-prices can pick these up later when Fees API fails
            needs_fee_enrich: feesUnavailable,
            price_enrich_status: actualSoldPrice > 0 ? 'enriched' : 'pending',
            price_last_error: actualSoldPrice === 0 && !estimatedPrice ? 'No price available yet' : null,
            price_confidence: finalPriceConfidence,
          };

          // Add price_source if we determined the price source
          if (priceSource) {
            orderDataWithItems.price_source = priceSource;
          }

          // Own-BB capture is diagnostic only for pending orders.
          // Never promote bb_estimate_price into estimated_price; pending
          // sale prices must come from seller-derived sources only.
          if (finalPriceConfidence !== 'CONFIRMED' && actualSoldPrice === 0) {
            try {
              const bbFields = await computeBbOwnEstimateFields(
                supabase,
                {
                  userId: user.id,
                  asin,
                  marketplace,
                  orderDateIso: orderDataWithItems.purchase_timestamp_utc,
                  fulfillmentChannel,
                },
                ((globalThis as any).__bbSellerIdCache ||= makeSellerIdCache()),
              );
              Object.assign(orderDataWithItems, bbFields);
              const localSrc = String(priceSource || '').toLowerCase();
              const localEst = Number(finalEstimatedPrice || 0);
              const localExactSnapshot = await getExactOrderSnapshotEstimate(supabase, user.id, orderId, asin, marketplace, fxRates);
              const exactSnapshotEstimate = localExactSnapshot?.price ?? null;
              // See exactSnapshotIsLiveRead comment in captureMissingBbEstimateForOrders:
              // only pricing_api/orders_api snapshots are genuine live reads; an
              // 'inventory'-sourced snapshot just freezes whatever the local
              // inventory.price cache said at that moment, which can lag the true
              // live listing price.
              const exactSnapshotIsLiveRead = localExactSnapshot !== null && (localExactSnapshot.source === 'pricing_api' || localExactSnapshot.source === 'orders_api');
              if (exactSnapshotIsLiveRead && Math.abs(localEst - exactSnapshotEstimate!) > 0.001) {
                orderDataWithItems.estimated_price = exactSnapshotEstimate;
                orderDataWithItems.locked_est_price = exactSnapshotEstimate;
                orderDataWithItems.locked_from = 'seller_derived:snapshot';
                orderDataWithItems.price_source = 'seller_derived:snapshot';
                orderDataWithItems.price_confidence = 'HIGH_CONFIDENCE_PENDING';
                orderDataWithItems.needs_price_enrich = true;
                orderDataWithItems.price_enrich_status = 'pending';
                orderDataWithItems.price_last_error = null;
                console.log(`🛡️ SNAPSHOT_INSERT_RESTORED: ${orderId}/${asin} estimated_price ${localEst} -> ${exactSnapshotEstimate}`);
              }
              // repricer_* moved to the soft tier 2026-08-24 -- see the full
              // note in captureMissingBbEstimateForOrders. It logs what was
              // SUBMITTED, not what was live, and order 112-0854205-5253012
              // proved the gap: $32.87 kept over 28 consecutive own-BB
              // snapshots reading $25.94, which is what the buyer paid.
              const localSellerDerived = exactSnapshotIsLiveRead || localEst > 0 && (
                localSrc.startsWith('snapshot_price') ||
                localSrc.startsWith('order_total') ||
                localSrc.startsWith('listings_api') ||
                localSrc.startsWith('seller_derived:order_total') ||
                localSrc.startsWith('seller_derived:listings_api')
              );
              // See BB_PROMOTED_OVER_SOFT_ESTIMATE comment in captureMissingBbEstimateForOrders:
              // recent_sale and an inventory-backed seller_derived:snapshot are both
              // "soft" -- neither is tied to THIS order's actual live price, so a
              // qualified+owner-matched BB estimate anchored near order time outranks them.
              const localIsSoftEstimate = !localSellerDerived && localEst > 0 && (
                localSrc.startsWith('recent_sale') ||
                localSrc.startsWith('seller_derived:recent') ||
                localSrc.startsWith('seller_derived:snapshot') ||
                localSrc.startsWith('repricer_') ||
                localSrc.startsWith('seller_derived:repricer')
              );
              const localBbPromotes = localIsSoftEstimate
                && bbFields.bb_estimate_qualified && bbFields.bb_estimate_owner_match
                && (bbFields.bb_estimate_price ?? 0) > 0
                && Math.abs((bbFields.bb_estimate_price ?? 0) - localEst) > 0.001;
              if (localBbPromotes) {
                orderDataWithItems.estimated_price = bbFields.bb_estimate_price;
                orderDataWithItems.locked_est_price = bbFields.bb_estimate_price;
                orderDataWithItems.locked_from = 'bb_estimate:own_buybox';
                orderDataWithItems.price_source = 'bb_estimate:own_buybox';
                orderDataWithItems.price_confidence = 'HIGH_CONFIDENCE_PENDING';
                console.log(`🛡️ BB_PROMOTED_OVER_SOFT_ESTIMATE: ${orderId}/${asin} estimated_price ${localEst} -> ${bbFields.bb_estimate_price} (${localSrc} replaced by own-BB anchored near order time)`);
              } else if (bbFields.bb_estimate_qualified && (bbFields.bb_estimate_price ?? 0) > 0 && !localSellerDerived && !localIsSoftEstimate) {
                console.log(`🛡️ BB_INSERT_CAPTURE_ONLY: ${orderId}/${asin} did not promote BB=$${bbFields.bb_estimate_price}; pending prices require seller-derived source`);
              } else if ((localSellerDerived || localIsSoftEstimate) && bbFields.bb_estimate_qualified) {
                console.log(`🛡️ BB_INSERT_SKIPPED_SELLER_DERIVED: ${orderId}/${asin} kept ${localSrc}=$${localEst} over BB=$${bbFields.bb_estimate_price}`);
              }
            } catch (e: any) {
              console.warn(`[bbOwnEstimate] capture skipped for ${orderId}/${asin}: ${e?.message ?? e}`);
            }
          }

          ordersToUpsert.push(orderDataWithItems);
        }
      }
    }
    
    // Update orders needing enrichment (those that we successfully fetched items for)
    for (const orderId of ordersNeedingEnrichment) {
      const items = orderItemsMap.get(orderId);
      if (!items || items.length === 0) continue;
      
      // Find the Amazon order to detect marketplace and status
      const amazonOrder = amazonOrders.find(o => o.AmazonOrderId === orderId);
      const { marketplace, currencyRate: orderCurrencyRate } = detectMarketplace(amazonOrder);
      const currentAmazonStatus = amazonOrder?.OrderStatus || 'Pending';
      
      // MULTI-ITEM ORDER DETECTION for enrichment
      const isMultiItemOrder = items.length > 1 || items.reduce((sum: number, i: any) => sum + parseInt(i.QuantityOrdered || '1', 10), 0) > 1;
      
      const item = items[0];
      const asin = item.ASIN || 'UNKNOWN';
      const sku = item.SellerSKU || null;
      const quantity = parseInt(item.QuantityOrdered || '1', 10);
      let totalSaleAmount = 0;
      let soldPrice = 0;
      let itemPriceUSD = 0;
      let shippingPriceUSD = 0;
      let priceCalcMode: string = 'unknown';
      let roiSource: string = 'unknown';
      
      // Compute totalCustomerPaid = ItemPrice + ShippingPrice (converted to USD)
      const itemCurrency =
        item.ItemPrice?.CurrencyCode || amazonOrder?.OrderTotal?.CurrencyCode || 'USD';
      // Use dynamic fxRates: 1/rate to convert foreign to USD
      const itemCurrencyRate = itemCurrency !== 'USD' && fxRates[itemCurrency] ? 1 / fxRates[itemCurrency] : orderCurrencyRate;

      const itemPriceRaw = parseFloat(item.ItemPrice?.Amount || '0') || 0;
      const shippingPriceRaw = parseFloat(item.ShippingPrice?.Amount || '0') || 0;
      const rawTotal = itemPriceRaw + shippingPriceRaw;

      // IMPORTANT: Amazon's GetOrderItems does NOT return pricing data when order is "Pending" status.
      const isPendingStatus = currentAmazonStatus === 'Pending';
      
      // NEW: Track estimated price for non-US pending orders
      let estimatedPrice: number | null = null;
      let priceSource: string | null = null;
      
      if (isPendingStatus && rawTotal === 0) {
        // Order is still Pending - price not available from GetOrderItems yet.
        
        // CRITICAL FIX: For non-US marketplaces, use Listings API (SKU-based) to get SELLER'S OWN price
        // This is more accurate than Pricing API which returns competitor/buy box prices
        const isNonUsMarketplace = ['MX', 'CA', 'BR'].includes(marketplace);
        if (isNonUsMarketplace && asin !== 'UNKNOWN' && asin !== 'PENDING') {
          const marketplaceIdForPricing = 
            marketplace === 'MX' ? 'A1AM78C64UM0Y8' : 
            marketplace === 'CA' ? 'A2EUQ1WTGCTBG2' : 'A2Q3Y263D00KWC';
          
          // PRIORITY 1: Use Listings API with SKU (returns YOUR price, not buy box)
          if (sku && sellerId) {
            console.log(`[LIVE_ORDERS] 🌎 NON-US enrichment ${orderId}: Using Listings API for ${marketplace} marketplace price (SKU: ${sku})`);
            
            const listingResult = await getSellerListingPrice(sku, sellerId, marketplaceIdForPricing, accessToken, fxRates);
            
            if (listingResult.priceUsd !== null && listingResult.priceUsd > 0) {
              // CONTRACT: store NATIVE marketplace currency.
              estimatedPrice = listingResult.localPrice ?? listingResult.priceUsd;
              priceSource = `listings_api_${marketplace.toLowerCase()}`;
              priceCalcMode = 'listings_api';
              roiSource = 'estimated';
              console.log(`[LIVE_ORDERS] ✅ LISTINGS API (enrichment, NATIVE): Order ${orderId} ASIN ${asin} SKU=${sku} - storing ${listingResult.currency} ${listingResult.localPrice?.toFixed(2)} (USD ref $${listingResult.priceUsd.toFixed(2)})`);
              await new Promise(resolve => setTimeout(resolve, 300));
            } else {
              console.log(`[LIVE_ORDERS] ⚠️ LISTINGS API returned no price for SKU ${sku} (${marketplace}) - trying Pricing API fallback`);
            }
          }
          
          // PRIORITY 2: Fallback to Pricing API if Listings API failed or no SKU
          if (!estimatedPrice) {
            console.log(`[LIVE_ORDERS] 🌎 NON-US enrichment ${orderId}: Fallback to Pricing API for ${marketplace}`);
            
            const pricingResult = await getMarketplacePricingPrice(supabase, asin, marketplaceIdForPricing, accessToken, fxRates);
            
            if (pricingResult.priceUsd !== null && pricingResult.priceUsd > 0) {
              // CONTRACT: store NATIVE marketplace currency.
              estimatedPrice = pricingResult.localPrice ?? pricingResult.priceUsd;
              priceSource = `pricing_api_${marketplace.toLowerCase()}`;
              priceCalcMode = 'pricing_api';
              roiSource = 'estimated';
              console.log(`[LIVE_ORDERS] ✅ PRICING API (enrichment fallback, NATIVE): Order ${orderId} ASIN ${asin} - storing ${pricingResult.currency} ${pricingResult.localPrice} (USD ref $${pricingResult.priceUsd.toFixed(2)})`);
              await new Promise(resolve => setTimeout(resolve, 300));
            } else {
              console.log(`[LIVE_ORDERS] ⚠️ PRICING API returned no price for ${asin} (${marketplace}) - order will remain with no estimate`);
              priceCalcMode = isMultiItemOrder ? 'skipped_multi_item' : 'unknown';
            }
          }
        } else {
          console.log(`[LIVE_ORDERS] ⏳ Enriching ${orderId}: Status=Pending, price not yet available (payment not authorized)`);
          priceCalcMode = isMultiItemOrder ? 'skipped_multi_item' : 'unknown';
        }
      } else if (rawTotal > 0) {
        // FIX #2: Separate item_price from shipping_price
        itemPriceUSD = itemCurrencyRate !== 1 ? itemPriceRaw * itemCurrencyRate : itemPriceRaw;
        shippingPriceUSD = itemCurrencyRate !== 1 ? shippingPriceRaw * itemCurrencyRate : shippingPriceRaw;
        
        totalSaleAmount = itemPriceUSD + shippingPriceUSD;
        soldPrice = quantity > 0 ? itemPriceUSD / quantity : itemPriceUSD; // ROI uses item_price only
        priceCalcMode = 'orders_itemprice';
        roiSource = 'actual';

        console.log(
          `[LIVE_ORDERS] ✅ Enriching ${orderId}: Status=${currentAmazonStatus}, ItemPrice=$${itemPriceRaw}→$${soldPrice.toFixed(2)}/unit, Shipping=$${shippingPriceRaw}→$${(quantity > 0 ? shippingPriceUSD / quantity : shippingPriceUSD).toFixed(2)}/unit`
        );
      }
      
      // If no price from order items, leave as $0 - do NOT use Buy Box (current price vs actual sold price)
      // Orders with $0 will be re-enriched on next sync when order status changes to Unshipped
      
      let title = item.Title || null;
      let imageUrl: string | null = null;
      let unitCost: number | null = null;

      // SKU-FIRST PRICING: Prioritize SKU lookup over ASIN for enrichment
      const clItem = sku ? createdListingsMap.get(`sku:${sku}`) : null;
      const clAsinFallback = !clItem ? createdListingsMap.get(asin) : null;
      const effectiveClItem = clItem || clAsinFallback;

      const invItem = sku ? inventoryMap.get(`sku:${sku}`) : null;
      const invAsinFallback = !invItem ? inventoryMap.get(asin) : null;
      const effectiveInvItem = invItem || invAsinFallback;

      if (effectiveClItem) {
        if (!title) title = effectiveClItem.title;
        if (!imageUrl) imageUrl = effectiveClItem.image_url;
      }

      if (effectiveInvItem) {
        if (!title) title = effectiveInvItem.title;
        if (!imageUrl) imageUrl = effectiveInvItem.image_url;
      }

      const existingDbOrder = existingOrdersMap.get(orderId);
      // BUG FIX: orderDate was referenced below (cost-history lookup + log
      // line) with no local binding in this enrichment loop — a ReferenceError
      // that crashed the entire enrichment pass (every order in the batch,
      // not just this one) whenever ordersNeedingEnrichment was non-empty.
      // Prefer the already-stored order_date on the existing row (most
      // authoritative — it's what this order was actually filed under);
      // fall back to deriving it from Amazon's purchase date the same way
      // the new-order insert path does, then the query window as a last resort.
      const enrichPurchaseDate = amazonOrder?.PurchaseDate || amazonOrder?.LastUpdateDate;
      const orderDate = existingDbOrder?.order_date
        || (enrichPurchaseDate ? getCutoffDateStringInTimeZone(enrichPurchaseDate, userTimezone) : queryStartDate);
      const lockedUnitCost = Number(existingDbOrder?.unit_cost_at_sale || 0) || 0;
      const legacyLockedCost = Number(existingDbOrder?.unit_cost || 0) || 0;
      const costResolution = lockedUnitCost > 0
        ? { unitCost: Math.round(lockedUnitCost * 100) / 100, source: existingDbOrder?.cost_source_at_sale || 'sales_orders_locked' }
        : existingDbOrder?.cost_locked === true && legacyLockedCost > 0
          ? { unitCost: Math.round(legacyLockedCost * 100) / 100, source: existingDbOrder?.cost_source_at_sale || 'sales_orders_locked_legacy' }
          : resolveHistoricalUnitCost(asin, sku, orderDate);
      unitCost = costResolution.unitCost;
      if (unitCost !== null && unitCost > 0) {
        console.log(`[LIVE_ORDERS] Cost LOCK (enrichment) for ASIN ${asin} SKU=${sku || 'none'} orderDate=${orderDate}: ${costResolution.source}, unitCost=$${unitCost.toFixed(2)}`);
      }

      
      // Fallback to Catalog API if still missing image/title
      // Also use it to detect media category for closing fee
      let isMediaProduct = false;
      if (asin !== 'UNKNOWN' && asin !== 'PENDING') {
        if (!title || !imageUrl) {
          const catalogData = await fetchCatalogData(asin, accessToken, primaryMarketplaceId);
          if (!title && catalogData.title) title = catalogData.title;
          if (!imageUrl && catalogData.imageUrl) imageUrl = catalogData.imageUrl;
          isMediaProduct = catalogData.isMedia;
          if (isMediaProduct) {
            console.log(`[LIVE_ORDERS] 📚 MEDIA detected (enrichment) for ${asin}: productType=${catalogData.productType}`);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        } else if (soldPrice > 0) {
          // Already have title/image, but still check media category for accurate closing fee
          const catalogData = await fetchCatalogData(asin, accessToken, primaryMarketplaceId);
          isMediaProduct = catalogData.isMedia;
          if (isMediaProduct) {
            console.log(`[LIVE_ORDERS] 📚 MEDIA detected (enrichment) for ${asin}: productType=${catalogData.productType}`);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      
      // Fetch fees using proportional scaling:
      // 1. Get Buy Box / listing reference price (for Fees API call)
      // 2. Scale fees proportionally to actual sale price
      let fees: { referralFee: number | null; fbaFee: number | null; closingFee: number | null; totalFees: number | null } = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null };
      let feesUnavailable = true;
      // STICKY: trust Amazon's current response when it actually includes
      // FulfillmentChannel (handles genuine FBA<->FBM switches), but when
      // Amazon's Orders API omits the field this pass — which happens
      // transiently, especially right around a seller converting an order to
      // self-fulfillment — fall back to the LAST CONFIRMED value on the row
      // instead of silently re-assuming FBA. Without this, an order correctly
      // identified as FBM on one sync could flip back to a phantom FBA fee
      // estimate on the very next sync just because Amazon's API was
      // momentarily ambiguous, re-adding a $10+ fee that was never actually
      // charged. See architecture-audit.md — FBM fee regression, confirmed
      // live 2026-08-07 on order 112-5948809-4229822. Declared here (not
      // inside the `if` below) so it's available for the `updateData` write
      // regardless of which branch actually fetched fees.
      const existingFulfillmentChannel = existingDbOrder?.fulfillment_channel || null;
      const enrichFulfillmentChannel = amazonOrder?.FulfillmentChannel || existingFulfillmentChannel || 'AFN';
      const isEnrichFbm = enrichFulfillmentChannel === 'MFN';

      if (soldPrice > 0 && asin !== 'UNKNOWN' && asin !== 'PENDING') {
        // Try to get a Buy Box reference price for better fee accuracy
        const { data: buyBoxCache } = await supabase
          .from('buy_box_cache')
          .select('price')
          .eq('asin', asin)
          .maybeSingle();
        
        // Use inventory's amazon_price as fallback reference
        let invAmazonPrice = 0;
        const { data: invData } = await supabase
          .from('inventory')
          .select('amazon_price')
          .eq('user_id', user.id)
          .eq('asin', asin)
          .maybeSingle();
        if (invData?.amazon_price) invAmazonPrice = invData.amazon_price;
        
        const referencePrice = buyBoxCache?.price || invAmazonPrice || soldPrice;

        const apiFees = await getProductFees(supabase, asin, referencePrice, accessToken, primaryMarketplaceId, soldPrice, fxRates, !isEnrichFbm);
        if (apiFees) {
          if (isEnrichFbm) {
            // FBM: Bundle ALL fees into fba_fee column (FBA/FBM), zero out referral/closing
            const totalFbmFees = apiFees.referralFee + apiFees.fbaFee + apiFees.closingFee;
            fees = { referralFee: 0, fbaFee: totalFbmFees, closingFee: 0, totalFees: totalFbmFees };
            console.log(`[LIVE_ORDERS] 💰 FBM enrichment fees for ${asin}: bundled $${totalFbmFees.toFixed(2)} into FBA/FBM column`);
          } else {
            fees = { referralFee: apiFees.referralFee, fbaFee: apiFees.fbaFee, closingFee: apiFees.closingFee, totalFees: apiFees.totalFees };
          }
          feesUnavailable = false;
          console.log(`[LIVE_ORDERS] 💰 Using ${isEnrichFbm ? 'FBM' : 'proportional'} API fees for ${asin} (enrichment, ref=$${referencePrice.toFixed(2)}, sale=$${soldPrice.toFixed(2)})`);
        } else {
          // API failed - fees are unavailable (NULL, not 0)
          fees = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null };
          feesUnavailable = true;
          console.log(`[LIVE_ORDERS] ⚠️ Fees UNAVAILABLE for ${asin} (enrichment, API failed) - will be NULL`);
        }
        // Small delay to avoid rate limits on Fees API
        await new Promise(resolve => setTimeout(resolve, 200));
      } else {
        // No price yet - fees are unavailable
        fees = { referralFee: null, fbaFee: null, closingFee: null, totalFees: null };
        feesUnavailable = true;
      }
      
      // Get shipping label cost for this order (FBM)
      const shippingLabelFee = shippingLabelCosts.get(orderId) || 0;
      const totalFeesWithShipping = fees.totalFees !== null ? fees.totalFees + shippingLabelFee : null;
      
      if (shippingLabelFee > 0) {
        console.log(`[LIVE_ORDERS] Enriching ${orderId} with FBM shipping label cost: $${shippingLabelFee.toFixed(2)}`);
      }
      
      // Update existing record with converted USD values
      // Also update order_status so we can detect status changes on next sync
      // Set price_source when we have a real price from GetOrderItems
      
      // Determine fees_source
      const feesSource = feesUnavailable ? 'unavailable' : 'fees_api';
      
      // Determine ROI source for accuracy tracking
      const hasActualPrice = priceCalcMode === 'orders_itemprice';
      const hasActualFees = !feesUnavailable;
      const hasActualCost = unitCost !== null && unitCost > 0;
      const computedRoiSource = hasActualPrice && hasActualFees && hasActualCost ? 'actual' : 
                               (hasActualPrice || hasActualFees || hasActualCost ? 'estimated' : 'unknown');
      
      // CRITICAL FIX: For non-US pending orders with Pricing API estimates,
      // store in estimated_price and set sold_price to 0 (same as new orders logic)
      const isEstimatedPrice = priceSource?.startsWith('estimated:') ||
        priceSource?.startsWith('pricing_api_') ||
        priceSource?.startsWith('listings_api_') ||
        priceSource?.startsWith('seller_derived:') ||
        priceSource?.startsWith('hint:') ||
        priceSource === 'snapshot_price' ||
        priceSource === 'order_total_pending' ||
        false;
      const actualSoldPrice = isEstimatedPrice ? 0 : soldPrice;
      const actualItemPrice = isEstimatedPrice ? 0 : (quantity > 0 ? itemPriceUSD / quantity : itemPriceUSD);
      const actualShippingPrice = isEstimatedPrice ? 0 : (quantity > 0 ? shippingPriceUSD / quantity : shippingPriceUSD);
      const actualTotalSaleAmount = isEstimatedPrice ? 0 : totalSaleAmount;
      
      const updateData: any = {
        asin,
        sku,
        seller_sku: sku, // SKU-level pricing: store seller_sku for accurate price matching
        title,
        image_url: imageUrl,
        quantity,
        sold_price: Math.round(actualSoldPrice * 100) / 100,
        item_price: Math.round(actualItemPrice * 100) / 100,
        shipping_price: Math.round(actualShippingPrice * 100) / 100,
        total_sale_amount: Math.round(actualTotalSaleAmount * 100) / 100,
        referral_fee: fees.referralFee !== null ? Math.round(fees.referralFee * 100) / 100 : null,
        fba_fee: fees.fbaFee !== null ? Math.round(fees.fbaFee * 100) / 100 : null,
        closing_fee: fees.closingFee !== null ? Math.round(fees.closingFee * 100) / 100 : null,
        shipping_label_fee: Math.round(shippingLabelFee * 100) / 100,
        total_fees: totalFeesWithShipping !== null ? Math.round(totalFeesWithShipping * 100) / 100 : null,
        unit_cost: unitCost ? Math.round(unitCost * 100) / 100 : 0,
        unit_cost_at_sale: unitCost ? Math.round(unitCost * 100) / 100 : null,
        cost_source_at_sale: costResolution.source,
        cost_locked: !!(unitCost && unitCost > 0),
        cost_locked_at: unitCost && unitCost > 0 ? new Date().toISOString() : null,
        marketplace,
        fulfillment_channel: enrichFulfillmentChannel, // AFN=FBA, MFN=FBM — sticky, see above
        order_status: currentAmazonStatus, // Track status changes for re-enrichment
        // NEW fields for debugging
        is_multi_item_order: isMultiItemOrder,
        price_calc_mode: priceCalcMode,
        roi_source: computedRoiSource,
        fees_source: feesSource,
        fees_missing: feesUnavailable, // NEW: Explicit flag for missing fees
        price_enrich_status: actualSoldPrice > 0 ? 'enriched' : 'pending',
      };

      // NEW: Store estimate for pending orders + tag confidence tier
      if (estimatedPrice && estimatedPrice > 0) {
        const existingLockedEstimate = Number(existingDbOrder?.locked_est_price || 0);
        if (existingLockedEstimate > 0) {
          updateData.estimated_price = Math.round(existingLockedEstimate * 100) / 100;
          updateData.locked_est_price = Math.round(existingLockedEstimate * 100) / 100;
          updateData.locked_from = existingDbOrder?.locked_from || 'previous_price_lock';
          updateData.price_source = existingDbOrder?.price_source || 'locked_estimate';
        } else {
          const roundedEstimate = Math.round(estimatedPrice * 100) / 100;
          updateData.estimated_price = roundedEstimate;
          updateData.locked_est_price = roundedEstimate;
          updateData.locked_from = priceSource || priceCalcMode || 'pending_enrichment';
          updateData.price_source = priceSource;
        }
        // Re-derive confidence from priceSource prefix
        if (priceSource?.startsWith('seller_derived:')) {
          updateData.price_confidence = 'HIGH_CONFIDENCE_PENDING';
        } else if (priceSource?.startsWith('hint:')) {
          updateData.price_confidence = 'LOW_CONFIDENCE_HINT';
        } else if (priceSource?.startsWith('listings_api_')) {
          // legacy tag still in flight
          updateData.price_confidence = 'HIGH_CONFIDENCE_PENDING';
        } else if (priceSource?.startsWith('pricing_api_')) {
          updateData.price_confidence = 'LOW_CONFIDENCE_HINT';
        }
        // Phase 3 (2026-06-02): every non-US estimate is provisional. Always keep
        // needs_price_enrich=true so reconcile-pending-prices / reconcile-intl-estimates
        // re-query Orders API once the real ItemPrice lands. Without this the row
        // can be frozen with a Listings-API estimate forever (see order
        // 702-4519782-1142614 audit).
        updateData.needs_price_enrich = true;
      } else if (soldPrice > 0) {
        updateData.price_source = priceSource || 'orders_itemprice_usd';
        updateData.price_confidence = 'CONFIRMED';
        // Real ItemPrice arrived — clear the enrichment flag.
        updateData.needs_price_enrich = false;
      }

      // Phase 2: own-BB capture + PROMOTION (enrichment path). Same safety as the new-insert
      // branch: only when no confirmed sold_price has arrived; never overwrites CONFIRMED rows.
      if (actualSoldPrice === 0) {
        try {
          const bbFields = await computeBbOwnEstimateFields(
            supabase,
            {
              userId: user.id,
              asin,
              marketplace,
              orderDateIso: amazonOrder?.PurchaseDate || new Date().toISOString(),
              fulfillmentChannel: amazonOrder?.FulfillmentChannel || null,
            },
            ((globalThis as any).__bbSellerIdCache ||= makeSellerIdCache()),
          );
          Object.assign(updateData, bbFields);
          const enrExactSnapshot = await getExactOrderSnapshotEstimate(supabase, user.id, orderId, asin, marketplace, fxRates);
          const exactSnapshotEstimate = enrExactSnapshot?.price ?? null;
          // See exactSnapshotIsLiveRead comment in captureMissingBbEstimateForOrders:
          // only pricing_api/orders_api snapshots are genuine live reads; an
          // 'inventory'-sourced snapshot just freezes whatever the local
          // inventory.price cache said at that moment, which can lag the true
          // live listing price.
          const enrExactSnapshotIsLiveRead = enrExactSnapshot !== null && (enrExactSnapshot.source === 'pricing_api' || enrExactSnapshot.source === 'orders_api');
          if (
            enrExactSnapshotIsLiveRead &&
            Math.abs(Number(updateData.estimated_price ?? estimatedPrice ?? existingDbOrder?.estimated_price ?? 0) - exactSnapshotEstimate!) > 0.001
          ) {
            updateData.estimated_price = exactSnapshotEstimate;
            updateData.locked_est_price = exactSnapshotEstimate;
            updateData.locked_from = 'seller_derived:snapshot';
            updateData.price_source = 'seller_derived:snapshot';
            updateData.price_confidence = 'HIGH_CONFIDENCE_PENDING';
            updateData.needs_price_enrich = true;
            updateData.price_enrich_status = 'pending';
            updateData.price_last_error = null;
            console.log(`🛡️ SNAPSHOT_ENRICH_RESTORED: ${orderId}/${asin} estimated_price -> ${exactSnapshotEstimate}`);
          }
          const enrSrc = String(updateData.price_source || priceSource || '').toLowerCase();
          const enrEst = Number(updateData.estimated_price ?? estimatedPrice ?? 0);
          const enrSellerDerived = enrExactSnapshotIsLiveRead || enrEst > 0 && (
            enrSrc.startsWith('snapshot_price') ||
            enrSrc.startsWith('repricer_') ||
            enrSrc.startsWith('order_total') ||
            enrSrc.startsWith('listings_api') ||
            enrSrc.startsWith('seller_derived:repricer') ||
            enrSrc.startsWith('seller_derived:order_total') ||
            enrSrc.startsWith('seller_derived:listings_api')
          );
          // See BB_PROMOTED_OVER_SOFT_ESTIMATE comment in captureMissingBbEstimateForOrders:
          // recent_sale and an inventory-backed seller_derived:snapshot are both
          // "soft" -- neither is tied to THIS order's actual live price, so a
          // qualified+owner-matched BB estimate anchored near order time outranks
          // them. This also correctly overrides the sticky-lock carry-forward above
          // (existingLockedEstimate), same as the exactSnapshotEstimate override
          // just above it.
          const enrIsSoftEstimate = !enrSellerDerived && enrEst > 0 && (
            enrSrc.startsWith('recent_sale') ||
            enrSrc.startsWith('seller_derived:recent') ||
            enrSrc.startsWith('seller_derived:snapshot')
          );
          const enrBbPromotes = enrIsSoftEstimate
            && bbFields.bb_estimate_qualified && bbFields.bb_estimate_owner_match
            && (bbFields.bb_estimate_price ?? 0) > 0
            && Math.abs((bbFields.bb_estimate_price ?? 0) - enrEst) > 0.001;
          if (enrBbPromotes) {
            updateData.estimated_price = bbFields.bb_estimate_price;
            updateData.locked_est_price = bbFields.bb_estimate_price;
            updateData.locked_from = 'bb_estimate:own_buybox';
            updateData.price_source = 'bb_estimate:own_buybox';
            updateData.price_confidence = 'HIGH_CONFIDENCE_PENDING';
            console.log(`🛡️ BB_PROMOTED_OVER_SOFT_ESTIMATE: ${orderId}/${asin} estimated_price ${enrEst} -> ${bbFields.bb_estimate_price} (${enrSrc} replaced by own-BB anchored near order time)`);
          } else if (bbFields.bb_estimate_qualified && (bbFields.bb_estimate_price ?? 0) > 0 && !enrSellerDerived && !enrIsSoftEstimate) {
            console.log(`🛡️ BB_ENRICH_CAPTURE_ONLY: ${orderId}/${asin} did not promote BB=$${bbFields.bb_estimate_price}; pending prices require seller-derived source`);
          } else if ((enrSellerDerived || enrIsSoftEstimate) && bbFields.bb_estimate_qualified) {
            console.log(`🛡️ BB_ENRICH_SKIPPED_SELLER_DERIVED: ${orderId}/${asin} kept ${enrSrc}=$${enrEst} over BB=$${bbFields.bb_estimate_price}`);
          }
        } catch (e: any) {
          console.warn(`[bbOwnEstimate] enrichment capture skipped for ${orderId}/${asin}: ${e?.message ?? e}`);
        }
      }

      const { error: updateSalesOrderError } = await supabase
        .from('sales_orders')
        .update(updateData)
        .eq('user_id', user.id)
        .eq('order_id', orderId);
      if (updateSalesOrderError) {
        console.error(`[LIVE_ORDERS] Error updating enriched order ${orderId}:`, updateSalesOrderError);
      } else {
        await ensureRepricerAssignmentFromSale(
          asin,
          sku,
          marketplace,
          amazonOrder?.FulfillmentChannel === 'MFN' ? 'FBM' : 'FBA'
        );
      }
      
      // Delete any PENDING placeholder rows for this order now that we have real ASIN
      if (asin && asin !== 'PENDING' && asin !== 'UNKNOWN') {
        const { count: deletedCount } = await supabase
          .from('sales_orders')
          .delete()
          .eq('user_id', user.id)
          .eq('order_id', orderId)
          .eq('asin', 'PENDING');
        
        if (deletedCount && deletedCount > 0) {
          console.log(`[LIVE_ORDERS] 🧹 Deleted PENDING placeholder for enriched order ${orderId}`);
        }
      }
    }
    
    // Insert new orders
    if (ordersToUpsert.length > 0) {
      console.log(`[LIVE_ORDERS] Inserting ${ordersToUpsert.length} new orders to database`);
      
      // STEP 5.1: Delete any PENDING placeholder rows for orders we're about to insert with real ASINs
      // This prevents duplicates where we have both asin='PENDING' and asin='B0...' for same order
      const ordersWithRealAsins = ordersToUpsert.filter(o => o.asin && o.asin !== 'PENDING');
      const orderIdsWithRealAsins = [...new Set(ordersWithRealAsins.map(o => o.order_id))];
      
      if (orderIdsWithRealAsins.length > 0) {
        const { error: deleteError, count: deletedCount } = await supabase
          .from('sales_orders')
          .delete()
          .eq('user_id', user.id)
          .eq('asin', 'PENDING')
          .in('order_id', orderIdsWithRealAsins);
        
        if (deleteError) {
          console.error('[LIVE_ORDERS] Error deleting PENDING placeholders:', deleteError);
        } else if (deletedCount && deletedCount > 0) {
          console.log(`[LIVE_ORDERS] 🧹 Deleted ${deletedCount} PENDING placeholder rows (replaced by real items)`);
        }
      }
      
      // STEP 5.1b: Mark new orders that need enrichment with retry flags (self-healing)
      // This allows scheduled cron jobs to pick up orders that fail initial enrichment
      const ordersNeedingEnrichmentFlags = ordersToUpsert
        .filter(o => o.asin && o.asin !== 'PENDING')
        .map(o => {
          const needsPrice = !o.sold_price || o.sold_price === 0;
          const needsFees = !o.total_fees || o.total_fees === 0;
          return {
            ...o,
            needs_price_enrich: needsPrice,
            needs_fee_enrich: needsFees,
            enrich_attempts: 0,
            next_enrich_after: (needsPrice || needsFees) ? new Date().toISOString() : null,
          };
        });
      
      const { error: upsertError } = await supabase
        .from('sales_orders')
        .upsert(ordersNeedingEnrichmentFlags, { onConflict: 'user_id,order_id,asin' });
      if (upsertError) {
        console.error('[LIVE_ORDERS] Error upserting sales orders:', upsertError);
      } else {
        for (const o of ordersWithRealAsins) {
          await ensureRepricerAssignmentFromSale(
            o.asin,
            o.seller_sku || o.sku,
            o.marketplace || 'US',
            o.fulfillment_channel === 'MFN' ? 'FBM' : 'FBA'
          );
        }
      }
      
      // ================================
      // STEP 5.1c: Capture Price Snapshots (ChatGPT corrections applied)
      // ================================
      // PURPOSE: Freeze the listing price at the MOMENT of order discovery so that:
      // - If you sell at $40 then change price to $50 and sell again, both are preserved
      // - Pending orders use snapshot price, not live inventory price
      // 
      // SOURCE PRIORITY:
      // 1. orders_api - item_price from GetOrderItems (best, actual transaction)
      // 2. pricing_api - listing price from Pricing API (estimate)
      // 3. inventory - fallback to inventory.price
      //
      // IMPORTANT: We capture ONCE only (insert with ON CONFLICT DO NOTHING)
      // This ensures the first observed price is permanently frozen.
      
      const snapshotsToInsert = ordersWithRealAsins.map(o => {
        // Determine what price to snapshot and its source
        let snapshotItemPrice: number | null = null;
        let snapshotShippingPrice: number = 0;
        let snapshotSource: string = 'inventory';
        let currencyCode: string = 'USD';
        let fxRateUsed: number | null = null;
        let inventoryPriceAtCapture: number | null = null;
        
        // Priority 1: Actual item_price from Orders API (separated from shipping)
        if (o.item_price && o.item_price > 0) {
          snapshotItemPrice = o.item_price;
          snapshotShippingPrice = o.shipping_price || 0;
          snapshotSource = 'orders_api';
          console.log(`[SNAPSHOT] ${o.order_id}/${o.asin}: Captured from orders_api - item=$${snapshotItemPrice}, shipping=$${snapshotShippingPrice}`);
        }
        // Priority 2: Estimated price (from Pricing API or order total estimate)
        else if (o.estimated_price && o.estimated_price > 0) {
          // GUARD: if the estimate came from a LOW-CONFIDENCE hint
          // (Keepa historical, competitor BB, pricing_api), prefer the
          // seller's own inventory.price when it exists. Otherwise we'd
          // freeze a competitor's price into the snapshot forever.
          const ps = String(o.price_source || '');
          const isLowHint = ps.startsWith('hint:') || ps.startsWith('pricing_api') || ps.includes('keepa');
          const invItem = inventoryMap.get(o.asin) || (o.sku ? inventoryMap.get(`sku:${o.sku}`) : null);
          const invPrice = invItem?.price ? parseFloat(invItem.price) : 0;
          const myPriceLocal = invItem?.my_price ? parseFloat(invItem.my_price) : 0;
          const sellerOwnPrice = invPrice > 0 ? invPrice : myPriceLocal;
          if (isLowHint && sellerOwnPrice > 0) {
            snapshotItemPrice = sellerOwnPrice;
            snapshotShippingPrice = 0;
            snapshotSource = 'inventory';
            inventoryPriceAtCapture = sellerOwnPrice;
            console.log(`[SNAPSHOT] ${o.order_id}/${o.asin}: Overrode low-confidence hint ($${o.estimated_price}) with seller inventory price $${sellerOwnPrice}`);
          } else {
            snapshotItemPrice = o.estimated_price;
            snapshotShippingPrice = 0;
            if (ps.startsWith('pricing_api')) snapshotSource = 'pricing_api';
            else if (ps.includes('order_total')) snapshotSource = 'orders_api';
            else snapshotSource = 'inventory';
            console.log(`[SNAPSHOT] ${o.order_id}/${o.asin}: Captured from ${snapshotSource} (estimated) - item=$${snapshotItemPrice}`);
          }
        }
        // Priority 3: Fallback to inventory.price at discovery time
        else {
          // Get inventory price for this ASIN (already loaded in inventoryMap)
          const invItem = inventoryMap.get(o.asin) || (o.sku ? inventoryMap.get(`sku:${o.sku}`) : null);
          const invPrice = invItem?.price ? parseFloat(invItem.price) : 0;
          inventoryPriceAtCapture = invPrice > 0 ? invPrice : null;
          
          if (invPrice > 0) {
            snapshotItemPrice = invPrice;
            snapshotSource = 'inventory';
            console.log(`[SNAPSHOT] ${o.order_id}/${o.asin}: Captured from inventory - item=$${snapshotItemPrice}`);
          } else {
            // No price available at discovery time - snapshot will be null
            console.log(`[SNAPSHOT] ${o.order_id}/${o.asin}: No price available to snapshot`);
          }
        }
        
        // Determine currency and FX rate. inventory.price (and any
        // inventory-derived value, including the low-confidence-hint
        // override above) is ALWAYS stored in USD regardless of marketplace
        // — only genuinely native-currency Amazon signals (pricing_api /
        // orders_api) should be tagged with the marketplace's native
        // currency. Tagging an inventory-sourced USD value as native
        // currency caused downstream consumers (asin_price_history, the
        // snapshot-backfill path in getExactOrderSnapshotEstimate) to divide
        // an already-USD value by the FX rate, silently corrupting the
        // result by the FX factor.
        const marketplace = o.marketplace || 'US';
        const marketplaceToCurrency: Record<string, string> = {
          'US': 'USD', 'CA': 'CAD', 'MX': 'MXN', 'BR': 'BRL'
        };
        const isNativeCurrencySource = snapshotSource === 'pricing_api' || snapshotSource === 'orders_api';
        currencyCode = isNativeCurrencySource ? (marketplaceToCurrency[marketplace] || 'USD') : 'USD';

        // If non-US and we have FX rates, record the rate used
        if (currencyCode !== 'USD' && fxRates && fxRates[currencyCode]) {
          fxRateUsed = fxRates[currencyCode];
        }
        
        return {
          user_id: user.id,
          order_id: o.order_id,
          asin: o.asin,
          seller_sku: o.sku || null,
          marketplace_id: o.marketplace === 'MX' ? 'A1AM78C64UM0Y8' :
                          o.marketplace === 'CA' ? 'A2EUQ1WTGCTBG2' :
                          o.marketplace === 'BR' ? 'A2Q3Y263D00KWC' : 'ATVPDKIKX0DER',
          snapshot_item_price: snapshotItemPrice,
          snapshot_shipping_price: snapshotShippingPrice,
          snapshot_price: snapshotItemPrice, // Legacy compatibility
          snapshot_source: snapshotSource,
          currency_code: currencyCode,
          currency: currencyCode, // Legacy compatibility
          fx_rate_used: fxRateUsed,
          inventory_price_at_capture: inventoryPriceAtCapture,
          captured_at: new Date().toISOString(),
        };
      }).filter(s => s.snapshot_item_price !== null); // Only insert if we have a price
      
      if (snapshotsToInsert.length > 0) {
        // Use INSERT with ON CONFLICT DO NOTHING to capture ONCE only
        // This ensures the first observed price is permanently frozen
        const { error: snapshotError } = await supabase
          .from('order_price_snapshots')
          .upsert(snapshotsToInsert, { 
            onConflict: 'user_id,order_id,asin',
            ignoreDuplicates: true // ON CONFLICT DO NOTHING
          });
        
        if (snapshotError) {
          console.error('[SNAPSHOT] Error inserting price snapshots:', snapshotError);
        } else {
          console.log(`[SNAPSHOT] ✓ Captured ${snapshotsToInsert.length} price snapshots for new orders`);
        }
      }
      
      // ================================
      // STEP 5.1d: Auto-capture Price History for new orders
      // ================================
      // PURPOSE: Build permanent price history timeline automatically when orders are discovered
      // This ensures Price History tool has data without requiring manual "Capture Now" clicks
      // 
      // We capture ONE history record per unique ASIN+marketplace (not per order)
      // to avoid flooding the history table with duplicate entries for the same moment
      
      const uniqueAsinMarketplaces = new Map<string, { asin: string; marketplace: string; price: number; currency: string }>();
      
      for (const snapshot of snapshotsToInsert) {
        const key = `${snapshot.asin}:${snapshot.marketplace_id}`;
        if (!uniqueAsinMarketplaces.has(key) && snapshot.snapshot_item_price) {
          uniqueAsinMarketplaces.set(key, {
            asin: snapshot.asin,
            marketplace: snapshot.marketplace_id === 'A1AM78C64UM0Y8' ? 'MX' :
                        snapshot.marketplace_id === 'A2EUQ1WTGCTBG2' ? 'CA' :
                        snapshot.marketplace_id === 'A2Q3Y263D00KWC' ? 'BR' : 'US',
            price: snapshot.snapshot_item_price,
            currency: snapshot.currency_code || 'USD',
          });
        }
      }
      
      if (uniqueAsinMarketplaces.size > 0) {
        const priceHistoryInserts = Array.from(uniqueAsinMarketplaces.values()).map(item => {
          // For non-USD, calculate USD equivalent
          const fxRate = fxRates?.[item.currency] || 1;
          const priceUsd = item.currency !== 'USD' ? item.price / fxRate : item.price;
          
          return {
            user_id: user.id,
            asin: item.asin,
            marketplace: item.marketplace,
            listing_price: item.price, // This is in local currency for non-US
            buybox_price: null, // We don't have buybox info from order discovery
            currency_code: item.currency,
            price_usd: Math.round(priceUsd * 100) / 100,
            fx_rate: item.currency !== 'USD' ? fxRate : null,
            source: 'order_discovery', // Distinguishes from manual 'pricing_api' captures
          };
        });
        
        // Use upsert with ignoreDuplicates to avoid errors if same ASIN captured recently
        // The unique constraint includes captured_at, so different timestamps will create new rows
        const { error: priceHistoryError } = await supabase
          .from('asin_price_history')
          .insert(priceHistoryInserts);
        
        if (priceHistoryError) {
          // Duplicate key errors are expected if price was just captured - log but don't fail
          if (priceHistoryError.code !== '23505') {
            console.error('[PRICE_HISTORY] Error inserting:', priceHistoryError);
          }
        } else {
          console.log(`[PRICE_HISTORY] ✓ Auto-captured ${priceHistoryInserts.length} price history records from new orders`);
        }
      }
      
      if (upsertError) {
        console.error('[LIVE_ORDERS] Upsert error:', upsertError);
      }
      
      // STEP 5.2: Auto-update inventory prices from new orders
      // Guards: 
      // 1. Only use item_price (excludes shipping) - NOT sold_price which may include shipping
      // 2. Only when item_price > 0 (never overwrite with 0)
      // 3. Only for quantity = 1 orders (multi-qty orders could distort unit price)
      // 4. Only for non-Pending orders where we have actual prices
      const priceUpdates = ordersWithRealAsins
        .filter(o => {
          const itemPrice = o.item_price ?? 0;
          const qty = o.quantity ?? 1;
          const status = o.order_status ?? 'Pending';
          // Only update from actual prices (not pending orders with 0)
          // Only use single-quantity orders for accurate unit price
          // Exclude Pending status where prices are often not yet confirmed
          return itemPrice > 0 && qty === 1 && status !== 'Pending';
        })
        .reduce((acc, o) => {
          // Use most recent price per ASIN (last order wins)
          // Use item_price which excludes shipping
          acc.set(o.asin, o.item_price!);
          return acc;
        }, new Map<string, number>());
      
      if (priceUpdates.size > 0) {
        // SKU-FIRST PRICING: Build SKU→price map for accurate inventory matching
        const skuPriceUpdates = ordersWithRealAsins
          .filter(o => {
            const itemPrice = o.item_price ?? 0;
            const qty = o.quantity ?? 1;
            const status = o.order_status ?? 'Pending';
            return itemPrice > 0 && qty === 1 && status !== 'Pending' && o.sku;
          })
          .reduce((acc, o) => {
            // Use SKU as primary key for multi-offer ASINs
            acc.set(o.sku!, { price: o.item_price!, asin: o.asin });
            return acc;
          }, new Map<string, { price: number; asin: string }>());
        
        // Fetch current inventory prices by SKU (preferred) and ASIN (fallback)
        const skusToCheck = Array.from(skuPriceUpdates.keys());
        const asinsToCheck = Array.from(priceUpdates.keys());
        
        const { data: currentInventory } = await supabase
          .from('inventory')
          .select('asin, sku, price')
          .eq('user_id', user.id)
          .or(`sku.in.(${skusToCheck.map(s => `"${s}"`).join(',')}),asin.in.(${asinsToCheck.map(a => `"${a}"`).join(',')})`);
        
        const currentPriceByAsin = new Map(
          (currentInventory || []).map(inv => [inv.asin, { price: inv.price ?? 0, sku: inv.sku }])
        );
        const currentPriceBySku = new Map(
          (currentInventory || []).filter(inv => inv.sku).map(inv => [inv.sku, inv.price ?? 0])
        );
        
        let updatedCount = 0;
        let skippedCount = 0;
        
        // Step 1: Update by SKU first (most accurate)
        for (const [sku, { price: newPrice, asin }] of skuPriceUpdates) {
          const oldPrice = currentPriceBySku.get(sku) ?? 0;
          const diff = Math.abs(newPrice - oldPrice);
          const pctDiff = oldPrice > 0 ? (diff / oldPrice) * 100 : 100;
          
          // Only update if difference >= $0.05 OR >= 1% to reduce churn
          if (diff < 0.05 && pctDiff < 1) {
            skippedCount++;
            continue;
          }
          
          const { error: priceUpdateError } = await supabase
            .from('inventory')
            .update({ 
              price: newPrice, 
              my_price: newPrice, // Also update my_price for consistency
              updated_at: new Date().toISOString() 
            })
            .eq('user_id', user.id)
            .eq('sku', sku);
          
          if (!priceUpdateError) {
            console.log(`[LIVE_ORDERS] ✓ Updated inventory.price by SKU ${sku} (ASIN ${asin}): $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)} (source: order_actual_sku)`);
            updatedCount++;
          }
        }
        
        // Step 2: Fallback to ASIN-based update for orders without SKU in skuPriceUpdates
        const updatedSkus = new Set(skuPriceUpdates.keys());
        for (const [asin, newPrice] of priceUpdates) {
          // Skip if we already updated this ASIN via SKU
          const invEntry = currentPriceByAsin.get(asin);
          if (invEntry?.sku && updatedSkus.has(invEntry.sku)) continue;
          
          const oldPrice = invEntry?.price ?? 0;
          const diff = Math.abs(newPrice - oldPrice);
          const pctDiff = oldPrice > 0 ? (diff / oldPrice) * 100 : 100;
          
          if (diff < 0.05 && pctDiff < 1) {
            skippedCount++;
            continue;
          }
          
          const { error: priceUpdateError } = await supabase
            .from('inventory')
            .update({ 
              price: newPrice, 
              my_price: newPrice,
              updated_at: new Date().toISOString() 
            })
            .eq('user_id', user.id)
            .eq('asin', asin);
          
          if (!priceUpdateError) {
            console.log(`[LIVE_ORDERS] ✓ Updated inventory.price by ASIN ${asin}: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)} (source: order_actual_asin_fallback)`);
            updatedCount++;
          }
        }
        
        if (updatedCount > 0 || skippedCount > 0) {
          console.log(`[LIVE_ORDERS] 💰 Price sync complete: ${updatedCount} updated, ${skippedCount} skipped (below threshold)`);
        }
      }
    }

    try {
      await captureMissingBbEstimateForOrders(
        supabase,
        supabaseUrl,
        supabaseKey,
        user.id,
        queryStartDate,
        queryEndDate,
        fxRates,
      );
    } catch (bbCaptureError: any) {
      console.warn('[LIVE_ORDERS] BB_CAPTURE_BACKFILL_FAILED:', bbCaptureError?.message || bbCaptureError);
    }

    // STEP 6: Re-fetch all orders from database to get complete data
    const { data: finalOrders } = await supabase
      .from('sales_orders')
      .select('order_id, asin, sku, title, image_url, quantity, sold_price, total_sale_amount, referral_fee, fba_fee, closing_fee, shipping_label_fee, total_fees, unit_cost, order_status, order_date, order_type')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .not('order_id', 'like', '%-REFUND%')
      .not('order_status', 'in', '("Canceled","Cancelled")')
      .gte('order_date', queryStartDate)
      .lte('order_date', queryEndDate)
      .order('order_date', { ascending: false });

    // Build response
    const liveOrders: LiveOrder[] = (finalOrders || []).map(o => ({
      orderId: o.order_id,
      asin: o.asin,
      sku: o.sku,
      title: o.title,
      imageUrl: o.image_url,
      quantity: o.quantity || 1,
      soldPrice: o.sold_price || 0,
      totalSaleAmount: o.total_sale_amount || 0,
      orderDate: o.order_date,
      orderStatus: o.order_status || 'Pending',
      orderType: (o as any).order_type || null,
      unitCost: o.unit_cost,
      referralFee: o.referral_fee || 0,
      fbaFee: o.fba_fee || 0,
      closingFee: o.closing_fee || 0,
      shippingLabelFee: o.shipping_label_fee || 0,
      totalFees: o.total_fees || 0,
    }));
    
    // Collect order items from NEW orders that need price+fee enrichment
    // SKU-FIRST: Include seller_sku for accurate multi-SKU scenarios (New/Used/Open Box)
    // Only include orders where sold_price=0 OR total_fees=0 (smart gating)
    interface NewOrderItem {
      order_id: string;
      asin: string;
      seller_sku: string | null;
    }
    const newOrderItems: NewOrderItem[] = [];
    const seenSkuKeys = new Set<string>();
    
    for (const order of liveOrders) {
      // Check if this order was newly added (in newOrderIds) and needs enrichment
      if (newOrderIds.includes(order.orderId) && order.asin && order.asin !== 'PENDING') {
        // Smart gating: Only add if it ACTUALLY needs enrichment
        const needsPrice = order.soldPrice === 0 || order.soldPrice === null;
        const needsFees = order.totalFees === 0 || order.totalFees === null;
        
        if (needsPrice || needsFees) {
          // Use SKU as the unique key (SKU-first architecture)
          const skuKey = order.sku ? `sku:${order.sku}` : `asin:${order.asin}`;
          if (!seenSkuKeys.has(skuKey)) {
            seenSkuKeys.add(skuKey);
            newOrderItems.push({
              order_id: order.orderId,
              asin: order.asin,
              seller_sku: order.sku || null,
            });
          }
        }
      }
    }
    
    console.log(`[LIVE_ORDERS] Returning ${liveOrders.length} orders (${newOrderIds.length} new, ${ordersNeedingEnrichment.length} enriched, ${newOrderItems.length} items for SKU-first auto-enrichment)`);

    // Inline BuyerInfo capture: kick backfill-customer-profiles fire-and-forget
    // so newly-inserted pending orders pick up buyer_id / buyer_email / buyer_name
    // and customer_profiles get refreshed without waiting on the periodic cron.
    if (newOrderIds.length > 0 && _currentUserId) {
      try {
        const kickUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/backfill-customer-profiles`;
        const kickKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        const kickPromise = fetch(kickUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${kickKey}` },
          body: JSON.stringify({ userId: _currentUserId, limit: Math.min(newOrderIds.length + 20, 100), emitHealthIssues: true }),
        }).catch((e) => console.warn('[LIVE_ORDERS] customer-profiles kick failed:', e?.message));
        const wu = (globalThis as any).EdgeRuntime?.waitUntil;
        if (wu) wu(kickPromise);
      } catch (e: any) {
        console.warn('[LIVE_ORDERS] customer-profiles kick threw:', e?.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orders: liveOrders,
      count: liveOrders.length,
      totalOrdersFromApi: amazonOrderIds.size,
      newOrdersAdded: newOrderIds.length,
      ordersEnriched: ordersNeedingEnrichment.length,
      buyBoxFallbacks: 0,
      newOrderItems, // SKU-first: {order_id, asin, seller_sku} for accurate enrichment
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[LIVE_ORDERS] Error:', error);
    return new Response(JSON.stringify({ 
      error: (error as Error).message || 'Unknown error',
      orders: [],
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
