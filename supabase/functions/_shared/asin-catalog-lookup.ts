// Resolve ASIN title/image from catalog tables we already populate, before
// spending anything external.
//
// Mirrors what extension-create/background.js does when creating a listing:
// it walks local tables (inventory, then created_listings) rather than insert
// image_url = null, with the comment "so we don't insert image_url=null".
// Same principle here, different tables -- inventory and created_listings hold
// only the user's OWN products, and seller-watch listings are by definition
// somebody else's, so those would never hit. The Keepa-derived catalogs below
// are global and cover arbitrary ASINs.
//
// WHY THIS IS NEEDED: a brand-new listing is exactly the case where Keepa's
// product record is thinnest. Confirmed live 2026-08-15 -- a new-listing row
// came back with a title but imagesCSV absent, so the row stored image_url
// null and the UI fell back to a placeholder icon. Keepa fills images in as it
// crawls, so a later lookup often succeeds where the first one failed.
//
// Deliberately NOT solved with the ASIN-keyed Amazon image endpoints
// (images.amazon.com/images/P/<ASIN>.01._SCLZZZZZZZ_.jpg and the
// m.media-amazon.com equivalent). Both were tested against the failing ASIN
// and returned 1x1 pixel placeholders rather than 404s -- they would have
// rendered as invisible images and looked fixed while showing nothing.
//
// Costs zero Keepa tokens: every source here is a table this app already
// fills from its own earlier Keepa calls.


// ── WHY EVERY .in() HERE IS CHUNKED (2026-09-01) ──────────────────────────
//
// supabase-js expands .in('asin', [...]) straight into the query STRING:
// asin=in.(A,B,C,...). Each ASIN costs ~13 characters once the separating
// comma is percent-encoded, so a few hundred ASINs builds a URL of tens of
// thousands of characters and Deno rejects it outright with
// `TypeError: Invalid URL` -- not an HTTP error, a throw before any request
// leaves the isolate.
//
// This killed check-seller-watchlist for ten days. The cascade is the
// instructive part: the read failed, so the caller saw an EMPTY cache, so it
// asked check-product-eligibility to resolve EVERY ASIN, which returned 504,
// which burned the CPU budget until the platform killed the isolate mid-run --
// leaving no cron_run_history row at all, which is why the job looked simply
// absent rather than broken. Three symptoms, one unbounded URL.
//
// 150 per request keeps the query string near 2 KB with room to spare.
const IN_CHUNK = 150;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface CatalogDetails {
  title: string | null;
  image: string | null;
}

/** Global, Keepa-derived catalogs, richest first. */
const CATALOG_SOURCES = [
  'product_catalog',
  'keepa_catalog_products',
  'keepa_products',
  'keepa_simple_products',
] as const;

/**
 * Look up title/image for the given ASINs across the local catalogs.
 *
 * Returns only what it finds -- callers keep whatever they already have and
 * use this to fill the gaps. Queries stop early once every ASIN is resolved,
 * so the common case (everything already known) costs a single query.
 */
export async function lookupAsinDetails(
  supabase: any,
  asins: string[],
): Promise<Map<string, CatalogDetails>> {
  const found = new Map<string, CatalogDetails>();
  if (!asins.length) return found;

  let outstanding = [...new Set(asins)];

  for (const table of CATALOG_SOURCES) {
    if (!outstanding.length) break;

    let tableFailed = false;
    for (const batch of chunk(outstanding, IN_CHUNK)) {
      const { data, error } = await supabase
        .from(table)
        .select('asin, title, image_url')
        .in('asin', batch);

      if (error) {
        // A missing or renamed table must not break the caller's main job --
        // an absent image is cosmetic, a failed seller check is not.
        console.warn(`[asin-catalog-lookup] ${table} unavailable:`, error.message);
        tableFailed = true;
        break;
      }

      for (const row of data || []) {
        if (!row?.asin) continue;
        const prev = found.get(row.asin);
        const title = prev?.title ?? (row.title || null);
        const image = prev?.image ?? (row.image_url || null);
        found.set(row.asin, { title, image });
      }
    }
    if (tableFailed) continue;

    // Only keep looking for ASINs still missing an IMAGE -- that is the field
    // this exists to fill. An ASIN with a title but no image stays in the
    // list so a later table can still supply the picture.
    outstanding = outstanding.filter((a) => !found.get(a)?.image);
  }

  return found;
}
