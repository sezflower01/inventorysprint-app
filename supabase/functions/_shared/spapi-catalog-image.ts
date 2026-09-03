// Fetch an ASIN's title and main image from SP-API Catalog Items.
//
// WHY THIS EXISTS: Keepa is the primary source for new-listing metadata, but a
// brand-new listing is exactly when Keepa's record is thinnest -- confirmed
// live 2026-08-15, a new-listing row came back with a title and no imagesCSV,
// so the UI showed a placeholder icon. SP-API's catalog is Amazon's own data
// and has the image immediately.
//
// The decisive advantage is quota: SP-API is a COMPLETELY SEPARATE budget from
// Keepa. Catalog lookups here cost zero Keepa tokens, so they cannot slow the
// seller-watch rotation or starve the repricer, which is the constraint every
// other part of this feature is built around.
//
// Modelled on enrich-missing-titles, which already does exactly this
// (includedData=summaries,images, MAIN variant). That function is left
// untouched: it is live, and refactoring it is not the job of a change whose
// purpose is elsewhere. Its inline copy and this module should stay in step.
//
// Uses the UNSIGNED call style of listing-validation-worker -- just
// x-amz-access-token, no AWS SigV4. Amazon dropped the SigV4 requirement for
// SP-API, and the older signed helpers in this repo predate that.
import { exchangeLwaToken } from './lwa-token.ts';
import { waitForApiToken } from './rate-limiter.ts';
import { MARKETPLACE_META } from './marketplace-map.ts';

export interface CatalogItemDetails {
  title: string | null;
  image: string | null;
  /** summaries[].brand — Keepa's brand/manufacturer equivalent. */
  brand: string | null;
  /** identifiers[] UPC/EAN — Keepa's upcList equivalent. */
  upc: string | null;
  /**
   * summaries[].websiteDisplayGroupName — the TOP-LEVEL department (Book, DVD,
   * Toy). Deliberately not browseClassification, which returns leaf nodes like
   * "Toggle Valves" that no category rule could sensibly match.
   */
  productGroup: string | null;
  /**
   * salesRanks[].displayGroupRanks[].rank — the BROAD rank sellers mean by BSR.
   * Deliberately not classificationRanks, which is a narrow subcategory rank
   * ("PlayStation 4 Games" #194 against "Video Games" #4,540) and is not
   * comparable between products.
   */
  salesRank: number | null;
}

export const SPAPI_HOSTS: Record<string, string> = {
  US: 'sellingpartnerapi-na.amazon.com',
  CA: 'sellingpartnerapi-na.amazon.com',
  MX: 'sellingpartnerapi-na.amazon.com',
  BR: 'sellingpartnerapi-na.amazon.com',
  UK: 'sellingpartnerapi-eu.amazon.com',
  DE: 'sellingpartnerapi-eu.amazon.com',
  FR: 'sellingpartnerapi-eu.amazon.com',
  IT: 'sellingpartnerapi-eu.amazon.com',
  ES: 'sellingpartnerapi-eu.amazon.com',
  NL: 'sellingpartnerapi-eu.amazon.com',
  SE: 'sellingpartnerapi-eu.amazon.com',
  PL: 'sellingpartnerapi-eu.amazon.com',
  BE: 'sellingpartnerapi-eu.amazon.com',
  TR: 'sellingpartnerapi-eu.amazon.com',
  JP: 'sellingpartnerapi-fe.amazon.com',
  IN: 'sellingpartnerapi-fe.amazon.com',
};

/**
 * Resolve an access token for this user + marketplace.
 *
 * Prefers the user's own authorization for that marketplace, matching
 * create-amazon-listing, and falls back to the shared token. Returns null
 * rather than throwing -- an absent image must never fail the caller's real
 * work.
 */
export async function getCatalogAccessToken(
  supabase: any,
  userId: string,
  marketplaceCode: string,
): Promise<string | null> {
  try {
    const marketplaceId = MARKETPLACE_META[marketplaceCode]?.amazonMarketplaceId;
    if (!marketplaceId) return null;

    const { data: auth } = await supabase
      .from('seller_authorizations')
      .select('refresh_token')
      .eq('user_id', userId)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    const refreshToken = auth?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN');
    if (!refreshToken) return null;

    return await exchangeLwaToken(refreshToken, supabase, userId);
  } catch (e) {
    console.warn('[spapi-catalog-image] token exchange failed:', (e as Error).message);
    return null;
  }
}

/**
 * Look up one ASIN's title and MAIN image.
 *
 * Catalog Items has no batch form for this shape, so callers should bound how
 * many ASINs they resolve per run. Rate limited through the shared
 * 'catalog_api' bucket so it cannot outrun Amazon's quota or collide with the
 * other catalog callers in this project.
 */
export async function fetchCatalogItemDetails(
  supabase: any,
  accessToken: string,
  asin: string,
  marketplaceCode: string,
): Promise<CatalogItemDetails> {
  const empty: CatalogItemDetails = { title: null, image: null, brand: null, upc: null, productGroup: null, salesRank: null };
  try {
    const marketplaceId = MARKETPLACE_META[marketplaceCode]?.amazonMarketplaceId;
    const host = SPAPI_HOSTS[marketplaceCode];
    if (!marketplaceId || !host) return empty;

    await waitForApiToken(supabase, 'catalog_api');

    const url = new URL(`https://${host}/catalog/2022-04-01/items/${encodeURIComponent(asin)}`);
    url.searchParams.set('marketplaceIds', marketplaceId);
    // identifiers added so this covers everything the Keepa /product metadata
    // call was fetching (title, brand, image, upc) -- otherwise callers would
    // still need Keepa just for the barcode.
    // salesRanks rides along free -- same call, same catalog_api quota.
    url.searchParams.set('includedData', 'summaries,images,identifiers,salesRanks');

    const res = await fetch(url.toString(), {
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      // 404 simply means Amazon has no catalog record to offer -- not worth
      // a warning, unlike a throttle or auth failure.
      if (res.status !== 404) {
        console.warn(`[spapi-catalog-image] ${asin} HTTP ${res.status}`);
      }
      return empty;
    }

    const json = await res.json().catch(() => null);
    if (!json) return empty;
    return parseCatalogItem(json, marketplaceId);
  } catch (e) {
    console.warn(`[spapi-catalog-image] ${asin} failed:`, (e as Error).message);
    return empty;
  }
}

/**
 * Parse one Catalog Items record. Shared by the single-ASIN and batch calls --
 * both return the same item shape, so the field handling must not drift.
 */
function parseCatalogItem(json: any, marketplaceId: string): CatalogItemDetails {
  try {
    const summaries = json?.summaries || [];
    const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];

    const imageGroups = json?.images || [];
    const group = imageGroups.find((g: any) => g.marketplaceId === marketplaceId) || imageGroups[0];
    let image: string | null = null;
    if (group?.images?.length) {
      const main = group.images.find((i: any) => i.variant === 'MAIN') || group.images[0];
      image = main?.link || null;
    }

    // identifiers[] = [{ marketplaceId, identifiers: [{ identifierType, identifier }] }]
    // Prefer UPC, accept EAN -- Keepa's upcList carried either.
    let upc: string | null = null;
    const idGroups = json?.identifiers || [];
    const idGroup = idGroups.find((g: any) => g.marketplaceId === marketplaceId) || idGroups[0];
    if (idGroup?.identifiers?.length) {
      const byType = (t: string) => idGroup.identifiers.find((i: any) => i.identifierType === t)?.identifier;
      upc = byType('UPC') || byType('EAN') || null;
    }

    const rankGroup = (json?.salesRanks || []).find((r: any) => r.marketplaceId === marketplaceId)
      || (json?.salesRanks || [])[0];
    const broadRanks = (rankGroup?.displayGroupRanks || [])
      .map((r: any) => r?.rank).filter((n: any) => typeof n === 'number');

    return {
      title: summary?.itemName || null,
      image,
      brand: summary?.brand || summary?.manufacturer || null,
      upc,
      productGroup: summary?.websiteDisplayGroupName || summary?.websiteDisplayGroup || null,
      salesRank: broadRanks.length ? Math.min(...broadRanks) : null,
    };
  } catch {
    return { title: null, image: null, brand: null, upc: null, productGroup: null, salesRank: null };
  }
}

/** Catalog Items caps `identifiers` at 20 per request. */
export const CATALOG_BATCH_SIZE = 20;

/**
 * Resolve up to 20 ASINs in ONE Catalog Items call.
 *
 * The single-ASIN function above used to carry a comment claiming Catalog
 * Items "has no batch form for this shape". That was wrong, and it cost real
 * coverage: because each ASIN meant one HTTP call, check-seller-watchlist
 * capped itself at MAX_SPAPI_IMAGE_LOOKUPS = 12 per run, and SP-API is the
 * ONLY source of productGroup (the Keepa fallback supplies title/brand/image/
 * upc but no category). Measured 2026-08-17: product_group was resolved on
 * just 12% of 2,284 listings, so the category filter was deciding on data it
 * usually did not have -- and "unknown" deliberately qualifies.
 *
 * searchCatalogItems takes the same includedData, returns the same item shape,
 * and runs on the same catalog_api bucket. 50 ASINs goes from 50 calls to 3.
 * Strictly cheaper AND complete, which is why this replaces the cap rather
 * than merely raising it.
 *
 * Returns a Map keyed by ASIN; an ASIN Amazon has no record for is simply
 * absent rather than present-and-empty, so callers can tell "no data" from
 * "not looked up".
 */
export async function fetchCatalogItemsBatch(
  supabase: any,
  accessToken: string,
  asins: string[],
  marketplaceCode: string,
): Promise<Map<string, CatalogItemDetails>> {
  const out = new Map<string, CatalogItemDetails>();
  if (!asins.length) return out;

  const marketplaceId = MARKETPLACE_META[marketplaceCode]?.amazonMarketplaceId;
  const host = SPAPI_HOSTS[marketplaceCode];
  if (!marketplaceId || !host) return out;

  for (let i = 0; i < asins.length; i += CATALOG_BATCH_SIZE) {
    const chunk = asins.slice(i, i + CATALOG_BATCH_SIZE);
    try {
      // The return value MATTERS here and used to be discarded.
      // waitForApiToken fails OPEN: after maxWaitMs it logs, returns false and
      // lets the caller through, which is right for one interactive lookup and
      // wrong for a long backfill -- 15,845 batched calls that each ignore a
      // false would push clean past the bucket's 2 req/s and earn throttling
      // for every other catalog_api consumer, not just this one.
      //
      // Waiting longer than the default 8s is deliberate: a backfill has
      // nowhere to be, and yielding is cheaper than a 429.
      const gotToken = await waitForApiToken(supabase, 'catalog_api', { maxWaitMs: 30000 });
      if (!gotToken) {
        console.warn(`[spapi-catalog-image] no catalog_api token for ${chunk.length} ASINs -- skipping chunk`);
        continue; // left unchecked; the caller retries it on a later pass
      }

      const url = new URL(`https://${host}/catalog/2022-04-01/items`);
      url.searchParams.set('identifiers', chunk.join(','));
      url.searchParams.set('identifiersType', 'ASIN');
      url.searchParams.set('marketplaceIds', marketplaceId);
      url.searchParams.set('includedData', 'summaries,images,identifiers,salesRanks');
      url.searchParams.set('pageSize', String(CATALOG_BATCH_SIZE));

      const res = await fetch(url.toString(), {
        headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[spapi-catalog-image] batch of ${chunk.length} HTTP ${res.status}`);
        continue; // other chunks may still succeed
      }
      const json = await res.json().catch(() => null);
      for (const item of json?.items || []) {
        // Trust the ASIN Amazon echoes back, not our request order -- the
        // response is not guaranteed to be aligned with `identifiers`, and
        // mapping by position would silently mislabel every field.
        const asin = item?.asin;
        if (asin) out.set(asin, parseCatalogItem(item, marketplaceId));
      }
    } catch (e) {
      console.warn('[spapi-catalog-image] batch failed:', (e as Error).message);
    }
  }
  return out;
}
