/**
 * Fill asin_brand_cache for watched-seller catalogues, a bounded slice at a time.
 *
 * ---- WHY ----------------------------------------------------------------
 *
 * seller_watchlist.known_asin_list holds every watched seller's full current
 * ASIN list, but ASINs ONLY -- no brand. So "what does this seller sell that
 * matches my brands" could only be answered for ASINs we happened to have
 * detected as new. Measured 2026-09-03: seller AQTA8KNPZ5FJ2 lists 55,330
 * items and we knew the brand of 160; five of the ten largest catalogues had
 * brand data for zero, because a first check seeds the baseline without
 * detecting anything.
 *
 * ---- WHY THIS DOES NOT COMPETE WITH THE REPRICER ------------------------
 *
 * Amazon rate-limits PER OPERATION. The repricer's getItemOffers runs on the
 * 'pricing_api' bucket; searchCatalogItems runs on 'catalog_api'. Different
 * quota, no contention -- the same reasoning backfill-asin-brands records.
 * Nothing is paused for this.
 *
 * It DOES share catalog_api with enrich-missing-titles, classify-listing-brands
 * and check-seller-watchlist's image/category lookups, which is why
 * fetchCatalogItemsBatch now honours waitForApiToken's return value instead of
 * discarding it: 15,845 batched calls that each ignore a refused token would
 * push past 2 req/s and throttle those three as well as itself.
 *
 * ---- BOUNDED, NOT ONE LONG RUN -----------------------------------------
 *
 * Every batch commits and the next invocation resumes from checked_at, so a
 * killed isolate loses at most one slice. This database has a documented case
 * of a job too big for its window compounding into the next night and never
 * recovering; bounded work that records progress cannot do that. The deadline
 * is enforced against a wall clock, not assumed from the batch size.
 *
 * ---- checked_at IS STAMPED EVEN ON A MISS ------------------------------
 *
 * getCatalogItem returns a brand about 78% of the time; for the rest Amazon
 * genuinely has none. Without stamping the attempt those are indistinguishable
 * from "not tried yet" and the backfill re-asks the same blanks forever,
 * spending quota to learn nothing. checked_at carries the attempt; brand
 * carries the answer.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalCall } from "../_shared/require-internal.ts";
import {
  fetchCatalogItemsBatch,
  getCatalogAccessToken,
  CATALOG_BATCH_SIZE,
} from "../_shared/spapi-catalog-image.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Defaults sized for a cron slice, not for speed. 1,500 ASINs is 75 batched
// calls; at the bucket's 2 req/s that is ~38s of API time, inside the wall
// clock below with room for the database round trips.
const DEFAULT_MAX_ASINS = 1500;
const DEFAULT_SELLERS = 40;
const DEFAULT_PER_SELLER = 100;
const DEFAULT_MAX_SECONDS = 55;

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.min(hi, Math.max(lo, v));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const maxAsins = clamp(body.maxAsins, 20, 5000, DEFAULT_MAX_ASINS);
    const sellers = clamp(body.sellers, 1, 500, DEFAULT_SELLERS);
    const perSeller = clamp(body.perSeller, 1, 1000, DEFAULT_PER_SELLER);
    const maxSeconds = clamp(body.maxSeconds, 10, 300, DEFAULT_MAX_SECONDS);
    const dryRun = body.dryRun === true;
    const deadlineAt = Date.now() + maxSeconds * 1000;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // How much is left, for the caller's progress reporting.
    const { count: pendingBefore } = await admin
      .from("asin_brand_cache")
      .select("asin", { count: "exact", head: true })
      .is("checked_at", null);

    const { data: claimed, error: claimErr } = await admin.rpc(
      "claim_catalog_backfill_asins",
      { p_sellers: sellers, p_per_seller: perSeller, p_max: maxAsins },
    );
    if (claimErr) throw claimErr;

    const rows = (claimed as { asin: string; marketplace: string }[]) || [];
    if (rows.length === 0) {
      return json({
        ok: true,
        done: true,
        message: "Nothing pending -- every queued ASIN has been checked.",
        pendingBefore: pendingBefore ?? 0,
      });
    }

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        claimed: rows.length,
        sample: rows.slice(0, 5),
        pendingBefore: pendingBefore ?? 0,
      });
    }

    // Group by marketplace: the catalog call is marketplace-scoped, and asking
    // the wrong one returns nothing rather than erroring -- a silent miss that
    // would then be stamped as "checked, no brand" and never retried.
    const byMarket = new Map<string, string[]>();
    for (const r of rows) {
      const m = r.marketplace || "US";
      if (!byMarket.has(m)) byMarket.set(m, []);
      byMarket.get(m)!.push(r.asin);
    }

    let looked = 0, withBrand = 0, missing = 0, skippedNoToken = 0;
    const marketplacesDone: string[] = [];

    for (const [marketplace, asins] of byMarket) {
      if (Date.now() >= deadlineAt) break;

      // One token per marketplace. The user id only steers WHICH authorisation
      // is preferred; getCatalogAccessToken falls back to the shared
      // SPAPI_REFRESH_TOKEN, so a marketplace nobody has authorised still works.
      const { data: anyWatch } = await admin
        .from("seller_watchlist")
        .select("user_id")
        .eq("marketplace", marketplace)
        .limit(1)
        .maybeSingle();

      const token = await getCatalogAccessToken(
        admin,
        anyWatch?.user_id ?? "",
        marketplace,
      );
      if (!token) {
        // Deliberately NOT stamped as checked: no token is our failure, not
        // Amazon saying "no brand". Stamping would bake the gap in permanently.
        skippedNoToken += asins.length;
        console.warn(`[backfill-catalog-brands] no SP-API token for ${marketplace}, skipping ${asins.length}`);
        continue;
      }

      // Slice so the wall clock is checked between calls rather than only
      // between marketplaces -- with one marketplace (US is all of them today)
      // the outer check would never fire mid-run.
      const SLICE = CATALOG_BATCH_SIZE * 10; // 200 ASINs = 10 batched calls
      for (let i = 0; i < asins.length; i += SLICE) {
        if (Date.now() >= deadlineAt) break;
        const slice = asins.slice(i, i + SLICE);

        const found = await fetchCatalogItemsBatch(admin, token, slice, marketplace);

        const upserts = slice.map((asin) => {
          const hit = found.get(asin);
          const brand = hit?.brand?.trim() || null;
          if (brand) withBrand++; else missing++;
          return {
            asin,
            brand,
            title: hit?.title ?? null,
            product_group: hit?.productGroup ?? null,
            checked_at: new Date().toISOString(),
            source: "spapi",
          };
        });

        // An ASIN absent from `found` is stamped too -- see the header. The
        // whole slice goes in one upsert so a timeout cannot leave half of it
        // looked-up-but-unrecorded, which would spend the quota twice.
        const { error: upErr } = await admin
          .from("asin_brand_cache")
          .upsert(upserts, { onConflict: "asin" });
        if (upErr) {
          console.error("[backfill-catalog-brands] upsert failed:", upErr.message);
          throw upErr;
        }
        looked += slice.length;
      }
      marketplacesDone.push(marketplace);
    }

    const { count: pendingAfter } = await admin
      .from("asin_brand_cache")
      .select("asin", { count: "exact", head: true })
      .is("checked_at", null);

    return json({
      ok: true,
      claimed: rows.length,
      looked,
      withBrand,
      missing,
      skippedNoToken,
      hitRate: looked ? Math.round((withBrand / looked) * 1000) / 10 : null,
      marketplaces: marketplacesDone,
      pendingBefore: pendingBefore ?? 0,
      pendingAfter: pendingAfter ?? 0,
      done: (pendingAfter ?? 0) === 0,
    });
  } catch (e) {
    console.error("[backfill-catalog-brands] failed:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
