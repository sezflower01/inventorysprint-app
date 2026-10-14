import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { convertCurrency, getSellerHomeCurrency, getUsdToRate } from '../_shared/fx-utils.ts';
import { waitForApiToken } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── SP-API Auth (shared with calculate-roi) ──

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
}

async function signRequest(
  method: string, url: string, body: string, accessToken: string,
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname + parsed.search;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const enc = new TextEncoder();

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const payloadHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  const crHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crHash}`;

  const kDate = await hmac(`AWS4${awsSecretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, awsRegion);
  const kService = await hmac(kRegion, 'execute-api');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = Array.from(new Uint8Array(await hmac(kSigning, stringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'Content-Type': 'application/json',
  };
}

async function getLWAAccessToken(): Promise<string> {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing SP-API credentials');

  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`LWA token error: ${resp.status}`);
  return (await resp.json()).access_token;
}

// ── Marketplace config ──
const MKT: Record<string, { id: string; currency: string; endpoint: string }> = {
  US: { id: 'ATVPDKIKX0DER', currency: 'USD', endpoint: 'sellingpartnerapi-na.amazon.com' },
  CA: { id: 'A2EUQ1WTGCTBG2', currency: 'CAD', endpoint: 'sellingpartnerapi-na.amazon.com' },
  MX: { id: 'A1AM78C64UM0Y8', currency: 'MXN', endpoint: 'sellingpartnerapi-na.amazon.com' },
  BR: { id: 'A2Q3Y263D00KWC', currency: 'BRL', endpoint: 'sellingpartnerapi-na.amazon.com' },
};

// ── Call SP-API FeesEstimate at a specific price ──
interface LiveFees {
  referralFee: number;
  fbaFee: number;
  variableClosingFee: number;
  otherFees: number;
  totalFees: number;
}

async function fetchLiveFees(
  supabase: any, asin: string, price: number, accessToken: string, marketplace: string, maxRetries = 2,
): Promise<LiveFees | null> {
  const cfg = MKT[marketplace] || MKT.US;
  const url = `https://${cfg.endpoint}/products/fees/v0/items/${asin}/feesEstimate`;
  const body = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: cfg.id,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: cfg.currency, Amount: price } },
      Identifier: asin,
    },
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = await signRequest('POST', url, body, accessToken);
    await waitForApiToken(supabase, 'fees_api');
    const resp = await fetch(url, { method: 'POST', headers, body });

    if (resp.ok) {
      const data = await resp.json();
      const feeList = data.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList;
      if (!feeList) return null;

      let referralFee = 0, fbaFee = 0, variableClosingFee = 0, otherFees = 0;
      for (const f of feeList) {
        const amt = parseFloat(f.FeeAmount?.Amount || '0');
        if (f.FeeType === 'ReferralFee') referralFee = amt;
        else if (f.FeeType === 'FBAFees') fbaFee = amt;
        else if (f.FeeType === 'VariableClosingFee') variableClosingFee = amt;
        else otherFees += amt;
      }
      return { referralFee, fbaFee, variableClosingFee, otherFees, totalFees: referralFee + fbaFee + variableClosingFee + otherFees };
    }

    if (resp.status === 429 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      continue;
    }
    const errText = await resp.text();
    console.error(`[calculate-roi-floor] FeesEstimate ${resp.status}:`, errText);
    if (resp.status === 429) throw new Error('QUOTA_EXCEEDED');
    return null;
  }
  return null;
}

// ── Core: find the minimum price that achieves target ROI using live fees ──
// Iterates: estimate price → get live fees at that price → check ROI → adjust
async function findRoiFloor(
  supabase: any,
  asin: string,
  marketplace: string,
  localCost: number,
  targetRoiPercent: number,
  accessToken: string,
): Promise<{ minPrice: number; actualRoi: number; fees: LiveFees; iterations: number } | null> {
  // === ITERATIVE GUARANTEE ===
  // Contract: the returned min_price MUST verify at actualRoi >= targetRoiPercent
  // using the exact same fee snapshot used to compute it. We solve, verify and
  // return in ONE consistent path. Never round downward. No "tighter cent
  // below" optimization (that re-introduces solver/verifier drift).
  //
  // Algorithm:
  //   1. Algebraic initial estimate (round UP).
  //   2. Fetch live fees AT that price → compute actual ROI from the same snapshot.
  //   3. If actualRoi >= target → DONE, return that exact pair.
  //   4. Else re-estimate algebraically with the observed fee structure,
  //      round UP, force at least +$0.01 progress, and loop.
  //   5. If algebra stalls (rare — fee jumps non-monotonically), force a +1%
  //      bump (min +$0.05) and continue.
  //   6. Cap at MAX_ITERATIONS attempts; never return a candidate that fails
  //      verification — bail out with null instead so the caller can surface
  //      the error rather than save an under-target floor.

  let candidatePrice = Math.ceil(
    ((localCost * (1 + targetRoiPercent / 100) + 3.50) / 0.85) * 100,
  ) / 100;
  candidatePrice = Math.max(candidatePrice, 0.99);

  const MAX_ITERATIONS = 20;
  let lastFees: LiveFees | null = null;
  let lastRoi = -Infinity;
  let lastPrice = candidatePrice;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const fees = await fetchLiveFees(supabase, asin, candidatePrice, accessToken, marketplace);
    if (!fees) return null; // API failure — caller must surface

    const roi = localCost > 0
      ? ((candidatePrice - fees.totalFees - localCost) / localCost) * 100
      : 0;

    console.log(`[calculate-roi-floor] iter=${i} price=${candidatePrice.toFixed(2)} fees=${fees.totalFees.toFixed(2)} roi=${roi.toFixed(2)}% target=${targetRoiPercent}%`);

    // STRICT one-sided gate: must meet or exceed target. No downward tolerance.
    if (roi >= targetRoiPercent) {
      console.log(`[calculate-roi-floor] ✓ VERIFIED $${candidatePrice.toFixed(2)} → ROI ${roi.toFixed(2)}% (target ${targetRoiPercent}%, iter=${i + 1})`);
      return {
        minPrice: candidatePrice,
        actualRoi: parseFloat(roi.toFixed(2)),
        fees,
        iterations: i + 1,
      };
    }

    // ROI not met — re-estimate algebraically with ACTUAL fee components from
    // THIS price snapshot. Referral is proportional, the rest is fixed.
    const effectiveRefRate = candidatePrice > 0
      ? Math.min(0.50, Math.max(0.05, fees.referralFee / candidatePrice))
      : 0.15;
    const fixedFees = fees.fbaFee + fees.variableClosingFee + fees.otherFees;
    let newEstimate = (localCost * (1 + targetRoiPercent / 100) + fixedFees)
      / (1 - effectiveRefRate);
    let nextPrice = Math.ceil(newEstimate * 100) / 100;

    // Guarantee monotonic upward progress: at least +$0.01 every iteration.
    // If algebra didn't move us up (fee non-linearity, FBA tier change), force
    // a +1% bump (min +$0.05) so we converge instead of looping forever.
    const minProgress = Math.max(0.05, Math.round(candidatePrice * 0.01 * 100) / 100);
    if (nextPrice <= candidatePrice) {
      nextPrice = Math.round((candidatePrice + minProgress) * 100) / 100;
      console.log(`[calculate-roi-floor]   ↑ algebra stalled, forcing +${minProgress.toFixed(2)} bump → ${nextPrice.toFixed(2)}`);
    } else if (nextPrice - candidatePrice < 0.01) {
      nextPrice = Math.round((candidatePrice + 0.01) * 100) / 100;
    }

    lastFees = fees;
    lastRoi = roi;
    lastPrice = candidatePrice;
    candidatePrice = Math.max(nextPrice, 0.99);
  }

  // Exhausted iterations without meeting target. DO NOT save an under-target
  // floor — return null so apply-min-roi surfaces a clear error to the user.
  console.error(`[calculate-roi-floor] ✗ FAILED to converge in ${MAX_ITERATIONS} iters: lastPrice=${lastPrice.toFixed(2)} lastRoi=${lastRoi.toFixed(2)}% target=${targetRoiPercent}% (asin=${asin} mkt=${marketplace})`);
  return null;
}

// ── Edge function handler ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const {
      asin,
      marketplace = 'US',
      cost_usd,          // LEGACY name kept for backward compat — this is really "cost in seller home currency"
      cost_home,         // NEW explicit field: cost in seller's home currency
      target_roi_percent,
      user_id: requestedUserId,
    } = body;

    // Auth – accept user JWT OR internal service-to-service calls
    const authHeader = req.headers.get('Authorization');
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');

    let userId: string | null = null;

    if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
      if (!requestedUserId) throw new Error('Missing user_id for internal call');
      userId = requestedUserId;
      console.log(`[calculate-roi-floor] Internal service call for user ${userId}`);
    } else if (authHeader) {
      const userClient = createClient(
        supabaseUrl,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const token = authHeader.replace('Bearer ', '');
      const { data, error } = await userClient.auth.getClaims(token);
      if (error || !data?.claims?.sub) throw new Error('Unauthorized');
      userId = data.claims.sub;
    } else {
      throw new Error('No authorization header');
    }

    const sellerCost = cost_home ?? cost_usd;  // prefer new field, fall back to legacy
    if (!asin || sellerCost == null || target_roi_percent == null) {
      return new Response(
        JSON.stringify({ error: 'asin, cost (cost_home or cost_usd), and target_roi_percent are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    // Fetch the seller's home currency (defaults to USD for existing users)
    const homeCurrency = await getSellerHomeCurrency(supabase, userId!);
    const cfg = MKT[marketplace] || MKT.US;
    const targetCurrency = cfg.currency;

    // Convert seller cost from home currency → marketplace currency
    const { converted: localCost, fxRate } = await convertCurrency(
      sellerCost, homeCurrency, targetCurrency, supabase,
    );

    console.log(`[calculate-roi-floor] asin=${asin} mkt=${marketplace} cost_home=${sellerCost} (${homeCurrency}) localCost=${localCost.toFixed(2)} (${targetCurrency}) fxRate=${fxRate.toFixed(4)} targetROI=${target_roi_percent}%`);

    const accessToken = await getLWAAccessToken();
    const result = await findRoiFloor(supabase, asin, marketplace, localCost, target_roi_percent, accessToken);

    if (!result) {
      return new Response(
        JSON.stringify({ error: 'Could not calculate ROI floor — SP-API fees unavailable', asin }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[calculate-roi-floor] RESULT asin=${asin}: minPrice=${result.minPrice} actualRoi=${result.actualRoi}% iterations=${result.iterations}`);

    // Also update asin_fee_cache with the live fee data for future use.
    //
    // CURRENCY: the Fees API is asked in the MARKETPLACE's currency
    // (PriceToEstimateFees uses cfg.currency), so result.fees.fbaFee comes back
    // in MXN for Mexico, CAD for Canada, BRL for Brazil.
    // asin_fee_cache.fba_fee_fixed is contracted as USD -- the note in
    // calculate-roi states it -- and this wrote the native figure straight in.
    //
    // Measured 2026-10-14: 92 MX rows from this writer averaged $48.07 against
    // $4.35 from sp_api_live for the same marketplace, maximum $98.20. Those
    // are pesos sitting in a dollar column.
    //
    // The RATE is unaffected: referralFee and minPrice are both native, so the
    // ratio cancels. That is why this writer's referral percentages always
    // looked sane while its fees did not, and why only the fee is converted.
    const feeCurrency = MKT[marketplace]?.currency ?? 'USD';
    const feeFx = feeCurrency === 'USD' ? 1 : await getUsdToRate(supabase, feeCurrency);
    const effectiveRefRate = result.minPrice > 0 ? result.fees.referralFee / result.minPrice : 0.15;

    // If FX is unavailable, DO NOT WRITE. calculate-roi settled this already --
    // "SKIPPING cache upsert to avoid native-as-USD corruption" -- and falling
    // back to the native figure is precisely the bug being fixed here, just
    // reached by a different route. A missing row is recoverable; a peso in a
    // dollar column is not, because nothing downstream can tell.
    if (Number.isFinite(feeFx) && feeFx > 0) {
      await supabase.from('asin_fee_cache').upsert({
        user_id: userId,
        asin,
        marketplace,
        fba_fee_fixed: result.fees.fbaFee / feeFx,
        referral_rate: effectiveRefRate,
        fee_source: 'live_roi_floor',
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,asin,marketplace' });
    } else {
      console.warn(`[calculate-roi-floor] FX unavailable for ${feeCurrency}->USD; skipping fee cache upsert for ${asin}/${marketplace}`);
    }

    return new Response(
      JSON.stringify({
        asin,
        marketplace,
        min_price: result.minPrice,
        actual_roi: result.actualRoi,
        target_roi: target_roi_percent,
        fees: result.fees,
        fx_rate: fxRate,
        home_currency: homeCurrency,
        target_currency: targetCurrency,
        local_cost: parseFloat(localCost.toFixed(2)),
        iterations: result.iterations,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('[calculate-roi-floor] Error:', error);
    const status = (error as Error).message?.includes('QUOTA_EXCEEDED') ? 429 : 500;
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Failed to calculate ROI floor' }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
