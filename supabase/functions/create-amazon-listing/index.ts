import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { mayUseOperatorCredentials, amazonNotConnectedResponse } from "../_shared/operator-credential-guard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ListingRequest {
  asin: string;
  sku: string;
  price: number;
  quantity: number;
  condition: string;
  fulfillmentChannel: string;
  cost?: number | null;
  mode?: 'VALIDATION_PREVIEW' | 'SUBMIT';
  marketplaceId?: string;
  marketplaceCode?: string;
  // Phase C2: id of the row in created_listings that we should mark
  // PENDING_VALIDATION + enqueue for FNSKU polling once Amazon ACCEPTS.
  createdListingId?: string | null;
}

Deno.serve(async (req) => {
  let requestBody: ListingRequest | null = null;
  let requestUserId: string | null = null;
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) throw new Error('Unauthorized');
    requestUserId = user.id;

    const body: ListingRequest = await req.json();
    requestBody = body;
    const mode = body.mode || 'SUBMIT';
    const failCreatedListing = async (code: string, reason: string, raw?: unknown) => {
      if (!(mode === 'SUBMIT' && body.createdListingId)) return;
      await supabase.from('created_listings').update({
        validation_status: 'FAILED_VALIDATION',
        validation_completed_at: new Date().toISOString(),
        validation_failure_code: code,
        validation_failure_reason: reason,
      }).eq('id', body.createdListingId).eq('user_id', user.id);
      await supabase.from('listing_validation_audit').insert({
        user_id: user.id,
        listing_id: body.createdListingId,
        asin: body.asin,
        sku: body.sku,
        marketplace: body.marketplaceCode || 'US',
        stage: 'amazon_create',
        status: 'blocked',
        reason,
        raw,
        source: 'create-amazon-listing',
      });
    };
    
    // Resolve marketplace — use requested or fall back to env default
    const targetMarketplaceId = body.marketplaceId || Deno.env.get('SPAPI_MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    const targetMarketplaceCode = body.marketplaceCode || 'US';
    
    // Resolve seller ID for the target marketplace
    const marketplaceSellerMap: Record<string, string> = {
      CA: Deno.env.get('SPAPI_SELLER_ID_CA') || '',
      MX: Deno.env.get('SPAPI_SELLER_ID_MX') || '',
      BR: Deno.env.get('SPAPI_SELLER_ID_BR') || '',
    };
    const globalSellerId = Deno.env.get('SPAPI_SELLER_ID');
    if (!globalSellerId) throw new Error('SPAPI_SELLER_ID not configured');
    const sellerId = marketplaceSellerMap[targetMarketplaceCode] || globalSellerId;

    // Resolve refresh token — try user-specific auth first, then fall back to global
    let refreshToken: string | null = null;
    
    // Try to find user's own authorization for this marketplace
    const { data: userAuth } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id')
      .eq('user_id', user.id)
      .eq('marketplace_id', targetMarketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    if (userAuth?.refresh_token) {
      refreshToken = userAuth.refresh_token;
      console.log('Using user-specific auth for marketplace:', targetMarketplaceCode);
    } else {
      // ⚠️ THIS BRANCH WRITES TO AMAZON ON THE OPERATOR'S ACCOUNT.
      //
      // The old comment called it "admin shared token", which was accurate and
      // was the problem: a signed-in user with no Amazon connection would
      // create a listing in the OPERATOR's Seller Central -- real inventory,
      // under the operator's SKUs, billed to the operator. Measured
      // 2026-11-12: of three accounts on this project, two have no SP-API, so
      // this was reachable.
      const may = await mayUseOperatorCredentials(supabase, {
        userId: user.id,
        internal: false, // the browser is the only caller
        fn: 'create-amazon-listing',
      });
      if (!may.allowed) return amazonNotConnectedResponse(may, corsHeaders);

      // Fall back to the operator's own refresh token.
      refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN') || null;
      // For EU marketplaces, try EU token
      const euMarkets = ['UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'TR', 'EG', 'SA', 'AE', 'IN'];
      if (euMarkets.includes(targetMarketplaceCode)) {
        refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN_EU') || refreshToken;
      }
      console.log('Using global auth for marketplace:', targetMarketplaceCode);
    }
    
    if (!refreshToken) throw new Error(`No SP-API refresh token available for marketplace ${targetMarketplaceCode}`);

    // Determine SP-API regional endpoint
    const euMarketsForHost = ['UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'TR', 'EG', 'SA', 'AE', 'IN'];
    const feMarketsForHost = ['JP', 'AU', 'SG'];
    let spApiHost = 'sellingpartnerapi-na.amazon.com';
    if (euMarketsForHost.includes(targetMarketplaceCode)) spApiHost = 'sellingpartnerapi-eu.amazon.com';
    if (feMarketsForHost.includes(targetMarketplaceCode)) spApiHost = 'sellingpartnerapi-fe.amazon.com';

    console.log('Create listing request:', { asin: body.asin, sku: body.sku, mode, marketplace: targetMarketplaceCode });

    // ── FBA eligibility hard gate ───────────────────────────────────────
    // For FBA submissions, the server must call the same central eligibility
    // function used by the web app and extension. No cached-only or silent
    // fallback behavior is allowed here.
    if (mode === 'SUBMIT' && String(body.fulfillmentChannel || '').toUpperCase() === 'FBA') {
      const eligibilityResult = await checkFbaEligibility({
        supabaseUrl,
        authHeader,
        asin: body.asin,
        marketplaceCode: targetMarketplaceCode,
        marketplaceId: targetMarketplaceId,
      });
      if (eligibilityResult?.eligible === false) {
        console.warn('[FBA_BLOCKED_CREATE_ATTEMPT]', body.asin, eligibilityResult);
        await failCreatedListing('FBA_ELIGIBILITY_BLOCKED', eligibilityResult.fba_block_reason || 'FBA blocked for this ASIN', eligibilityResult);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'FBA blocked for this ASIN',
            blockingIssues: eligibilityResult.blockingIssues || [],
            warnings: eligibilityResult.warnings || [],
            fba_block_reason: eligibilityResult.fba_block_reason || null,
            fba_blocked: true,
          }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const accessToken = await getAccessToken(refreshToken);

    const catalogInfo = await detectProductTypeFromCatalog({
      asin: body.asin,
      accessToken,
      marketplaceId: targetMarketplaceId,
      spApiHost,
    });

    const detectedProductType = catalogInfo?.productType ?? null;
    const detectedBrand = catalogInfo?.brand ?? null;

    // Check for generic brand — warn but don't block
    const isGenericBrand = detectedBrand
      ? /^(generic|unbranded|no brand|n\/a|none)$/i.test(detectedBrand.trim())
      : false;

    if (isGenericBrand) {
      console.warn('⚠ Generic brand detected:', detectedBrand);
    }

    const listingResult = await createListingViaSPAPI({
      asin: body.asin,
      sku: body.sku,
      price: body.price,
      quantity: body.quantity,
      condition: body.condition,
      fulfillmentChannel: body.fulfillmentChannel,
      accessToken,
      marketplaceId: targetMarketplaceId,
      sellerId,
      productType: detectedProductType,
      mode,
      spApiHost,
    });

    console.log('Listing response from SP-API:', listingResult);

    // Save validation result to listing_validations
    const issues = (listingResult as any)?.issues ?? [];
    const status = (listingResult as any)?.status ?? 'UNKNOWN';

    try {
      await supabase.from('listing_validations').insert({
        user_id: user.id,
        asin: body.asin,
        sku: body.sku,
        marketplace: targetMarketplaceCode,
        mode,
        status,
        issues_count: issues.length,
        issues,
        raw_response: listingResult,
      });
    } catch (saveErr) {
      console.warn('Failed to save validation history (non-fatal):', saveErr);
    }

    // Treat INVALID or non-ACCEPTED statuses as errors
    if (listingResult && typeof listingResult === 'object') {
      if (status && status !== 'ACCEPTED') {
        const errorMessages = Array.isArray(issues)
          ? issues
              .map((issue: any) => {
                const code = issue.code ? `[${issue.code}] ` : '';
                return `${code}${issue.message ?? 'Unknown issue'}`;
              })
              .join(' | ')
          : 'Listing was not accepted by Amazon.';

        console.error('Listing not accepted:', { status, issues });
        await failCreatedListing(`AMAZON_${status || 'NOT_ACCEPTED'}`, errorMessages, listingResult);

        return new Response(
          JSON.stringify({
            success: false,
            error: `Amazon did not accept the listing (status: ${status}). ${errorMessages}`,
            issues,
            status,
            mode,
            rawResponse: listingResult,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // ── PHASE C2: FBA listing → enqueue for FNSKU validation ────────────
    // The created_listings row was already inserted client-side as
    // PENDING_VALIDATION. Enqueue it so listing-validation-worker polls
    // SP-API Inventory Summaries until Amazon propagates an FNSKU, then
    // promotes the row to ACTIVE. On timeout it becomes FAILED_VALIDATION.
    if (
      mode === 'SUBMIT' &&
      String(body.fulfillmentChannel || '').toUpperCase() === 'FBA' &&
      status === 'ACCEPTED' &&
      body.createdListingId
    ) {
      try {
        await supabase.from('listing_validation_queue').upsert({
          listing_id: body.createdListingId,
          user_id: user.id,
          asin: body.asin,
          sku: body.sku,
          marketplace: targetMarketplaceCode,
          next_stage: 'await_fnsku',
          attempts: 0,
          next_run_at: new Date(Date.now() + 30_000).toISOString(), // 30s grace
        }, { onConflict: 'listing_id' });

        await supabase.from('listing_validation_audit').insert({
          user_id: user.id,
          listing_id: body.createdListingId,
          asin: body.asin,
          sku: body.sku,
          marketplace: targetMarketplaceCode,
          stage: 'enqueue',
          status: 'ok',
          reason: 'amazon_accepted_listing',
          source: 'create-amazon-listing@c2',
        });

        console.log(`[create-amazon-listing] Enqueued ${body.sku} for FNSKU validation`);
      } catch (qErr: any) {
        console.warn('[create-amazon-listing] Validation enqueue failed (non-fatal):', qErr?.message);
      }
    }

    // ── IMMEDIATE FBM INVENTORY INSERT ──────────────────────────────────
    // For FBM SUBMIT calls that Amazon accepted, write an `inventory` row right
    if (
      mode === 'SUBMIT' &&
      String(body.fulfillmentChannel || '').toUpperCase() === 'FBM' &&
      status === 'ACCEPTED'
    ) {
      try {
        const fbmRow: any = {
          user_id: user.id,
          asin: body.asin,
          sku: body.sku,
          fnsku: null,
          price: body.price,
          available: Math.max(Number(body.quantity) || 0, 0),
          reserved: 0,
          inbound: 0,
          unfulfilled: 0,
          source: 'amazon_sync_fbm',
          listing_status: 'ACTIVE',
          last_inventory_sync_at: new Date().toISOString(),
        };
        const { error: invErr } = await supabase
          .from('inventory')
          .upsert(fbmRow, { onConflict: 'user_id,sku' });
        if (invErr) {
          console.warn('[create-amazon-listing] Immediate FBM inventory upsert failed (non-fatal):', invErr.message);
        } else {
          console.log(`[create-amazon-listing] Immediate FBM inventory row written for ${body.sku}`);
        }
      } catch (invInsertErr: any) {
        console.warn('[create-amazon-listing] FBM inventory insert error:', invInsertErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        sku: body.sku,
        asin: body.asin,
        message: mode === 'VALIDATION_PREVIEW'
          ? 'Validation passed — no issues found'
          : 'Listing created successfully on Amazon',
        issues,
        status,
        mode,
        brand: detectedBrand,
        isGenericBrand,
        rawResponse: listingResult,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Create listing error:', error);
    if (requestBody?.createdListingId && requestUserId) {
      try {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        await supabase.from('created_listings').update({
          validation_status: 'FAILED_VALIDATION',
          validation_completed_at: new Date().toISOString(),
          validation_failure_code: 'CREATE_EXCEPTION',
          validation_failure_reason: (error as Error).message || 'Failed to create listing',
        }).eq('id', requestBody.createdListingId).eq('user_id', requestUserId);
      } catch (markErr) {
        console.warn('[create-amazon-listing] failed to mark created listing as failed:', markErr);
      }
    }
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Failed to create listing' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ── helpers ──────────────────────────────────────────────────────────

async function checkFbaEligibility(params: {
  supabaseUrl: string;
  authHeader: string;
  asin: string;
  marketplaceCode: string;
  marketplaceId: string;
}): Promise<any> {
  const res = await fetch(`${params.supabaseUrl}/functions/v1/check-fba-listing-eligibility`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
      Authorization: params.authHeader,
    },
    body: JSON.stringify({
      asin: String(params.asin || '').trim().toUpperCase(),
      marketplace: params.marketplaceCode,
      marketplaceId: params.marketplaceId,
      force: true,
    }),
  });

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `FBA eligibility check failed (${res.status})`);
  }
  return data;
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const lwaClientId = Deno.env.get('LWA_CLIENT_ID') ?? Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const lwaClientSecret = Deno.env.get('LWA_CLIENT_SECRET') ?? Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!lwaClientId || !lwaClientSecret) throw new Error('LWA credentials not configured');

  const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('LWA token error:', errorText);
    throw new Error(`Failed to get access token: ${errorText}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

async function detectProductTypeFromCatalog(params: {
  asin: string; accessToken: string; marketplaceId: string; spApiHost?: string;
}): Promise<{ productType: string | null; brand: string | null } | null> {
  const { asin, accessToken, marketplaceId, spApiHost = 'sellingpartnerapi-na.amazon.com' } = params;
  try {
    const path = `/catalog/2022-04-01/items/${asin}`;
    const queryParams = `marketplaceIds=${marketplaceId}&includedData=summaries,attributes`;
    const url = `https://${spApiHost}${path}?${queryParams}`;

    const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams, accessToken, spApiHost });
    if (!res.ok) { await res.text(); return null; }

    const data = await res.json();
    const pt = (data?.productTypes?.[0]?.productType || data?.summaries?.[0]?.productType || null) as string | null;
    
    // Extract brand from summaries or attributes
    let brand: string | null = null;
    if (data?.summaries?.[0]?.brand) {
      brand = data.summaries[0].brand;
    } else if (data?.attributes?.brand?.[0]?.value) {
      brand = data.attributes.brand[0].value;
    }
    
    if (pt) console.log('Detected productType:', pt);
    if (brand) console.log('Detected brand:', brand);
    
    return { productType: pt, brand };
  } catch (e) {
    console.warn('Catalog detection error (non-fatal):', e);
    return null;
  }
}

async function spApiSignedFetch(params: {
  method: string; url: string; path: string; queryParams: string; accessToken: string; bodyString?: string; spApiHost?: string;
}): Promise<Response> {
  const { method, url, path, queryParams, accessToken, bodyString, spApiHost } = params;
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  // Determine AWS region from SP-API host
  const hostToRegion: Record<string, string> = {
    'sellingpartnerapi-na.amazon.com': 'us-east-1',
    'sellingpartnerapi-eu.amazon.com': 'eu-west-1',
    'sellingpartnerapi-fe.amazon.com': 'us-west-2',
  };
  const host = spApiHost || 'sellingpartnerapi-na.amazon.com';
  const awsRegion = hostToRegion[host] || Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('AWS credentials not configured');
  const service = 'execute-api';
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const encoder = new TextEncoder();

  const canonicalHeaders = `host:${host}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payload = bodyString ?? '';
  const payloadHashHex = await sha256Hex(encoder.encode(payload));
  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  const canonicalRequestHashHex = await sha256Hex(encoder.encode(canonicalRequest));

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signatureHex = await hmacSha256Hex(signingKey, encoder.encode(stringToSign));
  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return await fetch(url, {
    method,
    headers: {
      Authorization: authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      host,
      ...(bodyString ? { 'content-type': 'application/json' } : {}),
    },
    ...(bodyString ? { body: bodyString } : {}),
  });
}

async function createListingViaSPAPI(params: {
  asin: string; sku: string; price: number; quantity: number; condition: string;
  fulfillmentChannel: string; accessToken: string; marketplaceId: string;
  sellerId: string; productType?: string | null; mode: string; spApiHost?: string;
}): Promise<any> {
  const { asin, sku, price, quantity, condition, fulfillmentChannel, accessToken, marketplaceId, sellerId, productType, mode, spApiHost = 'sellingpartnerapi-na.amazon.com' } = params;

  const conditionType = condition || 'new_new';
  
  // Resolve currency from marketplace
  const marketplaceCurrencies: Record<string, string> = {
    ATVPDKIKX0DER: 'USD', A2EUQ1WTGCTBG2: 'CAD', A1AM78C64UM0Y8: 'MXN',
    A2Q3Y263D00KWC: 'BRL', A1F83G8C2ARO7P: 'GBP', A1PA6795UKMFR9: 'EUR',
    A13V1IB3VIYZZH: 'EUR', APJ6JRA9NG5V4: 'EUR', A1RKKUPIHCS9HS: 'EUR',
    A1805IZSGTT6HS: 'EUR', A2NODRKZP88ZB9: 'SEK', A1C3SOZRARQ6R3: 'PLN',
    A39IBJ37TRP1C6: 'AUD', A1VC38T7YXB528: 'JPY', A21TJRUUN4KGV: 'INR',
    A19VAU5U5O7RUS: 'SGD', A2VIGQ35RCS4UG: 'AED', A17E79C6D8DWNP: 'SAR',
  };
  const currency = marketplaceCurrencies[marketplaceId] || 'USD';
  
  // Resolve fulfillment channel code based on region
  const naMarketplaces = ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'];
  const fulfillmentChannelCode = fulfillmentChannel === 'FBA'
    ? (naMarketplaces.includes(marketplaceId) ? 'AMAZON_NA' : 'AMAZON_EU')
    : 'DEFAULT';
  
  const requestBody: any = {
    productType: productType || 'PRODUCT',
    requirements: 'LISTING_OFFER_ONLY',
    attributes: {
      merchant_suggested_asin: [{ marketplace_id: marketplaceId, value: asin }],
      condition_type: [{ marketplace_id: marketplaceId, value: conditionType }],
      purchasable_offer: [{
        marketplace_id: marketplaceId, currency,
        our_price: [{ schedule: [{ value_with_tax: Number(price.toFixed(2)) }] }],
      }],
      fulfillment_availability: fulfillmentChannel === 'FBA'
        ? [{ marketplace_id: marketplaceId, fulfillment_channel_code: fulfillmentChannelCode }]
        : [{ marketplace_id: marketplaceId, fulfillment_channel_code: 'DEFAULT', quantity }],
      batteries_required: [{ marketplace_id: marketplaceId, value: 'no' }],
      supplier_declared_dg_hz_regulation: [{ marketplace_id: marketplaceId, value: 'not_applicable' }],
    },
  };

  // Add mode for validation preview
  if (mode === 'VALIDATION_PREVIEW') {
    requestBody.mode = 'VALIDATION_PREVIEW';
  }

  const path = `/listings/2021-08-01/items/${sellerId}/${sku}`;
  const queryParams = `marketplaceIds=${marketplaceId}&issueLocale=en_US`;
  const url = `https://${spApiHost}${path}?${queryParams}`;
  const bodyString = JSON.stringify(requestBody);

  console.log(`Creating listing (mode=${mode}) with PUT request to:`, url);

  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await spApiSignedFetch({ method: 'PUT', url, path, queryParams, accessToken, bodyString, spApiHost });
    const responseText = await res.text();
    lastStatus = res.status;
    lastBody = responseText;

    console.log(`SP-API response status (attempt ${attempt}/3):`, res.status);
    console.log('SP-API response body:', responseText);

    if (res.ok) return JSON.parse(responseText);

    const isInternal = res.status === 500 || res.status === 503;
    if (isInternal && attempt < 3) {
      const delayMs = 1500 * attempt;
      console.log(`Amazon internal error, retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    break;
  }

  throw new Error(`SP-API error (${lastStatus}): ${lastBody}`);
}

// ── crypto helpers ──────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data as any);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, data as any);
}

async function hmacSha256Hex(key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<string> {
  const sig = await hmacSha256(key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string) {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode('AWS4' + key), encoder.encode(dateStamp));
  const kRegion = await hmacSha256(kDate, encoder.encode(regionName));
  const kService = await hmacSha256(kRegion, encoder.encode(serviceName));
  return await hmacSha256(kService, encoder.encode('aws4_request'));
}
