// LISTING-SELLER-COUNT
//
// How many sellers are on this listing, right now -- and what it was when the
// seller created the listing.
//
// ---- WHY ----------------------------------------------------------------
// Seller request 2026-09-24: competition at purchase time is the one number
// that cannot be reconstructed afterwards. Amazon keeps no offer-count history,
// and by the time a slow-moving listing is reviewed, "how many sellers were on
// it when I bought" is gone. The create extension records it at save time and
// a Recheck button compares it with today.
//
// ---- COST ---------------------------------------------------------------
// getItemOffers (GET /products/pricing/v0/items/{asin}/offers) is limited by
// Amazon to 0.5 req/s burst 1, PER SELLER ACCOUNT, shared across marketplaces,
// and the repricer lives on that same quota (see _shared/rate-limiter.ts, the
// KNOWN GAP note). So this function:
//   * runs only on an explicit create or Recheck -- never on a timer,
//   * takes a 'pricing_api' token before calling, like every other consumer,
//   * counts offers and stops. No pricing decisions are made here.
//
// ---- WHAT IT RETURNS ----------------------------------------------------
// The fresh count, plus the create-time baseline and the previous check for the
// same ASIN, so the caller can render "5 at create -> 9 now" without a second
// round trip.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { signRequest, getLWAAccessToken, getSpApiEndpoint } from '../_shared/sp-api-sigv4.ts';
import { MARKETPLACE_META } from '../_shared/marketplace-map.ts';
import { waitForApiToken } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface OfferCounts {
  total: number;
  fba: number;
  fbm: number;
  buyboxPrice: number | null;
  lowestPrice: number | null;
}

/**
 * Count New offers from getItemOffers.
 *
 * Offers[] is what we count, NOT summary.TotalOfferCount: the summary counts
 * every condition, so a listing with used offers reads higher than the number
 * of sellers the seller is actually competing with. IsFulfilledByAmazon on each
 * offer gives the FBA/FBM split.
 */
function countOffers(payload: any): OfferCounts {
  const offers: any[] = Array.isArray(payload?.Offers) ? payload.Offers : [];
  let fba = 0;
  let fbm = 0;
  let buyboxPrice: number | null = null;
  let lowestPrice: number | null = null;

  for (const o of offers) {
    if (o?.IsFulfilledByAmazon === true) fba++; else fbm++;
    const landed = Number(o?.ListingPrice?.Amount ?? 0) + Number(o?.Shipping?.Amount ?? 0);
    if (landed > 0 && (lowestPrice === null || landed < lowestPrice)) lowestPrice = landed;
    if (o?.IsBuyBoxWinner === true) {
      const bb = Number(o?.ListingPrice?.Amount ?? 0);
      if (bb > 0) buyboxPrice = bb;
    }
  }

  // Buy Box can also arrive only in the summary.
  if (buyboxPrice === null) {
    const bb = payload?.Summary?.BuyBoxPrices?.[0]?.ListingPrice?.Amount;
    if (Number(bb) > 0) buyboxPrice = Number(bb);
  }

  return { total: offers.length, fba, fbm, buyboxPrice, lowestPrice };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization') || '';
    const { data: userRes, error: userErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', '').trim());
    if (userErr || !userRes?.user) return json({ error: 'Unauthorized' }, 401);
    const userId = userRes.user.id;

    const body = await req.json().catch(() => ({}));
    const asin = String(body?.asin || '').toUpperCase().trim();
    const marketplaceCode = String(body?.marketplace || 'US').toUpperCase().trim();
    const createdListingId: string | null = body?.createdListingId || body?.created_listing_id || null;
    const reason = body?.reason === 'create' ? 'create' : 'recheck';

    if (!/^[A-Z0-9]{10}$/.test(asin)) return json({ error: 'Invalid ASIN' }, 400);
    const meta = MARKETPLACE_META[marketplaceCode];
    if (!meta) return json({ error: `Unknown marketplace ${marketplaceCode}` }, 400);

    // The baseline and the last check come from our own tables, so they cost
    // nothing and are returned even if Amazon refuses below.
    const [{ data: baselineRow }, { data: lastRows }] = await Promise.all([
      createdListingId
        ? supabase.from('created_listings')
            .select('sellers_at_create, sellers_fba_at_create, sellers_fbm_at_create, sellers_counted_at, date_created')
            .eq('user_id', userId).eq('id', createdListingId).maybeSingle()
        : supabase.from('created_listings')
            .select('sellers_at_create, sellers_fba_at_create, sellers_fbm_at_create, sellers_counted_at, date_created')
            .eq('user_id', userId).eq('asin', asin)
            .not('sellers_at_create', 'is', null)
            .order('date_created', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('listing_seller_counts')
        .select('total_offers, fba_offers, fbm_offers, checked_at, reason')
        .eq('user_id', userId).eq('asin', asin).eq('marketplace', marketplaceCode)
        .order('checked_at', { ascending: false }).limit(1),
    ]);

    const { data: authRows } = await supabase
      .from('seller_authorizations')
      .select('refresh_token')
      .eq('user_id', userId)
      .limit(1);
    const refreshToken = authRows?.[0]?.refresh_token;
    if (!refreshToken) return json({ error: 'No Amazon seller authorization found' }, 400);

    // Same bucket every other getItemOffers caller uses. Fails OPEN after the
    // wait, which is right for a single interactive lookup -- the seller
    // pressed a button and is waiting.
    await waitForApiToken(supabase, 'pricing_api', { maxWaitMs: 12000 });

    const accessToken = await getLWAAccessToken(refreshToken);
    const endpoint = getSpApiEndpoint(meta.amazonMarketplaceId);
    const url = `${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${meta.amazonMarketplaceId}&ItemCondition=New`;
    const headers = await signRequest('GET', url, '', accessToken);

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[listing-seller-count] ${asin} ${marketplaceCode} HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return json({
        error: res.status === 429 ? 'Amazon is rate limiting pricing requests — try again in a minute' : `Amazon returned ${res.status}`,
        asin, marketplace: marketplaceCode,
        baseline: baselineRow ?? null,
        previous: lastRows?.[0] ?? null,
      }, res.status === 429 ? 429 : 502);
    }

    const payload = (await res.json().catch(() => null))?.payload;
    const counts = countOffers(payload);

    await supabase.from('listing_seller_counts').insert({
      user_id: userId,
      asin,
      marketplace: marketplaceCode,
      created_listing_id: createdListingId,
      total_offers: counts.total,
      fba_offers: counts.fba,
      fbm_offers: counts.fbm,
      buybox_price: counts.buyboxPrice,
      lowest_price: counts.lowestPrice,
      reason,
    });

    // The create-time numbers are written ONCE. A Recheck must never move the
    // baseline -- that is the whole point of keeping it.
    if (reason === 'create' && createdListingId) {
      await supabase.from('created_listings')
        .update({
          sellers_at_create: counts.total,
          sellers_fba_at_create: counts.fba,
          sellers_fbm_at_create: counts.fbm,
          sellers_counted_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('id', createdListingId)
        .is('sellers_at_create', null);
    }

    return json({
      asin,
      marketplace: marketplaceCode,
      total: counts.total,
      fba: counts.fba,
      fbm: counts.fbm,
      buyboxPrice: counts.buyboxPrice,
      lowestPrice: counts.lowestPrice,
      reason,
      baseline: reason === 'create'
        ? { sellers_at_create: counts.total, sellers_fba_at_create: counts.fba, sellers_fbm_at_create: counts.fbm, sellers_counted_at: new Date().toISOString() }
        : baselineRow ?? null,
      previous: lastRows?.[0] ?? null,
    });
  } catch (e) {
    console.error('[listing-seller-count]', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
