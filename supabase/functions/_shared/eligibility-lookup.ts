// Read listing-eligibility verdicts for the auto-source filter.
//
// Reads user_approved_products, which check-product-eligibility already
// populates -- the SAME rows that drive the EligibilityBadge in the UI. No
// second store, so the badge a user sees and the filter the worker applies can
// never disagree about a product.
//
// When an ASIN has no verdict, the caller can ask for one to be fetched. That
// costs one listings_api call (5 req/s, ample headroom) and prevents spending
// the far more expensive chain -- a CSE query, up to three Gemini text
// verdicts, three vision compares and a scrape -- on something unsellable.
import type { EligibilityVerdict } from './source-qualification.ts';

const VALID: ReadonlySet<string> = new Set(['approved', 'approval_required', 'restricted']);

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

// Resolving is far more expensive than reading -- each call fans out to the
// listings API -- so it is chunked smaller AND capped. An uncapped first run
// on a large catalogue is exactly the shape that produced the 504 above.
const RESOLVE_CHUNK = 40;
const RESOLVE_MAX = 120;

/** Cached verdicts for these ASINs, keyed by ASIN. Missing = never checked. */
export async function readEligibility(
  supabase: any,
  userId: string,
  marketplace: string,
  asins: string[],
): Promise<Map<string, EligibilityVerdict>> {
  const out = new Map<string, EligibilityVerdict>();
  if (!asins.length) return out;
  try {
    for (const batch of chunk([...new Set(asins)], IN_CHUNK)) {
      const { data, error } = await supabase
        .from('user_approved_products')
        .select('asin, approval_status')
        .eq('user_id', userId)
        .eq('marketplace', marketplace)
        .in('asin', batch);
      if (error) {
        // Return what earlier batches found rather than nothing: a partial
        // cache still spares the caller the expensive resolve path for those
        // ASINs, and returning empty is what caused the 504 cascade.
        console.warn('[eligibility-lookup] read failed:', error.message);
        return out;
      }
      for (const row of data || []) {
        const v = String(row?.approval_status || '').toLowerCase();
        // Anything outside the known set is treated as UNKNOWN rather than
        // guessed at -- an unrecognised value must not silently disqualify.
        if (VALID.has(v)) out.set(row.asin, v as EligibilityVerdict);
      }
    }
  } catch (e) {
    console.warn('[eligibility-lookup] read error:', (e as Error).message);
  }
  return out;
}

/**
 * Ask check-product-eligibility to resolve ASINs with no cached verdict, then
 * return the freshly written rows.
 *
 * Sends BOTH headers deliberately: that function keeps verify_jwt = true
 * because the browser calls it, so the service-role bearer satisfies the
 * platform gateway while x-internal-secret is what its own logic checks.
 * Sending only the secret fails at the gateway with
 * UNAUTHORIZED_NO_AUTH_HEADER, before the function runs at all.
 */
export async function resolveEligibility(
  supabase: any,
  supabaseUrl: string,
  serviceRole: string,
  internalSecret: string,
  userId: string,
  marketplace: string,
  asins: string[],
): Promise<Map<string, EligibilityVerdict>> {
  if (!asins.length) return new Map();
  const unique = [...new Set(asins)];
  const target = unique.slice(0, RESOLVE_MAX);
  if (unique.length > target.length) {
    // Said out loud rather than silently truncated: a capped run that reports
    // itself complete is how this class of bug hides.
    console.warn(`[eligibility-lookup] resolving ${target.length} of ${unique.length} ASINs this run; rest stay unknown`);
  }
  for (const batch of chunk(target, RESOLVE_CHUNK)) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/check-product-eligibility`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
          Authorization: `Bearer ${serviceRole}`,
        },
        body: JSON.stringify({ userId, marketplace, asins: batch, force_rescan: false }),
      });
      if (!res.ok) {
        console.warn(`[eligibility-lookup] resolve HTTP ${res.status} (batch of ${batch.length})`);
        // Stop rather than grind through the remaining batches: a 504 here
        // means the downstream function is already struggling, and continuing
        // is what exhausted the CPU budget.
        break;
      }
    } catch (e) {
      console.warn('[eligibility-lookup] resolve failed:', (e as Error).message);
      break;
    }
  }
  // Re-read rather than trusting the response shape -- the table is the thing
  // the UI reads too, so agreeing with it matters more than the payload.
  return readEligibility(supabase, userId, marketplace, asins);
}
