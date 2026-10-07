// One-shot repair: re-derive estimated_price for pending/unverified sales_orders.
//
// Tier stack (highest → lowest confidence):
//   Tier A  seller_derived:repricer_action   repricer_price_actions.new_price
//                                             WHERE created_at <= purchase_ts
//   Tier B  seller_derived:snapshot          order_price_snapshots ≤ purchase_ts
//   Tier C  seller_derived:listings_api_<mp> SP-API Listings "price now" (last resort)
//
// Time anchoring:
//   Tiers A/B require an accurate purchase timestamp. When `purchase_timestamp_utc`
//   is NULL on the row, we re-fetch Orders API `GetOrder` once per order_id to
//   backfill it before resolving. Without a real purchase timestamp we cannot
//   Tier-A-anchor and the row falls through to Tier C, which is why oscillating
//   ASINs previously showed price-at-repair-time instead of price-at-purchase.
//
// Safety contract:
//  • NEVER touches CONFIRMED rows (price_confidence='CONFIRMED' OR sold_price>0
//    with price_source in ['orders_itemprice','financial_events']).
//  • NEVER overwrites an already-time-anchored row (see TIME_ANCHORED_SOURCES).
//    A row that Tier A wrote is protected from being re-stomped by Tier C on the
//    next cron tick.
//  • Only updates `estimated_price` + `price_source` + `price_calc_mode` +
//    `price_confidence` (+ `purchase_timestamp_utc` when backfilling). Does NOT
//    write sold_price / total_sale_amount.
//
// Invoke:
//   POST { user_id?: uuid, asin?: string, days?: number (default 7), dry_run?: bool }


import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── AWS SigV4 ────────────────────────────────────────────────────────────────
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message) as any);
}
async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const secretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${u.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, u.pathname, u.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': u.host,
  };
}

async function getLWAToken(refreshToken: string): Promise<string> {
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('LWA_CLIENT_ID')!,
      client_secret: Deno.env.get('LWA_CLIENT_SECRET')!,
    }),
  });
  if (!r.ok) throw new Error(`LWA ${r.status}`);
  return (await r.json()).access_token;
}

const MARKETPLACE_TO_ID: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};
const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  ATVPDKIKX0DER: 'USD',
  A2EUQ1WTGCTBG2: 'CAD',
  A1AM78C64UM0Y8: 'MXN',
  A2Q3Y263D00KWC: 'BRL',
};

async function getSellerListingPrice(
  sku: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string,
  fxRates: Record<string, number>,
): Promise<{ priceUsd: number | null; localPrice: number | null; currency: string }> {
  const currency = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
  const fxRate = fxRates[currency] || 1;
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=offers,summaries`;
  const headers = await signRequest('GET', url, '', accessToken);
  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    return { priceUsd: null, localPrice: null, currency };
  }
  const data = await resp.json();
  let localPrice: number | null = null;
  if (Array.isArray(data.offers)) {
    for (const offer of data.offers) {
      const raw = offer.price?.amount ?? offer.price?.listingPrice?.amount ?? offer.listingPrice?.amount ?? offer.ourPrice?.amount;
      const v = typeof raw === 'string' ? parseFloat(raw) : raw;
      if (v && v > 0) { localPrice = v; break; }
    }
  }
  if (!localPrice && Array.isArray(data.summaries)) {
    for (const s of data.summaries) {
      const v = s.price?.listingPrice?.amount ?? s.price?.amount;
      if (v && v > 0) { localPrice = v; break; }
    }
  }
  if (!localPrice && data.attributes?.purchasable_offer) {
    const po = data.attributes.purchasable_offer;
    if (Array.isArray(po)) {
      for (const p of po) {
        const v = p.our_price?.[0]?.schedule?.[0]?.value_with_tax;
        if (v && v > 0) { localPrice = v; break; }
      }
    }
  }
  if (!localPrice || localPrice <= 0) return { priceUsd: null, localPrice: null, currency };
  const priceUsd = currency === 'USD' ? localPrice : localPrice / fxRate;
  return { priceUsd, localPrice, currency };
}

// Fetch the true PurchaseDate for one order via SP-API Orders v0 GetOrder.
// Used to backfill sales_orders.purchase_timestamp_utc when NULL — without a
// real purchase timestamp, Tier A cannot time-anchor to price-at-purchase.
async function getOrderPurchaseDate(
  orderId: string,
  accessToken: string,
): Promise<string | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}`;
  try {
    const headers = await signRequest('GET', url, '', accessToken);
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    const pd = data?.payload?.PurchaseDate || data?.PurchaseDate;
    return pd ? new Date(pd).toISOString() : null;
  } catch { return null; }
}

// ── Time-anchored helpers ────────────────────────────────────────────────────
// Extracted to ./time-anchored.ts so the unit test imports the REAL
// implementations instead of maintaining an inline copy that can drift.
// See tier-a-time-anchoring_test.ts for the assertions covering these.
import {
  isAlreadyTimeAnchored,
  resolveTimeAnchoredPrice,
} from './time-anchored.ts';

// ── Batching cap for Orders-API GetOrder lookups ─────────────────────────────
// Every invocation of repair-pending-listings-price runs inside the 150s edge-
// function budget. getOrderPurchaseDate is a synchronous SP-API call (~200-400ms
// each including 250ms rate-limit sleep), so an uncapped first-run over
// hundreds of rows-missing-purchase_timestamp could exhaust the budget and
// leave later per-user groups unrepaired. Cap the number of order-timestamp
// backfills per invocation; remaining rows re-attempt on the next hourly tick.
const MAX_PURCHASE_TS_LOOKUPS_PER_RUN = 50;




// Sources that are considered "stale / fallback" and eligible for refresh.
const STALE_SOURCES = new Set([
  'snapshot_price',
  'seller_derived:snapshot',
  'snapshot_item_price',
  'inventory_refresh_forced',
  'hint:inventory',
  'hint:inventory_sku',
  'hint:inventory_asin',
  'hint:amazon_price',
  'hint:my_price',
  'hint:buy_box_cache',
  'hint:keepa_historical',
  'pricing_api',
  'estimate',
  // Pending-price fallbacks written by sync-sales-orders that may be stale
  // vs. Amazon's current featured price. See
  // .lovable/pending-sales-price-report.md §4-D.
  'estimated:asin_my_price_cache',
  'estimated:asin_my_price_cache_live',
  'estimated:inventory.price',
  'estimated:inventory.amazon_price',
  'estimated:inventory.my_price',
  'estimated:repricer_price_actions',
  'estimated:inventory.price_over_mypricecache',
  'estimated:seller_derived:repricer+inventory',
  '',
]);

function isStaleSource(ps: string | null | undefined): boolean {
  const s = String(ps || '').toLowerCase();
  if (STALE_SOURCES.has(s)) return true;
  if (s.startsWith('hint:')) return true;
  if (s.startsWith('keepa')) return true;
  if (s.startsWith('pricing_api')) return true;
  // startsWith, not equality: these sources carry suffixes. The currency
  // repair of 2026-10-07 writes 'seller_derived:snapshot:currency_repair',
  // and an exact match would have quietly excluded exactly the rows that
  // most need a better price later. Every other consumer of this string
  // already uses startsWith.
  if (s === 'snapshot_price' || s.startsWith('seller_derived:snapshot')) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    let body: any = {};
    try { body = await req.json(); } catch {}

    const userFilter: string | null = body?.user_id ? String(body.user_id) : null;
    const asinFilter: string | null = body?.asin ? String(body.asin) : null;
    const days: number = Math.max(1, Math.min(60, Number(body?.days ?? 7)));
    const dryRun: boolean = body?.dry_run === true;
    const onlyMarketplaces: string[] = Array.isArray(body?.marketplaces) && body.marketplaces.length > 0
      ? body.marketplaces.map((x: string) => String(x).toUpperCase())
      : ['US', 'CA', 'MX', 'BR'];

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Load FX rates once. Schema: fx_rates(base, quote, rate). For base='USD',
    // rate = local_per_usd (e.g. USD→BRL rate=5.37). getSellerListingPrice
    // converts priceUsd = localPrice / fxRate, so we want local_per_usd.
    const { data: fxRows } = await supabase
      .from('fx_rates')
      .select('base, quote, rate')
      .eq('base', 'USD');
    const fxRates: Record<string, number> = { USD: 1 };
    for (const r of (fxRows || [])) {
      const rate = Number((r as any).rate);
      const quote = String((r as any).quote || '').toUpperCase();
      if (quote && rate && rate > 0) fxRates[quote] = rate;
    }

    // Candidates: pending / unconfirmed rows.
    // Candidates: pending / unconfirmed rows.
    // NOTE: `.neq('price_confidence','CONFIRMED')` in PostgREST does NOT match
    // rows where price_confidence IS NULL (three-valued logic). We instead
    // fetch and filter in code so NULL-confidence pending rows are included.
    let q = supabase
      .from('sales_orders')
      .select('user_id, order_id, asin, sku, seller_sku, marketplace, quantity, estimated_price, sold_price, price_source, price_confidence, needs_price_enrich, order_date, purchase_timestamp_utc')
      .gte('order_date', cutoff)
      .in('marketplace', onlyMarketplaces)
      .limit(1000);
    if (userFilter) q = q.eq('user_id', userFilter);
    if (asinFilter) q = q.eq('asin', asinFilter);

    const { data: rows, error: fetchErr } = await q;
    if (fetchErr) throw fetchErr;

    const candidates = (rows || []).filter(r => {
      // Skip explicitly CONFIRMED rows (null passes through as pending).
      if (String(r.price_confidence || '') === 'CONFIRMED') return false;
      // Skip if already has a real Orders API / FEC confirmed price.
      const ps = String(r.price_source || '').toLowerCase();
      if (ps === 'orders_itemprice' || ps === 'financial_events') return false;
      if (Number(r.sold_price || 0) > 0 && !r.needs_price_enrich) return false;
      // NEW: Skip rows that are already time-anchored to purchase timestamp.
      // These came from fetch-live-orders Tier A/B (or a prior repair tick's
      // Tier A/B). Rewriting them with Listings-API-now would replace
      // price-at-purchase with price-at-repair — the defect this file fixes.
      if (isAlreadyTimeAnchored(r as any)) return false;
      // Only refresh stale sources.
      return r.needs_price_enrich || isStaleSource(r.price_source);
    });


    if (candidates.length === 0) {
      return new Response(JSON.stringify({
        ok: true, scanned: rows?.length ?? 0, candidates: 0, updated: 0, skipped: 0,
        message: 'No stale pending rows to repair',
        elapsed_ms: Date.now() - startedAt,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Group by user + marketplace.
    type Row = typeof candidates[number];
    const byUserMp = new Map<string, Row[]>();
    for (const r of candidates) {
      const key = `${r.user_id}::${(r.marketplace || 'US').toUpperCase()}`;
      const arr = byUserMp.get(key) || [];
      arr.push(r);
      byUserMp.set(key, arr);
    }

    let updated = 0;
    let skipped = 0;
    const details: any[] = [];

    // Global budget across all user/marketplace groups in this invocation.
    // See MAX_PURCHASE_TS_LOOKUPS_PER_RUN doc-comment above for rationale.
    let ptsLookupBudget = MAX_PURCHASE_TS_LOOKUPS_PER_RUN;
    let ptsLookupsSkippedForBudget = 0;


    for (const [key, group] of byUserMp.entries()) {
      const [userId, mp] = key.split('::');
      const mpId = MARKETPLACE_TO_ID[mp] || MARKETPLACE_TO_ID.US;

      // Resolve seller auth for this marketplace (fall back to any auth).
      const { data: auths } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id, selling_partner_id, seller_id')
        .eq('user_id', userId);
      if (!auths || auths.length === 0) { skipped += group.length; continue; }

      const auth = auths.find((a: any) => String(a.marketplace_id || '').toUpperCase().endsWith(mp)) || auths[0];
      const sellerId: string | null = (auth as any)?.selling_partner_id || (auth as any)?.seller_id || null;
      if (!auth?.refresh_token || !sellerId) { skipped += group.length; continue; }

      let token: string;
      try { token = await getLWAToken(auth.refresh_token); }
      catch (e) { console.warn(`[REPAIR] LWA failed for ${userId}/${mp}: ${(e as Error).message}`); skipped += group.length; continue; }

      // ── Pre-pass: backfill purchase_timestamp_utc via Orders API GetOrder
      // Dedupe by order_id (multi-item orders share PurchaseDate).
      // Capped by ptsLookupBudget (global across groups) to keep the function
      // within the 150s edge budget on first-runs over historical rows.
      const missingPts = [...new Set(
        group.filter(r => !r.purchase_timestamp_utc).map(r => r.order_id),
      )];
      const ptsByOrder = new Map<string, string>();
      for (const oid of missingPts) {
        if (ptsLookupBudget <= 0) {
          ptsLookupsSkippedForBudget++;
          continue;
        }
        ptsLookupBudget--;
        const pd = await getOrderPurchaseDate(oid, token);
        await new Promise(res => setTimeout(res, 250)); // rate-limit
        if (pd) {
          ptsByOrder.set(oid, pd);
          if (!dryRun) {
            await supabase
              .from('sales_orders')
              .update({ purchase_timestamp_utc: pd })
              .eq('user_id', userId)
              .eq('order_id', oid)
              .is('purchase_timestamp_utc', null);
          }
        }
      }

      // Patch in-memory rows with backfilled timestamps.
      for (const r of group) {
        if (!r.purchase_timestamp_utc && ptsByOrder.has(r.order_id)) {
          (r as any).purchase_timestamp_utc = ptsByOrder.get(r.order_id);
        }
      }

      // ── Tier A / Tier B pre-pass: resolve time-anchored price BEFORE any
      // Listings-API-now call. Rows resolved here are marked done and never
      // reach the Tier C SKU-dedup loop below.
      const tierCRemaining: Row[] = [];
      for (const r of group) {
        const anchored = await resolveTimeAnchoredPrice(supabase, r as any);
        if (!anchored) {
          tierCRemaining.push(r);
          continue;
        }
        const oldEst = Number(r.estimated_price || 0);
        const delta = oldEst > 0 ? Math.abs(anchored.price - oldEst) / oldEst : 1;
        if (dryRun) {
          details.push({
            order_id: r.order_id, asin: r.asin, marketplace: mp,
            old_estimated: oldEst, new_estimated: anchored.price,
            old_source: r.price_source, new_source: anchored.source,
            anchored_at: anchored.anchored_at,
            delta_pct: Math.round(delta * 1000) / 10,
            action: 'would_update_tier_ab',
          });
          continue;
        }
        const { error: updErr, count: updatedCount } = await supabase
          .from('sales_orders')
          .update({
            estimated_price: Math.round(anchored.price * 100) / 100,
            price_source: anchored.source,
            price_calc_mode: anchored.calc_mode,
            price_confidence: 'HIGH_CONFIDENCE_PENDING',
            needs_price_enrich: true, // still pending until Orders API / FEC settles
            last_enrich_at: new Date().toISOString(),
          }, { count: 'exact' })
          .eq('user_id', userId)
          .eq('order_id', r.order_id)
          .eq('asin', r.asin)
          .or('price_confidence.is.null,price_confidence.neq.CONFIRMED');
        if (updErr) {
          console.error(`[REPAIR] Tier-A/B update failed ${r.order_id}/${r.asin}: ${updErr.message}`);
          skipped++;
          continue;
        }
        if (!updatedCount || updatedCount === 0) {
          console.warn(`[REPAIR] Tier-A/B no-op: ${r.order_id}/${r.asin} (CONFIRMED race)`);
          skipped++;
          continue;
        }
        updated++;
        console.log(`[REPAIR] Tier-A/B ${r.order_id}/${r.asin} ${mp}: $${oldEst.toFixed(2)} → $${anchored.price.toFixed(2)} via ${anchored.source} (anchored ${anchored.anchored_at})`);
      }

      // Dedupe remaining Tier C rows by SKU to minimise SP-API calls.
      const skuMap = new Map<string, Row[]>();
      for (const r of tierCRemaining) {
        const sku = r.seller_sku || r.sku;
        if (!sku) { skipped++; continue; }
        const arr = skuMap.get(sku) || [];
        arr.push(r);
        skuMap.set(sku, arr);
      }


      for (const [sku, rs] of skuMap.entries()) {
        try {
          const live = await getSellerListingPrice(sku, sellerId, mpId, token, fxRates);
          await new Promise(res => setTimeout(res, 300)); // rate-limit
          if (!live.priceUsd || live.priceUsd <= 0) {
            skipped += rs.length;
            details.push({ user_id: userId, sku, marketplace: mp, status: 'no_live_price' });
            continue;
          }
          const isNonUs = mp !== 'US';
          const newEstimated = isNonUs ? (live.localPrice ?? live.priceUsd) : live.priceUsd;
          const newSource = `seller_derived:listings_api_${mp.toLowerCase()}`;

          for (const r of rs) {
            const oldEst = Number(r.estimated_price || 0);
            const delta = oldEst > 0 ? Math.abs(newEstimated - oldEst) / oldEst : 1;

            if (dryRun) {
              details.push({
                order_id: r.order_id, asin: r.asin, sku, marketplace: mp,
                old_estimated: oldEst, new_estimated: newEstimated,
                old_source: r.price_source, new_source: newSource,
                delta_pct: Math.round(delta * 1000) / 10,
                action: 'would_update',
              });
              continue;
            }

            // Safety guard: never overwrite CONFIRMED. Use `.or()` so rows
            // with price_confidence IS NULL (unset pending) still match —
            // PostgREST's `.neq('col','X')` excludes NULLs due to 3-value logic.
            const { error: updErr, count: updatedCount } = await supabase
              .from('sales_orders')
              .update({
                estimated_price: newEstimated,
                price_source: newSource,
                price_calc_mode: 'listings_api',
                price_confidence: 'HIGH_CONFIDENCE_PENDING',
                needs_price_enrich: true, // still pending until Orders API / FEC settles
                last_enrich_at: new Date().toISOString(),
              }, { count: 'exact' })
              .eq('user_id', userId)
              .eq('order_id', r.order_id)
              .eq('asin', r.asin)
              .or('price_confidence.is.null,price_confidence.neq.CONFIRMED');
            if (updErr) {
              console.error(`[REPAIR] Update failed ${r.order_id}/${r.asin}: ${updErr.message}`);
              skipped++;
              continue;
            }
            if (!updatedCount || updatedCount === 0) {
              console.warn(`[REPAIR] No-op: ${r.order_id}/${r.asin} (matched 0 rows — likely CONFIRMED)`);
              skipped++;
              continue;
            }
            updated++;
            console.log(`[REPAIR] ${r.order_id}/${r.asin} ${mp} SKU=${sku}: $${oldEst.toFixed(2)} → $${newEstimated.toFixed(2)} (Δ${(delta*100).toFixed(1)}%)`);
          }
        } catch (e) {
          console.warn(`[REPAIR] SKU ${sku} (${mp}) failed: ${(e as Error).message}`);
          skipped += rs.length;
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      scanned: rows?.length ?? 0,
      candidates: candidates.length,
      updated,
      skipped,
      dry_run: dryRun,
      details: dryRun ? details.slice(0, 1000) : undefined,
      purchase_ts_lookups: {
        cap_per_run: MAX_PURCHASE_TS_LOOKUPS_PER_RUN,
        used: MAX_PURCHASE_TS_LOOKUPS_PER_RUN - ptsLookupBudget,
        deferred_to_next_run: ptsLookupsSkippedForBudget,
      },
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (e) {
    console.error('[REPAIR] Fatal:', e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
