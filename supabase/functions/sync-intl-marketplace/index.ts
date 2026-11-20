import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { getListingUnitCost } from "../_shared/cost-contract.ts";
import { resolveMinRoiEnabled } from "../_shared/min-roi-enabled.ts";

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

interface InventoryItem {
  sku: string;
  asin: string;
  available: number;
  reserved: number;
  inbound: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { user_id: userId, refresh_token: refreshToken, marketplace_id: marketplaceId, inventory_items: inventoryItems } = body as {
      user_id: string; refresh_token: string; marketplace_id: string; inventory_items: InventoryItem[];
    };

    if (!userId || !refreshToken) throw new Error('Missing user_id or refresh_token');

    const accessToken = await getLwaAccessToken(refreshToken);
    const internationalMarketplaces: Record<string, string> = {
      'A2EUQ1WTGCTBG2': 'CA', 'A1AM78C64UM0Y8': 'MX', 'A2Q3Y263D00KWC': 'BR',
    };
    let assignmentsCreated = 0;

    // Fetch auto-onboarding settings
    let autoSettings: any = null;
    const { data: autoData } = await supabase
      .from('user_settings')
      .select('auto_assign_enabled, auto_assign_rule_id, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_raise_roi_floor_us, auto_raise_roi_floor_ca, auto_raise_roi_floor_mx, auto_raise_roi_floor_br')
      .eq('user_id', userId)
      .maybeSingle();
    autoSettings = autoData;

    if (!autoSettings?.auto_assign_enabled) {
      const { data: firstRule } = await supabase.from('repricer_rules').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (firstRule) {
        autoSettings = {
          auto_assign_enabled: true, auto_assign_rule_id: firstRule.id,
          auto_minmax_enabled: true, auto_min_strategy: 'price_buffer', auto_max_strategy: 'price_buffer',
          auto_min_buffer_pct: 15, auto_max_buffer_pct: 30, auto_require_cost: true,
          auto_raise_roi_floor_us: false, auto_raise_roi_floor_ca: false, auto_raise_roi_floor_mx: false, auto_raise_roi_floor_br: false,
        };
      }
    }

    // Get rule's Min ROI settings. "Respect minimum ROI" is per marketplace,
    // so we keep the raw legacy flag + per-marketplace overrides here and
    // resolve the effective boolean per mktLabel at each point of use below.
    let ruleMinRoi: number | null = null;
    let ruleMinRoiEnabledLegacy = false;
    let ruleMinRoiEnabledOverrides: Record<string, boolean> = {};
    let ruleMinRoiOverrides: Record<string, number> = {};
    if (autoSettings?.auto_assign_rule_id) {
      const { data: ruleData } = await supabase.from('repricer_rules')
        .select('min_roi_enabled, min_roi_enabled_marketplace_overrides, min_roi, min_roi_percent, min_roi_marketplace_overrides')
        .eq('id', autoSettings.auto_assign_rule_id).maybeSingle();
      if (ruleData) {
        ruleMinRoiEnabledLegacy = ruleData.min_roi_enabled || false;
        if (ruleData.min_roi_enabled_marketplace_overrides && typeof ruleData.min_roi_enabled_marketplace_overrides === 'object') {
          ruleMinRoiEnabledOverrides = ruleData.min_roi_enabled_marketplace_overrides as Record<string, boolean>;
        }
        ruleMinRoi = ruleData.min_roi_percent || ruleData.min_roi || null;
        if (ruleData.min_roi_marketplace_overrides && typeof ruleData.min_roi_marketplace_overrides === 'object') {
          ruleMinRoiOverrides = ruleData.min_roi_marketplace_overrides as Record<string, number>;
        }
      }
    }

    // Get cost map
    const costMap = new Map<string, number>();
    if (autoSettings?.auto_minmax_enabled) {
      const allAsins = [...new Set(inventoryItems.map(i => i.asin).filter(Boolean))];
      if (allAsins.length > 0) {
        const { data: costData } = await supabase.from('created_listings').select('asin, cost, units, amount').eq('user_id', userId).in('asin', allAsins.slice(0, 500));
        for (const c of (costData || [])) {
          // Contract A via shared helper — never leaks TOTAL as UNIT.
          const uc = getListingUnitCost({ cost: c.cost, amount: c.amount, units: c.units });
          if (uc !== null && uc > 0) costMap.set(c.asin, uc);
        }
      }
    }

    // Check authorized marketplaces
    const { data: intlAuthorizations } = await supabase.from('seller_authorizations').select('marketplace_id').eq('user_id', userId);
    const authorizedIntl = (intlAuthorizations || []).map((a: any) => a.marketplace_id).filter((mid: string) => mid in internationalMarketplaces);

    if (authorizedIntl.length === 0) {
      return new Response(JSON.stringify({ assignmentsCreated: 0, message: 'No international authorizations' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const globalSellerId = Deno.env.get('SPAPI_SELLER_ID');
    if (!globalSellerId) {
      return new Response(JSON.stringify({ assignmentsCreated: 0, message: 'SPAPI_SELLER_ID not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const candidateItems = inventoryItems.filter(i => (i.available + i.reserved + i.inbound) > 0);
    const activeIntlStatuses = new Set(['ACTIVE', 'BUYABLE', 'DISCOVERABLE']);
    const mktCurrency: Record<string, string> = { 'A2EUQ1WTGCTBG2': 'CAD', 'A1AM78C64UM0Y8': 'MXN', 'A2Q3Y263D00KWC': 'BRL' };

    // ── Priority path: fetch US ASINs with active assignments to prioritize ──
    const usAssignedAsins = new Set<string>();
    let usFrom = 0;
    while (true) {
      const { data: usBatch } = await supabase.from('repricer_assignments').select('asin').eq('user_id', userId).eq('marketplace', 'US').eq('is_enabled', true)
        .order('id', { ascending: true })
        .range(usFrom, usFrom + 999);
      if (!usBatch?.length) break;
      for (const r of usBatch) usAssignedAsins.add(r.asin);
      if (usBatch.length < 1000) break;
      usFrom += 1000;
    }

    const NEW_CANDIDATE_LIMIT = 150; // was 30
    const TOTAL_CHECK_LIMIT = 200;   // was 60
    const BACKFILL_LIMIT = 50;       // was 30

    for (const mktId of authorizedIntl) {
      const mktLabel = internationalMarketplaces[mktId];
      try {
        // Get existing assignments for this marketplace
        const existingIntlSkus = new Set<string>();
        let existFrom = 0;
        while (true) {
          const { data: batch } = await supabase.from('repricer_assignments').select('sku').eq('user_id', userId).eq('marketplace', mktLabel)
            .order('id', { ascending: true })
            .range(existFrom, existFrom + 999);
          if (!batch?.length) break;
          for (const r of batch) existingIntlSkus.add(r.sku);
          if (batch.length < 1000) break;
          existFrom += 1000;
        }

        // Backfill existing with null status
        const { data: needsStatusBackfill } = await supabase.from('repricer_assignments').select('sku, asin').eq('user_id', userId).eq('marketplace', mktLabel).is('intl_listing_status', null).limit(BACKFILL_LIMIT);
        const backfillSkus = new Set((needsStatusBackfill || []).map((r: any) => r.sku));

        // ── Priority: US-assigned ASINs missing intl assignment come FIRST ──
        const allNewCandidates = candidateItems.filter(i => !existingIntlSkus.has(i.sku));
        const priorityCandidates = allNewCandidates.filter(i => usAssignedAsins.has(i.asin));
        const otherCandidates = allNewCandidates.filter(i => !usAssignedAsins.has(i.asin));
        const newCandidates = [...priorityCandidates, ...otherCandidates].slice(0, NEW_CANDIDATE_LIMIT);

        if (priorityCandidates.length > 0) {
          console.log(`[INTL] ${mktLabel}: ${priorityCandidates.length} US-priority ASINs queued first (of ${allNewCandidates.length} total new)`);
        }

        const needsCheck = [
          ...(needsStatusBackfill || []).map((r: any) => candidateItems.find(c => c.sku === r.sku) || { sku: r.sku, asin: r.asin }),
          ...newCandidates,
        ];

        if (needsCheck.length === 0) { console.log(`[INTL] ${mktLabel}: all verified`); continue; }

        const toCheck = needsCheck.slice(0, TOTAL_CHECK_LIMIT);
        const newAssignments: any[] = [];
        const statusUpdates: any[] = [];

        for (const item of toCheck) {
          try {
            const isBackfill = backfillSkus.has(item.sku);
            const listingResult = await callSpApi('GET', `/listings/2021-08-01/items/${globalSellerId}/${encodeURIComponent(item.sku)}`, accessToken, { marketplaceIds: mktId, includedData: 'offers,summaries' });
            const summaries = listingResult?.summaries || [];
            const summary = summaries.find((s: any) => s.marketplaceId === mktId) || summaries[0];
            const listingStatus = summary?.status || 'UNKNOWN';

            if (isBackfill) {
              const isEligible = activeIntlStatuses.has(listingStatus);
              const nowIso = new Date().toISOString();
              const suspendFields = !isEligible
                ? {
                    is_enabled: false,
                    manual_paused: false,
                    auto_suspended_reason: listingStatus === 'UNKNOWN' ? 'INTL_QTY_STALE' : 'LISTING_INACTIVE',
                    auto_suspended_at: nowIso,
                    auto_suspended_by: 'sync-intl-marketplace',
                    amazon_listing_state: listingStatus === 'UNKNOWN' ? 'UNKNOWN' : 'INACTIVE',
                    last_listing_check_at: nowIso,
                    last_disabled_by: 'sync-intl-marketplace',
                    last_disabled_reason: `Intl listing ${listingStatus} (${mktLabel})`,
                    last_disabled_at: nowIso,
                  }
                : { amazon_listing_state: 'ACTIVE', last_listing_check_at: nowIso };
              statusUpdates.push({ user_id: userId, asin: item.asin, sku: item.sku, marketplace: mktLabel, intl_listing_status: listingStatus, ...suspendFields });
            }

            if (activeIntlStatuses.has(listingStatus) && !isBackfill && !existingIntlSkus.has(item.sku)) {
              const assignmentObj: any = { user_id: userId, asin: item.asin, sku: item.sku, marketplace: mktLabel, is_enabled: false, intl_listing_status: listingStatus };
              if (autoSettings?.auto_assign_enabled && autoSettings.auto_assign_rule_id) {
                assignmentObj.rule_id = autoSettings.auto_assign_rule_id;
                assignmentObj.is_enabled = true;
                const ruleMinRoiEnabled = resolveMinRoiEnabled(
                  { min_roi_enabled: ruleMinRoiEnabledLegacy, min_roi_enabled_marketplace_overrides: ruleMinRoiEnabledOverrides },
                  mktLabel,
                );
                if (autoSettings.auto_minmax_enabled) {
                  const unitCost = costMap.get(item.asin);
                  let bufferMin: number | null = null;
                  if (autoSettings.auto_min_strategy === 'cost_buffer' && unitCost && unitCost > 0) {
                    bufferMin = Math.round(unitCost * (1 + autoSettings.auto_min_buffer_pct / 100) * 100) / 100;
                  }

                  // ROI-safe min
                  let roiSafeMin: number | null = null;
                  if (ruleMinRoiEnabled && unitCost && unitCost > 0) {
                    const effectiveRoi = ruleMinRoiOverrides[mktLabel] ?? ruleMinRoi;
                    if (effectiveRoi && effectiveRoi > 0) {
                      const cushionedRoi = effectiveRoi + 10;
                      const roiFloorPrice = (unitCost * (1 + cushionedRoi / 100) + 3.50) / (1 - 0.15);
                      roiSafeMin = Math.ceil(roiFloorPrice * 100) / 100;
                    }
                  }

                  // Use higher of buffer and ROI floor
                  assignmentObj.min_price = bufferMin;
                  if (roiSafeMin && (bufferMin === null || roiSafeMin > bufferMin)) {
                    assignmentObj.min_price = roiSafeMin;
                    console.log(`[INTL] 🛡️ ROI floor raised min for ${item.asin}/${mktLabel}: $${roiSafeMin}`);
                  }

                  if (autoSettings.auto_require_cost && (!unitCost || unitCost <= 0) && autoSettings.auto_min_strategy === 'cost_buffer') delete assignmentObj.min_price;
                }
              }
              newAssignments.push(assignmentObj);
            }

            // Cache listing price
            let listingPrice: number | null = null;
            let listingCurrency: string | null = null;
            if (listingResult?.offers && Array.isArray(listingResult.offers)) {
              for (const offer of listingResult.offers) {
                const val = parseFloat(offer.price?.amount || offer.price?.listingPrice?.amount || offer.listingPrice?.amount || offer.ourPrice?.amount || '0');
                if (val > 0) { listingPrice = val; listingCurrency = offer.price?.currency || null; break; }
              }
            }
            if (!listingPrice && summary?.price?.listingPrice?.amount) {
              listingPrice = summary.price.listingPrice.amount;
              listingCurrency = summary.price.listingPrice.currency || null;
            }
            if (listingPrice && listingPrice > 0) {
              await supabase.from('asin_my_price_cache').upsert({
                user_id: userId, asin: item.asin, marketplace_id: mktId, seller_sku: item.sku,
                my_price: listingPrice, currency: listingCurrency || mktCurrency[mktId] || 'USD',
                fetched_at: new Date().toISOString(), source: 'listings_api_sync',
                attempt_count: 0, last_error: null, next_retry_at: null,
              }, { onConflict: 'user_id,asin,marketplace_id,seller_sku' });
            }

            await new Promise(r => setTimeout(r, 400));
          } catch (checkErr: any) {
            if (checkErr.message?.includes('404') && backfillSkus.has(item.sku)) {
              const nowIso = new Date().toISOString();
              statusUpdates.push({
                user_id: userId, asin: item.asin, sku: item.sku, marketplace: mktLabel,
                intl_listing_status: 'NOT_FOUND',
                is_enabled: false,
                manual_paused: false,
                auto_suspended_reason: 'LISTING_NOT_FOUND',
                auto_suspended_at: nowIso,
                auto_suspended_by: 'sync-intl-marketplace',
                amazon_listing_state: 'NOT_FOUND',
                last_listing_check_at: nowIso,
                last_disabled_by: 'sync-intl-marketplace',
                last_disabled_reason: `Intl listing 404 NOT_FOUND (${mktLabel})`,
                last_disabled_at: nowIso,
              });
            }
          }
        }

        // Write status updates and new assignments
        if (statusUpdates.length > 0) {
          for (let b = 0; b < statusUpdates.length; b += 100) {
            await supabase.from('repricer_assignments').upsert(statusUpdates.slice(b, b + 100), { onConflict: 'user_id,sku,marketplace' });
          }
        }
        if (newAssignments.length > 0) {
          for (let b = 0; b < newAssignments.length; b += 100) {
            const { error } = await supabase.from('repricer_assignments').upsert(newAssignments.slice(b, b + 100), { onConflict: 'user_id,sku,marketplace', ignoreDuplicates: true });
            if (!error) assignmentsCreated += newAssignments.slice(b, b + 100).length;
          }
        }

        // Fetch FBA Inventory Summaries for quantities
        try {
          let nextToken: string | undefined;
          const qtyMap = new Map<string, { available: number; reserved: number; inbound: number }>();
          while (true) {
            const qtyParams: Record<string, string> = { marketplaceIds: mktId, details: 'true', granularityType: 'Marketplace', granularityId: mktId };
            if (nextToken) qtyParams.nextToken = nextToken;
            const invResult = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, qtyParams);
            for (const s of (invResult?.payload?.inventorySummaries || [])) {
              if (!s.asin) continue;
              const avail = s.totalFulfillableQuantity ?? s.fulfillableQuantity ?? 0;
              const res = s.reservedQuantity?.totalReservedQuantity ?? 0;
              const inb = (s.inboundShippedQuantity ?? 0) + (s.inboundReceivingQuantity ?? 0);
              const existing = qtyMap.get(s.asin);
              if (existing) { existing.available += avail; existing.reserved += res; existing.inbound += inb; }
              else qtyMap.set(s.asin, { available: avail, reserved: res, inbound: inb });
            }
            nextToken = invResult?.payload?.nextToken;
            if (!nextToken) break;
            await new Promise(r => setTimeout(r, 300));
          }

          const qtyEligibleSkus = new Set([...existingIntlSkus, ...newAssignments.map((a: any) => a.sku)]);
          const nowTs = new Date().toISOString();
          for (const item of candidateItems) {
            if (!qtyEligibleSkus.has(item.sku)) continue;
            const qty = qtyMap.get(item.asin) || { available: 0, reserved: 0, inbound: 0 };
            await supabase.from('repricer_assignments').upsert({
              user_id: userId, asin: item.asin, sku: item.sku, marketplace: mktLabel,
              intl_available: qty.available, intl_reserved: qty.reserved, intl_inbound: qty.inbound, intl_qty_fetched_at: nowTs,
            }, { onConflict: 'user_id,sku,marketplace' });
          }
        } catch (qtyErr: any) {
          console.error(`[INTL] ${mktLabel}: qty fetch error:`, qtyErr.message);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (mktErr: any) {
        console.error(`[INTL] Error syncing ${mktLabel}:`, mktErr.message);
      }
    }

    return new Response(JSON.stringify({ assignmentsCreated }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[INTL] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
