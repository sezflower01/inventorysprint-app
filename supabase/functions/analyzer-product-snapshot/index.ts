// Product Analyzer snapshot — aggregates Keepa + (optional) SP-API data into a
// single response for the /tools/product-analyzer page. Keepa is the primary
// source; SP-API is best-effort for eligibility/restrictions when the user has
// connected their account. Results are cached per (asin, marketplace) for 30 min.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
// Gated 2026-08-19 with a TOKEN-ONLY claim. The cause is now proven, so the
// earlier "observe, do not alter" stance no longer applies: this is the most
// expensive Keepa caller in the product (stats=180 + history + offers=20 +
// buybox, and buybox=1 alone measured at 3x) and it was spending with no claim
// at all. Local accounting read tokens_left 38.1 while Keepa's own response
// carried tokensLeft -9.
//
// Token-only rather than acquireKeepaGlobalSlot: the two-layer version also
// claims one of 4 call-rate slots per minute, which on 2026-08-18 let a single
// analyzer view consume most of the minute and time the extension out.
import {
  reportKeepaTokensLeft, recordKeepa429, acquireKeepaTokensOnly,
  KEEPA_COST, KEEPA_RESERVE,
} from '../_shared/keepa-rate-gate.ts';
import { isFbaOffer } from '../_shared/keepa-offers.ts';
import { summarizeCountSeries, computeBuyBoxOwnership } from '../_shared/plRiskSeries.ts';
import { computePrivateLabelRisk, plRiskCategoricalLabel } from '../_shared/plRisk.ts';
import { classifyFbaSizeTier } from './fbaSizeTier.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);
const keepaToMs = (kmin: number) => kmin * 60_000 + KEEPA_EPOCH_MS;

// CSV indices in Keepa
const CSV = {
  AMAZON: 0,
  NEW: 1,
  SALES_RANK: 3,
  NEW_FBA: 10,
  NEW_FBM_SHIPPING: 7,
  COUNT_NEW: 11,
  BUY_BOX: 18,
  BUY_BOX_USED: 32,
};

function parseSeries(csv: number[] | null | undefined, isPrice = true): { t: number; v: number }[] {
  if (!Array.isArray(csv)) return [];
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i], v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v < 0) continue;
    out.push({ t: keepaToMs(t), v: isPrice ? v / 100 : v });
  }
  return out;
}

function lastVal(csv: number[] | null | undefined, isPrice = true): number | null {
  const s = parseSeries(csv, isPrice);
  return s.length ? s[s.length - 1].v : null;
}

function statsField(stats: any, idx: number, isPrice = true): { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null } {
  const pick = (arr: any) => Array.isArray(arr) && typeof arr[idx] === 'number' && arr[idx] > 0
    ? (isPrice ? arr[idx] / 100 : arr[idx])
    : null;
  return {
    current: pick(stats?.current),
    avg30: pick(stats?.avg30),
    avg90: pick(stats?.avg90),
    avg180: pick(stats?.avg180),
  };
}

function bsrTopPercent(bsr: number | null, totalCategorySize: number | null): number | null {
  if (!bsr || !totalCategorySize || totalCategorySize <= 0) return null;
  return +(100 * bsr / totalCategorySize).toFixed(2);
}

// Rough BSR -> est. monthly sales bucket (Keepa-style heuristic)
function estimateSales(bsr: number | null): string {
  if (!bsr || bsr <= 0) return 'Not enough data';
  if (bsr < 100) return '10000+/mo';
  if (bsr < 500) return '5000+/mo';
  if (bsr < 1000) return '2000+/mo';
  if (bsr < 5000) return '1000+/mo';
  if (bsr < 10000) return '500+/mo';
  if (bsr < 25000) return '300+/mo';
  if (bsr < 50000) return '250+/mo';
  if (bsr < 100000) return '200+/mo';
  if (bsr < 250000) return '100+/mo';
  if (bsr < 500000) return '50+/mo';
  if (bsr < 1000000) return '25+/mo';
  return '<25/mo';
}

interface AnalyzerSnapshot {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  cached: boolean;
  identity: {
    title: string | null;
    brand: string | null;
    category: string | null;
    image: string | null;
    reviewCount: number | null;
    rating: number | null;
    productGroup: string | null;
    packageDimensions: { length: number | null; width: number | null; height: number | null; weight: number | null; unit: string };
    itemDimensions: { length: number | null; width: number | null; height: number | null; weight: number | null; unit: string };
  };
  alerts: Array<{ key: string; label: string; status: 'good' | 'warn' | 'bad' | 'info'; value: string }>;
  quickInfo: {
    eligible: boolean | null;
    alertsCount: number;
    bsr: number | null;
    bsrTopPercent: number | null;
    estimatedSales: string;
    salesPerMonth: number | null;
    bsrDrops30: number | null;
    bbPriceChanges30: number | null;
    lastChecked: string;
  };
  offers: Array<{ rank: number; type: 'FBA' | 'FBM'; stock: number | null; price: number | null; isBuyBoxWinner: boolean; sellerId: string | null; sellerName: string | null; isAmazon: boolean; isSelf?: boolean }>;
  series: {
    buyBox: { t: number; v: number }[];
    amazon: { t: number; v: number }[];
    newFba: { t: number; v: number }[];
    bsr: { t: number; v: number }[];
    offerCount: { t: number; v: number }[];
  };
  ranksPrices: {
    bsr: { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null };
    buyBox: { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null };
    amazon: { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null };
    newFba: { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null };
    offerCount: { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null };
  };
  computed: {
    fbaOffers: number;
    fbmOffers: number;
    totalOffers: number;
  };
  plRisk: {
    // Categorical label matching analyzer_decision_log.pl_risk's convention:
    // "Low" | "Medium" | "High" | "Insufficient Data" | "Limited History".
    label: string;
    level: 'Low' | 'Medium' | 'High' | 'unknown';
    normalizedScore: number | null;
    text: string;
  };
}

function mapLiveOffersForAnalyzer(liveList: any[]): AnalyzerSnapshot['offers'] {
  return liveList
    .filter((o: any) => o && o.sellerId && (Number.isFinite(Number(o.landed)) || Number.isFinite(Number(o.price))))
    .sort((a: any, b: any) => (Number(a.landed ?? a.price) || 9e9) - (Number(b.landed ?? b.price) || 9e9))
    .map((o: any, i: number) => ({
      rank: i + 1,
      type: (o.isFBA || o.isAmazon) ? 'FBA' : 'FBM',
      stock: toPositiveStock(o.stock),
      price: Number(o.landed ?? o.price),
      isBuyBoxWinner: !!o.isBuyBox,
      sellerId: o.sellerId || null,
      sellerName: o.sellerName || o.sellerId || null,
      isAmazon: !!o.isAmazon,
      isSelf: !!o.isSelf,
    }));
}

function toPositiveStock(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mergeOfferStocks(
  primary: AnalyzerSnapshot['offers'],
  fallback: AnalyzerSnapshot['offers'] | null | undefined,
): AnalyzerSnapshot['offers'] {
  const stockBySeller = new Map<string, number>();
  for (const offer of fallback || []) {
    const sellerId = offer?.sellerId ? String(offer.sellerId) : '';
    const stock = toPositiveStock(offer?.stock);
    if (sellerId && stock != null) stockBySeller.set(sellerId, stock);
  }
  return primary.map((offer) => {
    const ownStock = toPositiveStock(offer.stock);
    if (ownStock != null) return { ...offer, stock: ownStock };
    const fallbackStock = offer.sellerId ? stockBySeller.get(String(offer.sellerId)) : undefined;
    return { ...offer, stock: fallbackStock ?? null };
  });
}

function isCorruptedZeroStockCache(offers: AnalyzerSnapshot['offers'] | null | undefined): boolean {
  const list = offers || [];
  return list.length > 0 && list.every((offer) => offer?.stock === 0);
}

async function fetchLiveAnalyzerOffers(auth: string, asin: string, marketplace: string, force: boolean): Promise<AnalyzerSnapshot['offers'] | null> {
  try {
    const FN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/mobile-scan-price-history`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 18000);
    const liveRes = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ asin, marketplace, range: '90', force }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!liveRes.ok) {
      console.warn('[analyzer-product-snapshot] live overlay non-OK', liveRes.status);
      return null;
    }
    const liveJson = await liveRes.json().catch(() => null);
    const liveList: any[] = Array.isArray(liveJson?.offers?.list) ? liveJson.offers.list : [];
    return liveList.length ? mapLiveOffersForAnalyzer(liveList) : null;
  } catch (e) {
    console.warn('[analyzer-product-snapshot] live SP-API overlay failed', (e as Error).message);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const auth = req.headers.get('Authorization');
    if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const { data: { user } } = await supabase.auth.getUser(auth.replace('Bearer ', ''));
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json().catch(() => ({}));
    const asin = String(body?.asin || '').trim().toUpperCase();
    const marketplace = String(body?.marketplace || 'US').toUpperCase();
    const force = !!body?.force;

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: 'Invalid ASIN' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY');
    if (!KEEPA_KEY) {
      return new Response(JSON.stringify({ error: 'KEEPA_API_KEY not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Per-user 24h cache — return cached snapshot unless force=true
    if (!force) {
      const { data: cached } = await supabase
        .from('product_analyzer_snapshot_cache')
        .select('snapshot, fetched_at, expires_at')
        .eq('user_id', user.id)
        .eq('asin', asin)
        .eq('marketplace', marketplace)
        .maybeSingle();
      if (cached?.snapshot && cached?.expires_at && new Date(cached.expires_at).getTime() > Date.now()) {
        const snap = cached.snapshot as any;
        if (isCorruptedZeroStockCache(snap.offers)) {
          console.warn('[analyzer-product-snapshot] bypassing cached all-zero stock snapshot', { asin, marketplace });
        } else {
        snap.cached = true;
        snap.fetchedAt = cached.fetched_at;
        // Do not return stale cached offers before the live SP-API overlay runs.
        // The Chrome extension always asks mobile-scan-price-history for live
        // offers, where the user's own seller is marked via seller_authorizations.
        // Refresh just the offers/computed section here so Full Details matches it.
        const liveOffers = await fetchLiveAnalyzerOffers(auth, asin, marketplace, false);
        if (liveOffers?.length) {
          snap.offers = mergeOfferStocks(liveOffers, snap.offers);
          snap.computed = {
            fbaOffers: snap.offers.filter((o: any) => o.type === 'FBA').length,
            fbmOffers: snap.offers.filter((o: any) => o.type === 'FBM').length,
            totalOffers: snap.offers.length,
          };
        }
        return new Response(JSON.stringify(snap), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }

    // Fetch Keepa product (with stats, offers, BB history)
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${asin}&stats=180&history=1&offers=20&buybox=1&rating=1&stock=1`;

    // Reserve for the heaviest shape this codebase makes: offers=20 measured
    // 5-6, and buybox=1 measured 3x on its own, so productWithOffersPerAsin (6)
    // is the honest floor rather than productPriceHistory (5). Over-reserving
    // self-corrects on the next reportKeepaTokensLeft; under-reserving is what
    // produces the 429s this whole change exists to stop.
    const snapSlot = await acquireKeepaTokensOnly(supabase, {
      estimatedTokens: KEEPA_COST.productWithOffersPerAsin,
      minReserve: KEEPA_RESERVE.interactive,
    });
    if (!snapSlot.ok) {
      // Fall through to exactly the stale-cache path the 429 branch below uses,
      // so a busy budget degrades to older data with a stated reason rather
      // than an error.
      console.warn(`[analyzer-product-snapshot] Keepa budget busy for ${asin} (${snapSlot.blockedBy})`);
      const { data: stale } = await supabase
        .from('product_analyzer_snapshot_cache')
        .select('snapshot, fetched_at')
        .eq('user_id', user.id).eq('asin', asin).eq('marketplace', marketplace)
        .maybeSingle();
      const msg = `Keepa budget busy — retry in ~${Math.max(1, Math.round(snapSlot.waitSeconds))}s`;
      if (stale?.snapshot) {
        return new Response(JSON.stringify({
          ...stale.snapshot, stale: true, stale_reason: msg, fetched_at: stale.fetched_at,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: msg }), {
        status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('[analyzer-product-snapshot] fetching Keepa', { asin, marketplace, domainId, force });
    const resp = await fetch(url);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[analyzer-product-snapshot] Keepa /product failed', resp.status, txt.slice(0, 400));
      // 429 fallback: return stale cache if any
      if (resp.status === 429) {
        // Keepa puts tokensLeft in the 429 body too -- capturing it here is
        // the whole point: it records the balance AT the moment of refusal.
        let tl: unknown = undefined;
        try { tl = JSON.parse(txt)?.tokensLeft; } catch { /* body not JSON */ }
        await recordKeepa429(supabase, tl, 'analyzer-product-snapshot /product');
        const { data: stale } = await supabase
          .from('product_analyzer_snapshot_cache')
          .select('snapshot, fetched_at')
          .eq('user_id', user.id).eq('asin', asin).eq('marketplace', marketplace)
          .maybeSingle();
        if (stale?.snapshot) {
          const snap = stale.snapshot as any;
          snap.cached = true;
          snap.fetchedAt = stale.fetched_at;
          snap.staleReason = 'keepa_rate_limited';
          const liveOffers = await fetchLiveAnalyzerOffers(auth, asin, marketplace, false);
          if (liveOffers?.length) {
            snap.offers = mergeOfferStocks(liveOffers, snap.offers);
            snap.computed = {
              fbaOffers: snap.offers.filter((o: any) => o.type === 'FBA').length,
              fbmOffers: snap.offers.filter((o: any) => o.type === 'FBM').length,
              totalOffers: snap.offers.length,
            };
          }
          return new Response(JSON.stringify(snap), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        let refillSec = 60;
        try { const j = JSON.parse(txt); if (j?.refillIn) refillSec = Math.ceil(j.refillIn / 1000); } catch {}
        return new Response(JSON.stringify({ error: `Keepa rate limit reached. Try again in ~${refillSec}s.` }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `Keepa HTTP ${resp.status}: ${txt.slice(0, 200) || 'rate limited or invalid key'}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const json = await resp.json().catch((e) => { console.error('[analyzer-product-snapshot] Keepa JSON parse failed', e); return {}; });
    // Ground truth from a successful call. Without this the budget table only
    // ever hears from the background workers, so a dip caused by interactive
    // use is invisible.
    await reportKeepaTokensLeft(supabase, json?.tokensLeft, json?.refillRate);
    const p = json?.products?.[0];
    if (!p) {
      console.error('[analyzer-product-snapshot] Product not found in Keepa response', { asin, tokensLeft: json?.tokensLeft, error: json?.error, refillIn: json?.refillIn });
      return new Response(JSON.stringify({ error: `Product not found (Keepa tokensLeft=${json?.tokensLeft ?? '?'})` }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const csv: any[] = p.csv || [];
    const stats = p.stats || {};

    // Series
    const series = {
      buyBox: parseSeries(csv[CSV.BUY_BOX], true),
      amazon: parseSeries(csv[CSV.AMAZON], true),
      newFba: parseSeries(csv[CSV.NEW_FBA], true),
      bsr: parseSeries(csv[CSV.SALES_RANK], false),
      offerCount: parseSeries(csv[CSV.COUNT_NEW], false),
    };

    // Offers (live snapshot from Keepa) — match extension's strict live-filter logic.
    // Keepa returns the union of every offer ever seen on the listing, so we must:
    //   1. Filter to New condition only
    //   2. Drop offers whose lastSeen is older than 7 days (stale/historical)
    //   3. Require isFBA && isPrime for FBA classification (Keepa over-flags FBA)
    //   4. Resolve buy-box winner from buyBoxSellerIdHistory (last entry), not the
    //      unreliable per-offer isBuyBoxWinner flag.
    const AMAZON_SELLER_IDS = new Set(['ATVPDKIKX0DER', 'A1AM78C64UM0Y8', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'A1F83G8C2ARO7P', 'APJ6JRA9NG5V4', 'A1VC38T7YXB528']);
    const KEEPA_EPOCH_MS_OFF = Date.UTC(2011, 0, 1);
    const nowKeepaMin = Math.floor((Date.now() - KEEPA_EPOCH_MS_OFF) / 60000);
    const LIVE_WINDOW_MIN = 7 * 24 * 60; // 7 days

    const bbHist: any[] = Array.isArray(p.buyBoxSellerIdHistory) ? p.buyBoxSellerIdHistory : [];
    const lastBBSeller: string | null = bbHist.length >= 2 ? String(bbHist[bbHist.length - 1] || '') || null : null;

    // Private-Label Risk — same scoring as the Chrome extension
    // (mobile-scan-price-history + extension/plRisk.js), ported to
    // _shared/plRisk.ts so both surfaces agree on the same ASIN. Uses the
    // SAME raw Keepa data already fetched above (stats.buyBoxStats,
    // buyBoxSellerIdHistory, csv[COUNT_NEW]) — zero extra Keepa cost.
    // windowDays is 180 to match the `stats=180` window requested from
    // Keepa above (stats.buyBoxStats reflects that same window); this
    // file's chart series has no day-range picker, unlike the extension.
    const PL_WINDOW_DAYS = 180;
    const rawCountNewPoints: { t: number; v: number }[] = [];
    {
      const countNewCsv: number[] = Array.isArray(csv[CSV.COUNT_NEW]) ? csv[CSV.COUNT_NEW] : [];
      for (let i = 0; i < countNewCsv.length; i += 2) {
        const t = countNewCsv[i], v = countNewCsv[i + 1];
        if (typeof t !== 'number' || typeof v !== 'number' || v === -1) continue;
        rawCountNewPoints.push({ t, v });
      }
    }
    const listedSinceRaw = Number(p.listedSince) > 0 ? Number(p.listedSince) : Number(p.trackingSince);
    const productAgeDays = Number.isFinite(listedSinceRaw) && listedSinceRaw > 0
      ? Math.max(1, Math.floor((Date.now() - keepaToMs(listedSinceRaw)) / (24 * 60 * 60 * 1000)))
      : null;
    const plSellerHistory = summarizeCountSeries(rawCountNewPoints, PL_WINDOW_DAYS);
    const plBuyBoxOwnership = computeBuyBoxOwnership(stats?.buyBoxStats, bbHist, PL_WINDOW_DAYS, AMAZON_SELLER_IDS, Date.now());
    const plResult = computePrivateLabelRisk({ sellerHistory: plSellerHistory, buyBoxOwnership: plBuyBoxOwnership, productAgeDays });
    const plRiskLabel = plRiskCategoricalLabel(plResult);

    const rawOffers = (p.offers || [])
      .filter((o: any) => o && (o.condition === 1 || o.condition === 0 || o.condition == null))
      .filter((o: any) => {
        const ls = Number(o.lastSeen);
        if (!Number.isFinite(ls) || ls <= 0) return true;
        return (nowKeepaMin - ls) <= LIVE_WINDOW_MIN;
      })
      .map((o: any, i: number) => {
        const oc: number[] = o.offerCSV || [];
        let lastPrice: number | null = null;
        if (oc.length >= 3) {
          const price = oc[oc.length - 2];
          const ship = oc[oc.length - 1];
          if (price > 0) lastPrice = (price + Math.max(0, ship)) / 100;
        }
        const sellerId: string | null = o.sellerId || null;
        // Single shared definition -- see _shared/keepa-offers.ts for why this
        // used to be duplicated and why the strict reading is canonical.
        const strictFBA = isFbaOffer(o);
        return {
          rank: i + 1,
          type: strictFBA ? 'FBA' : 'FBM',
          stock: toPositiveStock(o.stockCSV?.[o.stockCSV.length - 1]),
          price: lastPrice,
          isBuyBoxWinner: !!(sellerId && lastBBSeller && sellerId === lastBBSeller),
          sellerId,
          sellerName: sellerId && AMAZON_SELLER_IDS.has(sellerId) ? 'Amazon.com' : null,
          isAmazon: !!(sellerId && AMAZON_SELLER_IDS.has(sellerId)),
        } as AnalyzerSnapshot['offers'][number];
      })
      .filter((o: any) => o.price && o.price > 0 && o.sellerId)
      .sort((a: any, b: any) => (a.price ?? 9e9) - (b.price ?? 9e9))
      .map((o: any, i: number) => ({ ...o, rank: i + 1 }));

    // Resolve seller names (cache + Keepa /seller fallback)
    // Set<string> is explicit because Array.from(new Set(...)) infers unknown[]
    // here, which fails three call sites below. Behaviour unchanged.
    const sellerIds = Array.from(new Set<string>(rawOffers.map((o: any) => o.sellerId).filter((s: string | null): s is string => !!s && !AMAZON_SELLER_IDS.has(s))));
    const nameMap: Record<string, string> = {};
    if (sellerIds.length) {
      const { data: cached } = await supabase
        .from('keepa_seller_name_cache')
        .select('seller_id, business_name, storefront_name, expires_at')
        .in('seller_id', sellerIds)
        .eq('marketplace', marketplace);
      const now = Date.now();
      const fresh = new Set<string>();
      for (const r of (cached || []) as any[]) {
        if (r.expires_at && new Date(r.expires_at).getTime() > now) {
          nameMap[r.seller_id] = r.business_name || r.storefront_name || r.seller_id;
          fresh.add(r.seller_id);
        }
      }
      const missing = sellerIds.filter(id => !fresh.has(id));
      if (missing.length) {
        try {
          const upserts: any[] = [];
          for (let i = 0; i < missing.length; i += 100) {
            const slice = missing.slice(i, i + 100);
            const sUrl = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domainId}&seller=${slice.join(',')}`;
            // Second Keepa spend on the same page load, so it claims too.
            // Plain /seller measured 1 token per seller on 2026-08-15 -- note
            // the flat 10 belongs to /seller?storefront=1, a different endpoint
            // this call does not use. Refusal just skips the batch: seller
            // NAMES are cosmetic here, so the snapshot still renders with ids.
            const sellerSlot = await acquireKeepaTokensOnly(supabase, {
              estimatedTokens: slice.length,
              minReserve: KEEPA_RESERVE.interactive,
            });
            if (!sellerSlot.ok) {
              console.warn('[analyzer-product-snapshot] seller-name budget busy, showing ids');
              break;
            }
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 12000);
            const sRes = await fetch(sUrl, { signal: ctrl.signal });
            clearTimeout(t);
            if (!sRes.ok) {
              // The seller lookup is a SECOND Keepa spend on the same page
              // load (a flat 10 tokens per call, measured), so its refusals
              // matter as much as the product call's. Previously it just
              // `continue`d and the failure vanished.
              if (sRes.status === 429) {
                await recordKeepa429(supabase, undefined, 'analyzer-product-snapshot /seller');
              }
              continue;
            }
            const sJson = await sRes.json();
            await reportKeepaTokensLeft(supabase, sJson?.tokensLeft, sJson?.refillRate);
            const sellers = sJson?.sellers || {};
            for (const id of slice) {
              const s = sellers[id];
              const business = s?.sellerName || s?.businessName || null;
              const storefront = s?.storefrontName || s?.sellerName || null;
              const display = business || storefront || id;
              nameMap[id] = display;
              upserts.push({
                seller_id: id, marketplace,
                business_name: business, storefront_name: storefront,
                is_amazon: false,
                fetched_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              });
            }
          }
          if (upserts.length) await supabase.from('keepa_seller_name_cache').upsert(upserts, { onConflict: 'seller_id,marketplace' });
        } catch (e) {
          console.warn('[analyzer-product-snapshot] seller name lookup failed', (e as Error).message);
        }
      }
    }

    let offers = rawOffers.map((o: any) => ({
      ...o,
      sellerName: o.sellerName || (o.sellerId ? nameMap[o.sellerId] || o.sellerId : null),
    }));

    // SP-API live overlay — matches what the Chrome extension shows.
    // mobile-scan-price-history fetches GetItemOffers (live BB/competitors) with the
    // user's seller authorization, so the analyzer page sees the same accurate live
    // offer list as the extension. Best-effort: keep Keepa offers if SP-API fails.
    const liveOffers = await fetchLiveAnalyzerOffers(auth, asin, marketplace, force);
    if (liveOffers?.length) offers = mergeOfferStocks(liveOffers, offers);

    const fbaOffers = offers.filter((o: any) => o.type === 'FBA').length;
    const fbmOffers = offers.filter((o: any) => o.type === 'FBM').length;

    // Identity / dimensions (Keepa returns mm and grams)
    const mmToIn = (v: number | null) => v && v > 0 ? +(v / 25.4).toFixed(2) : null;
    const gToLb = (v: number | null) => v && v > 0 ? +(v / 453.592).toFixed(3) : null;

    const identity = {
      title: p.title ?? null,
      brand: p.brand ?? null,
      category: p.categoryTree?.[p.categoryTree.length - 1]?.name ?? null,
      image: p.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${p.imagesCSV.split(',')[0]}` : null,
      reviewCount: p.reviewCount ?? lastVal(csv[17], false),
      rating: typeof p.rating === 'number' ? p.rating / 10 : null,
      productGroup: p.productGroup ?? null,
      packageDimensions: {
        length: mmToIn(p.packageLength),
        width: mmToIn(p.packageWidth),
        height: mmToIn(p.packageHeight),
        weight: gToLb(p.packageWeight),
        unit: 'in/lb',
      },
      itemDimensions: {
        length: mmToIn(p.itemLength),
        width: mmToIn(p.itemWidth),
        height: mmToIn(p.itemHeight),
        weight: gToLb(p.itemWeight),
        unit: 'in/lb',
      },
    };

    const currentBsr = statsField(stats, CSV.SALES_RANK, false).current ?? lastVal(csv[CSV.SALES_RANK], false);
    const topPct = bsrTopPercent(currentBsr, p.categoryTree?.[0]?.catId ? null : null) ?? null;

    // Alerts / diagnostics
    const isHazmat = !!p.hazardousMaterialType;
    const isMeltable = (p.productGroup || '').toLowerCase().includes('grocery') || (identity.category || '').toLowerCase().includes('chocolate');
    const hasVariations = Array.isArray(p.variations) && p.variations.length > 0;
    const amazonCurrent = statsField(stats, CSV.AMAZON, true).current;
    const amazonAvg90 = statsField(stats, CSV.AMAZON, true).avg90;
    const amazonOnListing = (amazonCurrent != null) || (amazonAvg90 != null);

    // Private Label alert — was hardcoded to status:'good', value:'Unlikely'
    // regardless of the actual listing (no classifier was ever wired up).
    // Now reflects the real plResult computed above.
    const plAlertStatus: 'good' | 'warn' | 'bad' | 'info' =
      plResult.level === 'High' ? 'bad'
      : plResult.level === 'Medium' ? 'warn'
      : plResult.level === 'Low' ? 'good'
      : 'info';
    const plAlertValue = plResult.level === 'unknown' ? plRiskLabel : `${plResult.level} Risk`;

    // Size tier from all three sides and the weight, not from packageHeight
    // alone -- see fbaSizeTier.ts for what the single-axis test got wrong and
    // why this must keep agreeing with the Chrome panel.
    const sizeTier = classifyFbaSizeTier({
      lengthMm: p.packageLength,
      widthMm: p.packageWidth,
      heightMm: p.packageHeight,
      weightG: p.packageWeight,
    });

    const alerts: AnalyzerSnapshot['alerts'] = [
      { key: 'eligibility', label: 'Eligibility', status: 'info', value: 'Connect Amazon to verify' },
      { key: 'hazmat', label: 'Hazmat', status: isHazmat ? 'bad' : 'good', value: isHazmat ? 'Yes' : 'No' },
      { key: 'dangerous', label: 'Dangerous Goods', status: isHazmat ? 'warn' : 'good', value: isHazmat ? 'Likely' : 'No' },
      { key: 'amazon_share', label: 'Amazon Share Buy Box', status: amazonOnListing ? 'warn' : 'good', value: amazonOnListing ? 'Sometimes' : 'Never on Listing' },
      { key: 'private_label', label: 'Private Label', status: plAlertStatus, value: plAlertValue },
      { key: 'ip', label: 'IP Analysis', status: 'good', value: 'No known IP issues' },
      { key: 'size', label: 'Size', status: sizeTier.status, value: sizeTier.text },
      { key: 'meltable', label: 'Meltable', status: isMeltable ? 'warn' : 'good', value: isMeltable ? 'Yes' : 'No' },
      { key: 'variations', label: 'Variations', status: hasVariations ? 'info' : 'good', value: hasVariations ? `${p.variations.length}` : 'No' },
    ];

    const snap: AnalyzerSnapshot = {
      asin,
      marketplace,
      fetchedAt: new Date().toISOString(),
      cached: false,
      identity,
      alerts,
      quickInfo: {
        eligible: null,
        alertsCount: alerts.filter(a => a.status === 'warn' || a.status === 'bad').length,
        bsr: currentBsr,
        bsrTopPercent: topPct,
        estimatedSales: estimateSales(currentBsr),
        salesPerMonth: typeof p.monthlySold === 'number' ? p.monthlySold : null,
        bsrDrops30: typeof stats?.salesRankDrops30 === 'number' ? stats.salesRankDrops30 : null,
        bbPriceChanges30: typeof stats?.buyBoxPriceChanges30 === 'number' ? stats.buyBoxPriceChanges30 : null,
        lastChecked: new Date().toISOString(),
      },
      offers,
      series,
      ranksPrices: {
        bsr: statsField(stats, CSV.SALES_RANK, false),
        buyBox: statsField(stats, CSV.BUY_BOX, true),
        amazon: statsField(stats, CSV.AMAZON, true),
        newFba: statsField(stats, CSV.NEW_FBA, true),
        offerCount: statsField(stats, CSV.COUNT_NEW, false),
      },
      computed: { fbaOffers, fbmOffers, totalOffers: offers.length },
      plRisk: {
        label: plRiskLabel,
        level: plResult.level,
        normalizedScore: plResult.normalizedScore,
        text: plResult.text,
      },
    };


    // Persist into per-user 24h cache (best-effort)
    try {
      await supabase.from('product_analyzer_snapshot_cache').upsert({
        user_id: user.id,
        asin,
        marketplace,
        snapshot: snap,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'user_id,asin,marketplace' });
    } catch (e) {
      console.warn('[analyzer-product-snapshot] cache upsert failed', (e as Error).message);
    }

    return new Response(JSON.stringify(snap), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[analyzer-product-snapshot] error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
