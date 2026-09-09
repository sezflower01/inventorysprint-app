// Mobile Scan – Price History (time-series) + Live Offers via Keepa
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { detectIsFba } from "../_shared/fulfillment-channel.ts";
import {
  acquireKeepaTokensOnly, reportKeepaTokensLeft, recordKeepa429,
  KEEPA_COST, KEEPA_RESERVE, type KeepaSlotOptions,
} from "../_shared/keepa-rate-gate.ts";

import {
  KEEPA_EPOCH_MIN,
  KEEPA_EPOCH_MS_CONST,
  keepaMinToIso,
  summarizeCountSeries,
  computeBuyBoxOwnership,
} from "../_shared/plRiskSeries.ts";

/**
 * Claim a Keepa slot for an INTERACTIVE request.
 *
 * This function was completely ungated -- it called Keepa directly with no
 * awareness of the shared 5-tokens/min account budget, while being the single
 * most expensive caller in the app at 5 tokens per call. Measured 2026-08-17:
 * ~25 calls/day typical, but the bucket is only 300, so one browsing session
 * of ~60 product views empties it outright. That is exactly what happened
 * earlier that day -- tokens_left fell from 66 to 5.3 in eleven minutes and
 * the panel silently degraded to Amazon-only price history.
 *
 * Interactive style, matching seller-storefront-snapshot: wait briefly and
 * retry once rather than skipping. A background cron should skip and try again
 * later; a person waiting on a chart should queue, not be dropped.
 *
 * The reserve is respected by default, so a burst of panel views can no longer
 * eat into what repricer-sp-api-pricing depends on.
 */
// Moved to the TOKEN-ONLY lane 2026-08-19. This was the last interactive
// caller still claiming a Layer 1 call slot; its three siblings
// (mobile-scan-price-stability, asin-dimensions, analyzer-product-snapshot)
// moved earlier and this one was simply missed.
//
// It matters for 24/7 seller monitoring specifically. Layer 1 is 4 slots per
// minute, GLOBAL, with no notion of who is asking. Running the sweep all day
// means it claims those slots in tight bursts every five minutes, and a person
// waiting on a chart would queue behind it -- which is exactly the 2026-08-18
// 07:30 failure, and the reason the overnight window exists at all. A bigger
// Keepa plan does not help: Layer 1 counts calls, not tokens.
//
// Skipping Layer 1 is safe here for the same reason as the siblings: this is
// human-paced traffic, so the burst Layer 1 defends against is not its shape,
// and the token budget still bounds total spend.
async function acquireKeepaSlotWithRetry(supabase: any, options: KeepaSlotOptions = {}) {
  const first = await acquireKeepaTokensOnly(supabase, options);
  if (first.ok) return first;
  const waitMs = Math.min(first.waitSeconds, 15) * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return acquireKeepaTokensOnly(supabase, options);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Keepa CSV indices we care about
const IDX_AMAZON = 0;
const IDX_NEW = 1;
const IDX_SALES_RANK = 3;
const IDX_BUYBOX = 18;
const IDX_NEW_FBA = 10;
const IDX_NEW_FBM_SHIP = 7;
// COUNT_NEW — active new-condition offer count over time. Verified live
// 2026-07-14 against a real ASIN: stats.current[11]/avg[11]/min[11]/max[11]
// matched this index's own csv values exactly (small integers, no cents
// scaling). This is an OFFER count, not a guaranteed unique-seller count —
// one seller can occasionally hold multiple offers.
const IDX_COUNT_NEW = 11;

// US retail (ATVPDKIKX0DER) plus Amazon's per-region retail seller IDs —
// for many international marketplaces Amazon's own retail account uses the
// SAME id as the marketplace itself, unlike US where it differs. Synced
// from the more complete list already used in analyzer-product-snapshot —
// this file previously only had ATVPDKIKX0DER, which mislabeled Amazon as a
// third-party seller on every non-US marketplace.
const AMAZON_SELLER_IDS = new Set([
  'ATVPDKIKX0DER', // US
  'A1AM78C64UM0Y8', // MX
  'A1PA6795UKMFR9', // DE
  'A13V1IB3VIYZZH', // FR
  'A1F83G8C2ARO7P', // UK
  'APJ6JRA9NG5V4',  // IT
  'A1VC38T7YXB528', // JP
  // A2R2RITDJNW1Q6 — user-reported (2026-07-15), unverified by Keepa: this
  // ID returns empty from Keepa's /seller lookup in every marketplace and
  // has no public Amazon storefront (checked directly). That's consistent
  // with an internal/non-standard Amazon retail account rather than a real
  // third-party seller, which Keepa/Amazon's own storefront search would
  // normally have SOME record of. Also observed appearing as both an FBA
  // and an FBM offer at the identical price on the same ASIN — a pattern
  // that doesn't fit a normal reseller. Revisit if this turns out wrong.
  'A2R2RITDJNW1Q6',
]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Parse a CSV series [t,v,t,v,...]; returns ordered samples within last N days.
// Values are cents; -1 means no data.
//
// Keepa's CSV only records a new (t,v) pair when the value actually CHANGES,
// not one point per day — so a listing whose price/BSR has been stable for
// longer than the selected window has no points inside it at all, even
// though the true value is well known. Left unhandled, that produces a
// completely empty series (and an empty chart) for a perfectly stable
// listing. Carry the last known value from before the window forward as a
// single point at the window boundary so the chart still shows a flat line
// instead of nothing — only when the window itself is otherwise empty, so
// this never overrides real in-window history.
function parseSeries(csv: number[] | null | undefined, daysBack: number, isPrice = true) {
  if (!csv || csv.length < 2) return [] as { t: number; v: number }[];
  const cutoffMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN - daysBack * 24 * 60;
  const out: { t: number; v: number }[] = [];
  let lastBeforeWindow: { t: number; v: number } | null = null;
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i];
    const v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v === -1) continue;
    const value = isPrice ? v / 100 : v;
    if (t < cutoffMin) {
      // csv entries are chronological, so the last one seen before the
      // cutoff is the most recent value as of the window's start.
      lastBeforeWindow = { t, v: value };
      continue;
    }
    out.push({ t, v: value });
  }
  if (out.length === 0 && lastBeforeWindow) {
    out.push({ t: cutoffMin, v: lastBeforeWindow.v });
  }
  return out;
}

// Down-sample to ~1 point per day for the given window (lighter payload, smoother chart).
function downsample(samples: { t: number; v: number }[], daysBack: number) {
  if (samples.length === 0) return [];
  const buckets = Math.min(180, Math.max(30, daysBack));
  const bucketMin = Math.max(1, Math.floor((daysBack * 24 * 60) / buckets));
  const map = new Map<number, { sum: number; n: number; t: number }>();
  for (const s of samples) {
    const key = Math.floor(s.t / bucketMin);
    const b = map.get(key);
    if (b) { b.sum += s.v; b.n += 1; b.t = s.t; }
    else map.set(key, { sum: s.v, n: 1, t: s.t });
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ t: keepaMinToIso(b.t), v: b.sum / b.n }));
}

function appendCurrentPoint(series: { t: string; v: number }[], value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return series;
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const next = series.filter(p => p.t.slice(0, 10) !== today);
  next.push({ t: nowIso, v: value });
  return next.sort((a, b) => a.t.localeCompare(b.t));
}

// "Since Listed" range support. Keepa's `listedSince` (when the item was
// first listed on Amazon) and `trackingSince` (when Keepa itself started
// tracking the ASIN) are Keepa-minute timestamps returned on every product
// response at no extra token cost — no special parameter needed to get them.
// listedSince is preferred; it's 0/absent for some products, in which case
// trackingSince (always populated once Keepa knows the ASIN) is used instead.
// `maxDays` is the generous window we already requested from Keepa up front
// (see SINCE_LISTED_STATS_WINDOW_DAYS) — used as the fallback when neither
// field is usable, and as an upper clamp so a corrupt/ancient timestamp can't
// produce a nonsensical result.
export function computeSinceListedDays(
  listedSinceKeepaMin: number | null | undefined,
  trackingSinceKeepaMin: number | null | undefined,
  nowMs: number,
  maxDays: number,
): number {
  const listed = Number(listedSinceKeepaMin);
  const tracking = Number(trackingSinceKeepaMin);
  const raw = listed > 0 ? listed : tracking;
  if (!Number.isFinite(raw) || raw <= 0) return maxDays;

  const sinceMs = KEEPA_EPOCH_MS_CONST + raw * 60_000;
  const daysSince = Math.floor((nowMs - sinceMs) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(daysSince) || daysSince <= 0) return maxDays; // bad/future timestamp guard

  return Math.min(maxDays, Math.max(1, daysSince));
}

async function keepaErrorMessage(res: Response) {
  const txt = await res.text().catch(() => '');
  try {
    const j = JSON.parse(txt);
    return `Keepa HTTP ${res.status}: ${String(j?.error?.message || j?.error || j?.message || txt).slice(0, 240)}`;
  } catch { return `Keepa HTTP ${res.status}: ${txt.slice(0, 240)}`; }
}

const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
};
const REGION_ENDPOINTS: Record<string, string> = {
  US: 'https://sellingpartnerapi-na.amazon.com', CA: 'https://sellingpartnerapi-na.amazon.com',
  MX: 'https://sellingpartnerapi-na.amazon.com', BR: 'https://sellingpartnerapi-na.amazon.com',
};

async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 'execute-api');
  return await hmac(kService, 'aws4_request');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('LWA credentials not configured');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`LWA token error: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function signedSpApiFetch(url: string, accessToken: string): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  if (!awsAccessKeyId || !awsSecretKey) throw new Error('AWS credentials not configured');
  const urlObj = new URL(url);
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${urlObj.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = ['GET', urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, 'host;x-amz-access-token;x-amz-date', toHex(await sha256(''))].join('\n');
  const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signature = toHex(await hmac(await getSignatureKey(awsSecretKey, dateStamp, region), stringToSign));
  return fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      host: urlObj.host,
    },
  });
}

// AMAZON_SELLER_IDS only lists the US retail seller ID (ATVPDKIKX0DER) plus
// a placeholder literal — Amazon operates under DIFFERENT seller IDs per
// marketplace/region (and occasionally more than one within a marketplace),
// so that allowlist alone will always miss some. Keepa's own /seller lookup
// already returns the real business/storefront name — checking THAT closes
// the gap for any Amazon-operated seller ID we haven't hardcoded, instead of
// silently mislabeling it as a third-party seller.
function looksLikeAmazonName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^amazon(\.|,|\s|$)/i.test(name.trim());
}

async function resolveSellerNames(
  admin: any,
  keepaKey: string,
  domainId: number,
  marketplace: string,
  sellerIds: string[],
): Promise<Record<string, { name: string; isAmazon: boolean; rating: number | null; ratingCount: number | null }>> {
  const out: Record<string, { name: string; isAmazon: boolean; rating: number | null; ratingCount: number | null }> = {};
  if (sellerIds.length === 0) return out;
  const unique = Array.from(new Set(sellerIds.filter(Boolean)));

  // Amazon shortcut — Amazon retail doesn't carry a third-party feedback rating.
  for (const id of unique) {
    if (AMAZON_SELLER_IDS.has(id)) out[id] = { name: 'Amazon.com', isAmazon: true, rating: null, ratingCount: null };
  }

  // Cache lookup
  const { data: cached } = await admin
    .from('keepa_seller_name_cache')
    .select('seller_id, business_name, storefront_name, is_amazon, current_rating, current_rating_count, expires_at')
    .in('seller_id', unique)
    .eq('marketplace', marketplace);
  const now = Date.now();
  const fresh = new Set<string>();
  for (const row of (cached || []) as any[]) {
    const valid = row.expires_at && new Date(row.expires_at).getTime() > now;
    // Populate `out` from EVERY cached row, not just unexpired ones. A
    // business name we already know (even a week stale) is strictly more
    // useful than the raw seller ID the UI falls back to — and the Keepa
    // /seller endpoint is a shared per-account token bucket, so a burst of
    // other lookups can leave it 429'ing for minutes at a time. Below, the
    // live re-fetch for `missing` (stale or never-cached) IDs will
    // overwrite this with fresh data when it succeeds; when it 429s/fails,
    // this stale name is what keeps showing instead of silently reverting
    // to the seller ID.
    const nm = row.business_name || row.storefront_name || null;
    out[row.seller_id] = {
      name: nm || row.seller_id,
      // Re-check the name even for rows cached before this fix existed —
      // those were written with is_amazon=false for any seller ID outside
      // AMAZON_SELLER_IDS, regardless of what Keepa's name actually said.
      isAmazon: !!row.is_amazon || looksLikeAmazonName(nm),
      rating: Number.isFinite(row.current_rating) ? row.current_rating : null,
      ratingCount: Number.isFinite(row.current_rating_count) ? row.current_rating_count : null,
    };
    if (valid) {
      // Rows written before the rating feature shipped have BOTH rating
      // fields null (the columns didn't exist yet) — don't count those as
      // "fresh", or every existing cached seller would show no rating until
      // its 7-day TTL naturally expires. Force one re-fetch to backfill;
      // once a row genuinely has (or Keepa confirms it has none) rating
      // data, it behaves normally again.
      const hasRatingData = row.current_rating != null || row.current_rating_count != null;
      if (hasRatingData) fresh.add(row.seller_id);
    }
  }

  const missing = unique.filter(id => !fresh.has(id) && !AMAZON_SELLER_IDS.has(id));
  if (missing.length === 0) return out;

  // Batch in groups of 100 (Keepa /seller supports comma-separated)
  const upserts: any[] = [];
  for (let i = 0; i < missing.length; i += 100) {
    const slice = missing.slice(i, i + 100);
    const url = new URL('https://api.keepa.com/seller');
    url.search = new URLSearchParams({
      key: keepaKey,
      domain: String(domainId),
      seller: slice.join(','),
    }).toString();

    // Retry transient failures (429 rate-limit, timeout, network blip) before
    // giving up — a single failed attempt here previously meant every seller
    // ID in the batch fell straight back to displaying its raw ID with no
    // second chance, even though Keepa's /seller endpoint is a shared
    // per-account token bucket that routinely 429s under burst load.
    const MAX_ATTEMPTS = 3;
    let json: any = null;
    let lastErrorMsg = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url.toString(), { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          json = await res.json();
          break;
        }
        lastErrorMsg = await keepaErrorMessage(res);
        console.warn(`[mobile-scan-price-history] seller lookup attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastErrorMsg);
      } catch (e) {
        lastErrorMsg = (e as Error).message;
        console.warn(`[mobile-scan-price-history] seller fetch attempt ${attempt}/${MAX_ATTEMPTS} error:`, lastErrorMsg);
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 600));
      }
    }
    if (!json) {
      console.error(`[mobile-scan-price-history] seller lookup exhausted ${MAX_ATTEMPTS} attempts:`, lastErrorMsg);
      continue;
    }
    const sellers = json?.sellers || {};
    for (const id of slice) {
      const s = sellers[id];
      const business = s?.sellerName || s?.businessName || null;
      const storefront = s?.storefrontName || s?.sellerName || null;
      const isAmazon = AMAZON_SELLER_IDS.has(id) || looksLikeAmazonName(business) || looksLikeAmazonName(storefront);
      const display = isAmazon ? (business || storefront || 'Amazon.com') : (business || storefront || id);
      // currentRating is 0-100 (% positive feedback); currentRatingCount is
      // the seller's lifetime rating count. Both come from this SAME Keepa
      // /seller call already being made for the name — no extra API cost.
      const rating = Number.isFinite(s?.currentRating) ? s.currentRating : null;
      const ratingCount = Number.isFinite(s?.currentRatingCount) ? s.currentRatingCount : null;
      out[id] = { name: display, isAmazon, rating, ratingCount };
      upserts.push({
        seller_id: id,
        marketplace,
        business_name: business,
        storefront_name: storefront,
        is_amazon: isAmazon,
        current_rating: rating,
        current_rating_count: ratingCount,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  }

  if (upserts.length > 0) {
    await admin.from('keepa_seller_name_cache').upsert(upserts, { onConflict: 'seller_id,marketplace' });
  }
  return out;
}

async function fetchLiveSpApiOffers(
  admin: any,
  keepaKey: string,
  domainId: number,
  userId: string,
  asin: string,
  marketplace: string,
) {
  const marketplaceId = MARKETPLACE_IDS[marketplace] || MARKETPLACE_IDS.US;
  const endpoint = REGION_ENDPOINTS[marketplace] || REGION_ENDPOINTS.US;
  const { data: authRows, error } = await admin
    .from('seller_authorizations')
    .select('refresh_token, seller_id, selling_partner_id, marketplace_id')
    .eq('user_id', userId);
  if (error || !authRows?.length) return null;
  const sellerAuth: any = authRows.find((a: any) => a.marketplace_id === marketplaceId) || authRows[0];
  const selfSellerIds = new Set([sellerAuth.seller_id, sellerAuth.selling_partner_id].filter(Boolean));
  const { data: inventoryRows } = await admin
    .from('inventory')
    .select('fnsku, available, reserved, inbound, source')
    .eq('user_id', userId)
    .eq('asin', asin)
    .limit(5);
  const hasLiveFbmInventory = (inventoryRows || []).some((row: any) =>
    row.source === 'amazon_sync_fbm'
    && (Number(row.available || 0) > 0 || Number(row.reserved || 0) > 0),
  );
  // Does the same ASIN ALSO carry live FBA stock? Added 2026-09-08, when this
  // became possible: auto-assign-bulk now dedups on (asin, channel) rather than
  // asin, so a seller can legitimately run an FBA and an FBM offer on one ASIN
  // and both appear in this list.
  //
  // That breaks the override below, which is ASIN-level and cannot tell the two
  // self-offers apart -- it forced BOTH to FBM the moment any FBM row existed.
  // Observed live on B0G2YNN87D: two "YOU" offers at $37.74, both labelled FBM,
  // one of which is 60 units of genuine FBA stock.
  const hasLiveFbaInventory = (inventoryRows || []).some((row: any) =>
    detectIsFba(row)
    && (Number(row.available || 0) > 0 || Number(row.reserved || 0) > 0
        || Number(row.inbound || 0) > 0),
  );
  const accessToken = await getLwaAccessToken(sellerAuth.refresh_token);
  const url = `${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
  await waitForApiToken(admin, 'pricing_api');
  const response = await signedSpApiFetch(url, accessToken);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`SP-API offers ${response.status}: ${data?.errors?.[0]?.message || 'failed'}`);

  const summary = data?.payload?.Summary || {};
  const rawOffers: any[] = Array.isArray(data?.payload?.Offers) ? data.payload.Offers : [];
  const offers = rawOffers
    .map((offer: any) => {
      const price = typeof offer.ListingPrice?.Amount === 'number' ? offer.ListingPrice.Amount : null;
      const shipping = typeof offer.Shipping?.Amount === 'number' ? offer.Shipping.Amount : 0;
      const sellerId = String(offer.SellerId || '');
      const isSelf = selfSellerIds.has(sellerId);
      // Do not infer FBA from local inventory presence. FBM inventory rows are stock truth,
      // and the old fallback turned real FBM self-offers into phantom FBA in the extension.
      //
      // The override is ASIN-level, so it can only be applied when the ASIN is
      // unambiguously single-channel. With FBM stock and NO FBA stock, every
      // self-offer must be FBM and forcing it is right -- that is the case this
      // was written for. With BOTH channels live there are two real self-offers
      // and no way to tell them apart from this side, so Amazon's own per-offer
      // IsFulfilledByAmazon is the only thing that knows, and it is trusted.
      const singleChannelFbm = hasLiveFbmInventory && !hasLiveFbaInventory;
      const isFBA = offer.IsFulfilledByAmazon === true && !(isSelf && singleChannelFbm);
      return {
        sellerId,
        isFBA,
        isPrime: isFBA,
        condition: 1,
        price,
        shipping,
        stock: null,
        isBuyBox: offer.IsBuyBoxWinner === true,
        landed: price != null ? price + shipping : null,
        sellerName: sellerId,
        isAmazon: AMAZON_SELLER_IDS.has(sellerId),
        isSelf,
        rating: null as number | null,
        ratingCount: null as number | null,
      };
    })
    .filter((o: any) => o.sellerId && o.price != null && o.landed != null)
    .sort((a: any, b: any) => a.landed - b.landed);

  // Resolve names for ALL sellers (including self) via Keepa storefront lookup.
  // No hardcoded names — the UI shows the real storefront name; the YOU badge
  // (driven by isSelf) is what marks the current user's row.
  const nameMap = await resolveSellerNames(
    admin,
    keepaKey,
    domainId,
    marketplace,
    offers.map((o: any) => o.sellerId),
  );
  for (const offer of offers) {
    offer.sellerName = nameMap[offer.sellerId]?.name || offer.sellerName;
    offer.isAmazon = !!nameMap[offer.sellerId]?.isAmazon || offer.isAmazon;
    offer.rating = nameMap[offer.sellerId]?.rating ?? null;
    offer.ratingCount = nameMap[offer.sellerId]?.ratingCount ?? null;
  }

  const buyBox = offers.find((o: any) => o.isBuyBox);
  const buyBoxPrice = buyBox?.landed ?? summary?.BuyBoxPrices?.find?.((bp: any) => bp.condition === 'New')?.LandedPrice?.Amount ?? null;
  if (!buyBox && buyBoxPrice != null) {
    const match = offers.find((o: any) => Math.abs(Number(o.landed) - Number(buyBoxPrice)) < 0.01);
    if (match) match.isBuyBox = true;
  }
  // SP-API's GetItemOffers hard-caps the Offers array at 20 with no
  // pagination available on this endpoint -- but Summary.TotalOfferCount
  // still reports the true seller count, so surface it rather than let the
  // panel silently imply only 20 sellers exist.
  const totalOfferCount = typeof summary?.TotalOfferCount === 'number' ? summary.TotalOfferCount : offers.length;
  return { offers, buyBoxPrice, totalOfferCount };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);

    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const token = auth.replace('Bearer ', '').trim();
    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').toUpperCase().trim();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const range = String(body.range || '90'); // '90' | '180' | '365' | '730' | '1825' | 'SINCE_LISTED'
    const force = body.force === true;
    const FIXED_RANGE_DAYS: Record<string, number> = { '90': 90, '180': 180, '365': 365, '730': 730, '1825': 1825 };
    const isSinceListed = range === 'SINCE_LISTED';
    // "Since Listed" needs the product's listedSince/trackingSince, which only
    // comes back IN the Keepa response — so the true day count isn't known
    // before asking. We request Keepa's stats over a generously large window
    // up front (the `stats` parameter costs zero extra Keepa tokens regardless
    // of size, and Keepa can't return more history than it actually tracked
    // anyway, so this is effectively "the ASIN's full Keepa history" in a
    // single round trip). The real since-listed day count is then derived
    // from that SAME response (computeSinceListedDays) and used for
    // display/truncation/caching instead of this placeholder.
    // ~15 years — safely covers Keepa's entire operating history (KEEPA_EPOCH_MIN
    // is 2011-01-01). Verified live: one real ASIN's listedSince predates its
    // own trackingSince by years (Amazon listing older than Keepa's tracking
    // of it), so a 10-year cap was clamping a real, larger computed value.
    const SINCE_LISTED_STATS_WINDOW_DAYS = 5500;
    const requestedDays = isSinceListed ? SINCE_LISTED_STATS_WINDOW_DAYS : (FIXED_RANGE_DAYS[range] ?? 90);
    // Cache key: fixed ranges key on their exact day count; "Since Listed"
    // uses one sentinel per ASIN (the real day count varies per ASIN and is
    // carried inside the cached series' windowDays fields instead).
    const SINCE_LISTED_CACHE_KEY = -1;
    const cacheDaysKey = isSinceListed ? SINCE_LISTED_CACHE_KEY : requestedDays;

    if (!/^[A-Z0-9]{10}$/.test(asin)) return jsonResponse({ error: 'Invalid ASIN' }, 400);

    const domainId = DOMAIN_MAP[marketplace] ?? 1;

    // Cache lookup (also kept as stale fallback if Keepa rate-limits us)
    const { data: cached } = await admin
      .from('keepa_price_history_cache')
      .select('*')
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .eq('days_range', cacheDaysKey)
      .maybeSingle();

    // The real day count for a cached "Since Listed" row varies per ASIN and
    // isn't part of the cache key — read it back out of the series payload
    // (sellerHistory/buyBoxOwnership already carry windowDays) instead.
    const cachedEffectiveDays = (cached?.series?.buyBoxOwnership?.windowDays as number | undefined)
      ?? (cached?.series?.sellerHistory?.windowDays as number | undefined)
      ?? cacheDaysKey;

    const cacheFresh = cached && new Date(cached.expires_at).getTime() > Date.now();
    // Legacy rows written before the Private-Label Risk redesign lack these
    // two keys entirely. Never serve them as "fresh" just because they're
    // within the 24h TTL — that would strand users on the old snapshot
    // classifier for up to a day. Force one real Keepa refetch instead.
    const cacheHasPlData = !!(cached?.series?.sellerHistory && cached?.series?.buyBoxOwnership);

    if (!force && cacheFresh && cacheHasPlData) {
      let liveOffers = cached.offers;
      let liveBuyBoxPrice: number | null = null;
      try {
        const spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
        if (spLive) {
          liveOffers = { count: spLive.offers.length, list: spLive.offers, totalCount: spLive.totalOfferCount };
          liveBuyBoxPrice = spLive.buyBoxPrice;
        }
      } catch (e) {
        console.warn('[mobile-scan-price-history] SP-API live offers failed, using cached offers', (e as Error).message);
      }
      const liveList = Array.isArray((liveOffers as any)?.list) ? (liveOffers as any).list : [];
      const liveFba = liveList.filter((o: any) => o.isFBA || o.isAmazon || o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
      const liveFbm = liveList.filter((o: any) => !o.isFBA && !o.isAmazon && !o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
      const liveSeries = {
        ...(cached.series || {}),
        buybox: appendCurrentPoint(cached.series?.buybox || [], liveBuyBoxPrice),
        newFba: appendCurrentPoint(cached.series?.newFba || [], liveFba.length ? Math.min(...liveFba) : null),
        newFbm: appendCurrentPoint(cached.series?.newFbm || [], liveFbm.length ? Math.min(...liveFbm) : null),
      };
      return jsonResponse({
        asin, marketplace, days: cachedEffectiveDays, cached: true,
        series: liveSeries,
        offers: liveOffers,
        fetched_at: cached.fetched_at,
      });
    }

    // Helper: degrade gracefully when Keepa is unavailable (429 / timeout / 5xx).
    // Prefer stale cache + live SP-API offers over a hard error so the panel
    // never shows "All sellers retrieval failed" when we have ANY usable data.
    const degradeFallback = async (reason: string) => {
      console.warn('[mobile-scan-price-history] degrading Keepa response:', reason);
      let spOffers: any = null;
      let spBuyBox: number | null = null;
      try {
        const spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
        if (spLive) {
          spOffers = { count: spLive.offers.length, list: spLive.offers, totalCount: spLive.totalOfferCount };
          spBuyBox = spLive.buyBoxPrice;
        }
      } catch (e) {
        console.warn('[mobile-scan-price-history] degrade: SP-API also failed', (e as Error).message);
      }
      if (cached) {
        const series = {
          ...(cached.series || {}),
          buybox: appendCurrentPoint(cached.series?.buybox || [], spBuyBox),
        };
        return jsonResponse({
          asin, marketplace, days: cachedEffectiveDays, cached: true, degraded: true, degraded_reason: reason,
          series,
          offers: spOffers || cached.offers,
          fetched_at: cached.fetched_at,
        });
      }
      if (spOffers && spOffers.list.length > 0) {
        return jsonResponse({
          asin, marketplace, days: requestedDays, cached: false, degraded: true, degraded_reason: reason,
          series: { buybox: appendCurrentPoint([], spBuyBox) },
          offers: spOffers,
          fetched_at: new Date().toISOString(),
        });
      }
      return jsonResponse({ error: reason }, 502);
    };

    const url = new URL('https://api.keepa.com/product');
    url.search = new URLSearchParams({
      key: KEEPA_KEY,
      domain: String(domainId),
      asin,
      stats: String(requestedDays),
      history: '1',
      // MEASURED 2026-08-17, correcting the assumption this line was raised
      // on. offers=20 and offers=100 return an IDENTICAL offer list -- tested
      // on four ASINs returning 84, 162, 363 and 400 offers, all matching
      // exactly, along with identical buyBoxSellerIdHistory and csv[18].
      // The parameter is a billing tier, not a result cap: 100 cost 6 tokens,
      // 20 costs 5, for the same data. The earlier comment assumed truncation
      // that does not happen.
      offers: '20',
      buybox: '1',
    }).toString();

    // Claim the budget BEFORE spending it. Failing here degrades to cache or
    // SP-API with a stated reason, which is the whole point: a busy budget now
    // produces a visible explanation instead of thin data nobody can account
    // for.
    // INTERACTIVE tier (reserve 0). At the default 60 floor this claim was
    // arithmetically impossible below 65 tokens — measured live at 24.19 on
    // 2026-08-18 12:52 UTC, refusing every panel view while UNGATED callers
    // kept draining the same bucket. No Layer 1 claimants are added here.
    const slot = await acquireKeepaSlotWithRetry(admin, {
      estimatedTokens: KEEPA_COST.productPriceHistory,
      minReserve: KEEPA_RESERVE.interactive,
    });
    if (!slot.ok) {
      return await degradeFallback(
        `Keepa budget busy — retry in ~${Math.max(1, Math.round(slot.waitSeconds))}s. Data below is incomplete.`,
      );
    }

    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tId);
      const aborted = (e as Error)?.name === 'AbortError';
      return await degradeFallback(aborted ? 'Keepa timeout' : `Keepa fetch failed: ${(e as Error).message}`);
    }
    clearTimeout(tId);
    if (!res.ok) {
      const msg = await keepaErrorMessage(res);
      // 429 / 5xx: serve stale cache or SP-API rather than hard-failing the panel.
      if (res.status === 429 || res.status >= 500) {
        return await degradeFallback(msg);
      }
      return jsonResponse({ error: msg }, 502);
    }

    const json = await res.json();

    // Ground truth from a 200 response. This function is the heaviest Keepa
    // caller in the system -- offers=100 on every panel view -- and until now it
    // reported nothing, so keepa_token_budget could not see its consumption at
    // all and read as healthy while this drained the bucket.
    await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);

    // KEEPA SIGNALS FAILURE IN THE BODY OF A 200. Checking only res.ok and then
    // products[0] made an exhausted quota indistinguishable from a product that
    // genuinely has no data: both fell into degradeFallback, which silently
    // served SP-API offers. On the panel that surfaced as a price history with
    // only the Amazon line, no graph, and "Not enough data" for private-label
    // risk -- with nothing anywhere saying the quota had run out.
    //
    // Reported live 2026-08-17 with keepa_token_budget.tokens_left at 5.3 of 300.
    //
    // A quota failure is TEMPORARY and retrying works, so it must not look like
    // "this product has no data", which reads as permanent.
    if (json?.error) {
      // MEASURED 2026-08-17, not assumed. A 200 error body looks like:
      //   {"error":{"message":"...","type":"invalidParameter"},
      //    "tokensLeft":59,"tokensConsumed":0,"refillIn":26645,"refillRate":5}
      // `error` is an OBJECT and `products` is absent entirely -- which is
      // exactly why `json?.products?.[0]` came back undefined and the old code
      // mistook a rejected request for a product with no data.
      const err = json.error as { message?: string; type?: string } | string;
      const detail = typeof err === 'string'
        ? err
        : (err?.message || err?.type || 'unknown Keepa error');
      const type = typeof err === 'object' && err ? String(err.type || '') : '';
      const tokensLeft = typeof json?.tokensLeft === 'number' ? json.tokensLeft : null;
      const refillSec = typeof json?.refillIn === 'number' ? Math.ceil(json.refillIn / 1000) : null;
      console.error('[mobile-scan-price-history] Keepa 200 with in-body error', {
        asin, detail, type, tokensLeft, refillIn: json?.refillIn,
      });

      // Quota specifically: say so, and say when to come back. Matched on the
      // error TYPE as well as the balance -- the exhausted-bucket payload has
      // not been observed directly, so keying only on tokensLeft <= 0 would
      // risk missing it if Keepa reports the shortfall a different way.
      const quotaExhausted =
        (tokensLeft !== null && tokensLeft <= 0) || /token|quota|limit/i.test(type);
      if (quotaExhausted) {
        await recordKeepa429(admin, tokensLeft, 'mobile-scan-price-history /product');
        return await degradeFallback(
          `Keepa quota exhausted${refillSec ? ` — retry in ~${refillSec}s` : ''}. Data below is incomplete.`,
        );
      }
      return await degradeFallback(`Keepa error: ${detail}`);
    }

    const product = json?.products?.[0];
    if (!product) {
      // No in-body error and no product: the ASIN really is unavailable, which
      // is a different message from a quota failure and now reads as one.
      console.warn('[mobile-scan-price-history] Keepa returned no product', {
        asin, tokensLeft: json?.tokensLeft,
      });
      return await degradeFallback('No Keepa data for this ASIN');
    }

    // Real "Since Listed" day count, derived from THIS response's
    // listedSince/trackingSince fields — see computeSinceListedDays. For
    // fixed ranges this is just requestedDays unchanged.
    const days = isSinceListed
      ? computeSinceListedDays(product.listedSince, product.trackingSince, Date.now(), SINCE_LISTED_STATS_WINDOW_DAYS)
      : requestedDays;

    const csv: (number[] | null)[] = product.csv || [];

    // Private-Label Risk data — parsed from fields already present in this
    // SAME Keepa response (stats + history + buybox were already requested
    // above for the price chart), so this adds zero additional Keepa cost.
    const sellerHistory = summarizeCountSeries(parseSeries(csv[IDX_COUNT_NEW], days, false), days);
    const buyBoxSellerIdHistory: unknown[] = Array.isArray(product.buyBoxSellerIdHistory) ? product.buyBoxSellerIdHistory : [];

    // AMAZON_SELLER_IDS is a hardcoded list (US/MX/DE/FR/UK/IT/JP) — it does
    // NOT cover every marketplace this app operates in (CA and BR are
    // missing, and any future/unseen Amazon retail account would be missing
    // too). Without this, Amazon winning the Buy Box on those marketplaces
    // reads as "one seller won the Buy Box" — a private-label signal — when
    // it's actually just Amazon. resolveSellerNames() already solves this
    // exact problem elsewhere in this file via a real Keepa storefront-name
    // lookup + looksLikeAmazonName() fallback; reuse it here instead of
    // trusting the static ID list alone, so Buy Box ownership scoring is
    // never fooled by an Amazon account this file hasn't hardcoded.
    const bbSellerIdsForLookup = Array.from(new Set([
      ...Object.keys(product.stats?.buyBoxStats || {}),
      ...buyBoxSellerIdHistory.filter((_, i) => i % 2 === 1).map(id => String(id)),
    ].filter(Boolean)));
    const bbSellerNameMap = await resolveSellerNames(admin, KEEPA_KEY, domainId, marketplace, bbSellerIdsForLookup);
    const effectiveAmazonSellerIds = new Set([
      ...AMAZON_SELLER_IDS,
      ...bbSellerIdsForLookup.filter(id => bbSellerNameMap[id]?.isAmazon),
    ]);

    const buyBoxOwnership = computeBuyBoxOwnership(
      product.stats?.buyBoxStats,
      buyBoxSellerIdHistory,
      days,
      effectiveAmazonSellerIds,
      Date.now(),
    );

    const series = {
      amazon: downsample(parseSeries(csv[IDX_AMAZON], days, true), days),
      buybox: downsample(parseSeries(csv[IDX_BUYBOX], days, true), days),
      newPrice: downsample(parseSeries(csv[IDX_NEW], days, true), days),
      newFba: downsample(parseSeries(csv[IDX_NEW_FBA], days, true), days),
      newFbm: downsample(parseSeries(csv[IDX_NEW_FBM_SHIP], days, true), days),
      bsr: downsample(parseSeries(csv[IDX_SALES_RANK], days, false), days),
      // Nested here (not a new DB column) so the existing JSONB `series`
      // cache column absorbs them with no migration required.
      sellerHistory,
      buyBoxOwnership,
    };

    // Live competitor list: try Amazon's own SP-API GetItemOffers FIRST —
    // it's the authoritative, real-time source Amazon itself uses for
    // pricing decisions (same call the repricer relies on), and unlike the
    // Keepa-derived offers below, resolving it costs zero Keepa tokens.
    // Only fall back to building an offers list out of this Keepa /product
    // response (and the seller-name lookups that requires) when SP-API
    // genuinely has nothing — e.g. this ASIN isn't in the user's catalog,
    // or the SP-API pricing rate gate is currently saturated.
    let finalOffers: any[];
    let liveBuyBoxPrice: number | null = null;
    let spLive: Awaited<ReturnType<typeof fetchLiveSpApiOffers>> = null;
    try {
      spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
    } catch (e) {
      console.warn('[mobile-scan-price-history] SP-API live offers failed, falling back to Keepa offers', (e as Error).message);
    }

    if (spLive) {
      finalOffers = spLive.offers;
      liveBuyBoxPrice = spLive.buyBoxPrice;
    } else {
      // Build live offers from product.offers
      const rawOffers: any[] = Array.isArray(product.offers) ? product.offers : [];
      type Offer = {
        sellerId: string;
        isFBA: boolean;
        isPrime: boolean;
        condition: number;
        price: number | null;
        shipping: number | null;
        stock: number | null;
        isBuyBox: boolean;
      };
      const lastBBSeller = buyBoxSellerIdHistory.length > 1
        ? String(buyBoxSellerIdHistory[buyBoxSellerIdHistory.length - 1])
        : null;

      // Filter stale offers: Keepa returns the union of offers ever seen.
      // Only offers seen within the last 7 days are considered "live".
      // Keepa time = minutes since 2011-01-01 UTC.
      const nowKeepaMin = Math.floor((Date.now() - KEEPA_EPOCH_MS_CONST) / 60000);
      const LIVE_WINDOW_MIN = 7 * 24 * 60; // 7 days

      const offers: Offer[] = rawOffers
        .filter(o => o && (o.condition === 1 || o.condition === 0 || o.condition == null)) // New only
        .filter(o => {
          const ls = Number(o.lastSeen);
          // If lastSeen is missing, keep (Keepa sometimes omits); otherwise require recency.
          if (!Number.isFinite(ls) || ls <= 0) return true;
          return (nowKeepaMin - ls) <= LIVE_WINDOW_MIN;
        })
        .map(o => {
          // o.offerCSV alternates [t, price, shipping] triples (newest last)
          const arr: number[] = Array.isArray(o.offerCSV) ? o.offerCSV : [];
          let price: number | null = null;
          let shipping: number | null = null;
          if (arr.length >= 3) {
            const p = arr[arr.length - 2];
            const s = arr[arr.length - 1];
            if (typeof p === 'number' && p > 0) price = p / 100;
            if (typeof s === 'number' && s >= 0) shipping = s / 100;
          }
          // Strict FBA: Keepa flags many FBM offers with isFBA=true if seller has any FBA SKUs.
          // True FBA offers are ALWAYS Prime-eligible. Require both flags.
          const strictFBA = !!o.isFBA && !!o.isPrime;
          return {
            sellerId: String(o.sellerId || ''),
            isFBA: strictFBA,
            isPrime: !!o.isPrime,
            condition: Number(o.condition ?? 1),
            price,
            shipping,
            stock: Number.isFinite(Number(o.stockCSV?.at?.(-1))) ? Number(o.stockCSV.at(-1)) : null,
            isBuyBox: lastBBSeller != null && String(o.sellerId) === lastBBSeller,
          } as Offer;
        })
        .filter(o => o.sellerId && o.price != null);

      // Resolve seller names
      const sellerIds = offers.map(o => o.sellerId);
      const nameMap = await resolveSellerNames(admin, KEEPA_KEY, domainId, marketplace, sellerIds);

      finalOffers = offers
        .map(o => {
          const total = (o.price ?? 0) + (o.shipping ?? 0);
          const meta = nameMap[o.sellerId];
          return {
            ...o,
            landed: total,
            sellerName: meta?.name || o.sellerId,
            isAmazon: !!meta?.isAmazon,
            rating: meta?.rating ?? null,
            ratingCount: meta?.ratingCount ?? null,
          };
        })
        .sort((a, b) => a.landed - b.landed);
    }

    const finalFba = finalOffers.filter((o: any) => o.isFBA || o.isAmazon || o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
    const finalFbm = finalOffers.filter((o: any) => !o.isFBA && !o.isAmazon && !o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
    series.buybox = appendCurrentPoint(series.buybox, liveBuyBoxPrice);
    series.newFba = appendCurrentPoint(series.newFba, finalFba.length ? Math.min(...finalFba) : null);
    series.newFbm = appendCurrentPoint(series.newFbm, finalFbm.length ? Math.min(...finalFbm) : null);

    const offersPayload = {
      count: finalOffers.length,
      list: finalOffers,
      totalCount: spLive?.totalOfferCount ?? finalOffers.length,
    };

    // Cache — keyed by cacheDaysKey (the "Since Listed" sentinel for that
    // mode), not the computed `days`, so repeat "Since Listed" lookups for
    // the same ASIN hit one row instead of a new one per exact day count.
    await admin.from('keepa_price_history_cache').upsert({
      asin, marketplace, days_range: cacheDaysKey,
      series, offers: offersPayload,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'asin,marketplace,days_range' });

    return jsonResponse({
      asin, marketplace, days, cached: false,
      series, offers: offersPayload,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
