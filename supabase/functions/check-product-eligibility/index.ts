import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { mayUseOperatorCredentials, amazonNotConnectedResponse } from "../_shared/operator-credential-guard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Helpers ───────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, options: any, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  }
}

async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, 12000);
      if ((response.status === 500 || response.status === 503) && attempt < maxRetries - 1) {
        await response.text();
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error;
      const msg = error?.message || '';
      if ((msg.includes('dns error') || msg.includes('timed out')) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('All retry attempts failed');
}

// ─── AWS SigV4 (native Web Crypto) ────────────────────────────────

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: string | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === 'string' ? enc.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
}

async function getSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return toHex(hash);
}

// ─── LWA token ─────────────────────────────────────────────────────

const tokenCache: Record<string, { token: string; expiresAt: number }> = {};

async function getLwaAccessToken(refreshTokenOverride?: string): Promise<string> {
  // Prefer LWA_CLIENT_ID over legacy SPAPI_ prefix per project routing rule.
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  const refreshToken = refreshTokenOverride || Deno.env.get('SPAPI_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing LWA credentials');

  const cacheKey = `NA-${refreshToken.slice(0, 10)}`;
  const cached = tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now()) return cached.token;

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
    const err = await response.text();
    throw new Error(`LWA token error: ${response.status} ${err}`);
  }

  const data = await response.json();
  tokenCache[cacheKey] = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

// ─── SP-API Restrictions call ──────────────────────────────────────

async function checkRestrictions(
  asin: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string,
): Promise<{ status: string; reasons: string[] }> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('Missing AWS credentials');

  const host = 'sellingpartnerapi-na.amazon.com';
  const path = '/listings/2021-08-01/restrictions';
  // Create Listing always creates New offers by default. Keep this check scoped
  // to New; otherwise Amazon may return restrictions for Used/Refurbished/
  // Collectible conditions and we incorrectly show "approval required" even
  // when Seller Central says "You can sell this product: New".
  const conditionType = 'new_new';
  const queryParams = `asin=${asin}&sellerId=${sellerId}&marketplaceIds=${marketplaceId}&conditionType=${conditionType}`;
  const url = `https://${host}${path}?${queryParams}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 'execute-api';
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = `GET\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${awsRegion}/${service}/aws4_request`;

  const requestHash = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = await getSigningKey(awsSecretAccessKey, dateStamp, awsRegion, service);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      'Authorization': authorizationHeader,
    },
  }, 10000);

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429) {
      return { status: 'THROTTLED', reasons: ['Rate limited'] };
    }
    return { status: 'ERROR', reasons: [`API error ${response.status}: ${errText.slice(0, 200)}`] };
  }

  const restrictionsData = await response.json();
  const restrictions = (restrictionsData?.restrictions || []).filter((restriction: any) =>
    isRestrictionForCondition(restriction, conditionType)
  );

  console.log(`[${asin}] Raw restrictions response:`, JSON.stringify(restrictionsData));

  if (restrictions.length === 0) {
    console.log(`[${asin}] No New-condition restrictions returned → APPROVED`);
    return {
      status: 'APPROVED',
      reasons: ['Amazon returned no listing restrictions for New condition.'],
    };
  }

  // FIX 1 (cont.): a restriction with no `links` is NOT "satisfied". Amazon
  // simply did not include a help URL. Treat any restriction the API returns
  // as a real signal that approval is required.
  let status = 'APPROVAL_REQUIRED';
  const reasons: string[] = [];

  for (const restriction of restrictions) {
    const reasonList = restriction?.reasons || [];
    for (const reason of reasonList) {
      const message = reason.message || reason.reasonCode || 'Unknown restriction';
      const reasonCode = (reason.reasonCode || '').toUpperCase();

      if (reasonCode === 'NOT_ELIGIBLE') {
        reasons.push(message);
        status = 'RESTRICTED';
        console.log(`[${asin}] NOT_ELIGIBLE restriction (hard block): ${message}`);
      } else {
        reasons.push(message);
        if (status !== 'RESTRICTED' && reasonCode === 'APPROVAL_REQUIRED') {
          status = 'APPROVAL_REQUIRED';
        } else if (status !== 'RESTRICTED') {
          // Unknown / generic reasonCode — still a real restriction
          status = 'APPROVAL_REQUIRED';
        }
        console.log(`[${asin}] Restriction: ${message} (code=${reasonCode || 'unknown'})`);
      }
    }
  }

  console.log(`[${asin}] Has restrictions → ${status}`);
  return { status, reasons };
}

function isRestrictionForCondition(restriction: any, requestedConditionType: string): boolean {
  const returnedCondition = String(restriction?.conditionType || '').trim().toLowerCase();
  if (returnedCondition && returnedCondition !== requestedConditionType) return false;

  // Defensive guard for Amazon responses that omit conditionType but describe
  // only Used/Refurbished/Collectible restrictions. Those must not block New.
  if (requestedConditionType === 'new_new') {
    const text = JSON.stringify(restriction || {}).toLowerCase();
    const mentionsOtherConditions = /\b(used|refurbished|collectible)\b/.test(text);
    const explicitlyMentionsNew = /\bnew\b/.test(text);
    if (mentionsOtherConditions && !explicitlyMentionsNew) return false;
  }
  return true;
}

// ─── Marketplace IDs ───────────────────────────────────────────────

const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

// ─── Main Handler ──────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();

    // Two callers, two auth shapes -- same pattern as find-source-candidates.
    //
    // The UI presents a user JWT. The auto-source cron has no session, so it
    // presents the internal secret and names the user it acts for. That path
    // exists because a restricted ASIN must be identified BEFORE a search is
    // spent on it, and the worker runs hours before anyone opens the page.
    //
    // Note verify_jwt stays true on this function (the browser calls it), so
    // an internal caller must ALSO send a service-role bearer to satisfy the
    // platform gateway -- see CLAUDE.md on the verify_jwt trap.
    const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const providedSecret = req.headers.get('x-internal-secret') || '';
    const isInternal = !!INTERNAL_SECRET && providedSecret === INTERNAL_SECRET;

    let user: { id: string } | null = null;
    if (isInternal) {
      const uid = String(body.userId || '').trim();
      if (!uid) {
        return new Response(JSON.stringify({ error: 'userId is required for internal calls' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      user = { id: uid };
    } else {
      const authHeader = req.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      user = authUser;
    }

    const marketplace = body.marketplace || 'US';
    const freshnessDays = body.freshness_days || 7;
    const forceRescan = body.force_rescan === true;
    // Accept explicit ASINs from the UI (from Product Finder search results)
    const requestedAsins: string[] = body.asins || [];

    const marketplaceId = MARKETPLACE_IDS[marketplace];
    if (!marketplaceId) {
      return new Response(JSON.stringify({ error: `Unsupported marketplace: ${marketplace}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Per-user, per-marketplace SP-API auth. Mirrors the working web Create
    // Listing path (fetch-listing-snapshot + check-fba-listing-eligibility).
    // Falls back to env-var seller only when the user has NO authorization row
    // for this marketplace at all.
    const { data: userAuth } = await supabase
      .from('seller_authorizations')
      .select('seller_id, refresh_token')
      .eq('user_id', user.id)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    // The comment further down already states the point of using the user's
    // own token: Amazon must answer "is THIS seller approved?". Without one we
    // fall back to the operator's seller, which answers for the wrong seller.
    // isInternal is passed through so the pg_cron caller
    // (20260928030000_check_unchecked_shipment_asin.sql) keeps working -- it
    // runs as the operator by design.
    if (!userAuth?.seller_id) {
      const may = await mayUseOperatorCredentials(supabase, {
        userId: user?.id ?? null,
        internal: isInternal,
        fn: 'check-product-eligibility',
      });
      if (!may.allowed) return amazonNotConnectedResponse(may, corsHeaders);
    }

    const sellerId = userAuth?.seller_id
      || Deno.env.get(`SPAPI_SELLER_ID_${marketplace}`)
      || Deno.env.get('SPAPI_SELLER_ID');
    if (!sellerId) {
      return new Response(JSON.stringify({ error: 'Seller ID not configured for this marketplace' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (requestedAsins.length === 0) {
      return new Response(JSON.stringify({
        error: 'No ASINs provided. Search for products first, then scan eligibility.',
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Use the user's own LWA refresh token when available so Amazon answers
    // "is THIS seller approved?" — not the platform's env-var seller.
    const accessToken = await getLwaAccessToken(userAuth?.refresh_token || undefined);
    console.log(`[check-product-eligibility] user=${user.id} mkt=${marketplace} sellerSource=${userAuth ? 'user_auth' : 'env_fallback'}`);

    const { data: maxBatch } = await supabase
      .from('user_approved_products')
      .select('batch_no')
      .eq('user_id', user.id)
      .eq('marketplace', marketplace)
      .order('batch_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextBatchNo = (maxBatch?.batch_no || 0) + 1;

    let eligibleCandidates = requestedAsins.map(asin => ({ asin }));
    // Cached results we want to surface back to the UI so already-known ASINs
    // get a status badge instead of being treated as "unknown / error".
    const cachedResults: { asin: string; status: string }[] = [];

    if (!forceRescan) {
      const freshnessDate = new Date();
      freshnessDate.setDate(freshnessDate.getDate() - freshnessDays);

      const { data: alreadyChecked } = await supabase
        .from('user_approved_products')
        .select('asin, approval_status')
        .eq('user_id', user.id)
        .eq('marketplace', marketplace)
        .in('asin', requestedAsins)
        .gte('checked_at', freshnessDate.toISOString());

      // Only trust cached APPROVED rows. Re-scan old non-approved rows because
      // prior logic could cache restrictions for Used/Refurbished/Collectible
      // and incorrectly block New listings.
      const checkedSet = new Set(
        (alreadyChecked || [])
          .filter((r: any) => String(r.approval_status || '').toLowerCase() === 'approved')
          .map((r: any) => r.asin)
      );
      for (const row of alreadyChecked || []) {
        if (String(row.approval_status || '').toLowerCase() === 'approved') {
          cachedResults.push({ asin: row.asin, status: row.approval_status });
        }
      }
      eligibleCandidates = requestedAsins
        .filter(asin => !checkedSet.has(asin))
        .map(asin => ({ asin }));
    }

    console.log(`[check-product-eligibility] Received ${requestedAsins.length} ASINs, ${cachedResults.length} cached, ${eligibleCandidates.length} to scan, forceRescan=${forceRescan}`);

    if (eligibleCandidates.length === 0) {
      return new Response(JSON.stringify({
        success: true, scanned: 0, approved: 0, restricted: 0, errors: 0, throttled: 0,
        batch_no: nextBatchNo,
        results: cachedResults,
        message: 'All provided products have been recently evaluated.',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let approvedCount = 0;
    let restrictedCount = 0;
    let errorCount = 0;
    let throttledCount = 0;
    let scannedCount = 0;
    const toInsert: any[] = [];

    for (const candidate of eligibleCandidates) {
      scannedCount++;

      try {
        let result = await checkRestrictions(candidate.asin, sellerId, marketplaceId, accessToken);

        if (result.status === 'THROTTLED') {
          throttledCount++;
          await new Promise(r => setTimeout(r, 2000));
          result = await checkRestrictions(candidate.asin, sellerId, marketplaceId, accessToken);
          if (result.status === 'THROTTLED') {
            throttledCount++;
            continue;
          }
        }

        const score = computeScore(candidate);
        toInsert.push({
          user_id: user.id,
          asin: candidate.asin,
          marketplace,
          approval_status: result.status.toLowerCase(),
          checked_at: new Date().toISOString(),
          score,
          batch_no: nextBatchNo,
          hidden: result.status !== 'APPROVED',
          saved: false,
        });
        if (result.status === 'APPROVED') approvedCount++;
        else restrictedCount++;

        if (scannedCount % 5 === 0) {
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        console.error(`Error checking ${candidate.asin}:`, err);
        errorCount++;
      }
    }

    if (toInsert.length > 0) {
      for (let i = 0; i < toInsert.length; i += 100) {
        const chunk = toInsert.slice(i, i + 100);
        const { error: upsertError } = await supabase
          .from('user_approved_products')
          .upsert(chunk, { onConflict: 'user_id,asin,marketplace' });
        if (upsertError) console.error('Upsert error:', upsertError);
      }
    }

    // Build per-ASIN results for the frontend (newly scanned + cached)
    const asinResults = [
      ...cachedResults,
      ...toInsert.map(r => ({ asin: r.asin, status: r.approval_status })),
    ];

    return new Response(JSON.stringify({
      success: true, scanned: scannedCount, approved: approvedCount,
      restricted: restrictedCount, errors: errorCount, throttled: throttledCount,
      batch_no: nextBatchNo,
      results: asinResults,
      message: `Found ${approvedCount} approved products out of ${scannedCount} checked.`,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('check-product-eligibility error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ─── Score computation ─────────────────────────────────────────────

function computeScore(candidate: any): number {
  let score = 50;
  if (candidate.amazon_on_listing === false) score += 20;
  const fba = candidate.fba_offer_count ?? 10;
  if (fba <= 2) score += 15;
  else if (fba <= 5) score += 10;
  else if (fba <= 10) score += 5;
  const sold = candidate.monthly_sold ?? 0;
  if (sold >= 100) score += 15;
  else if (sold >= 50) score += 10;
  else if (sold >= 20) score += 5;
  return Math.min(100, Math.max(0, score));
}
