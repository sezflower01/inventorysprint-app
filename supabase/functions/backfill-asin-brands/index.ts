/**
 * Fill inventory.brand from SP-API, a bounded batch at a time.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * "Identify all brands I already have" was unanswerable on 2026-08-30: 4,262 of
 * ~4,285 inventory ASINs had no brand anywhere. Brand only existed via a join
 * to product_catalog / keepa_*, which are Keepa-derived and therefore cover
 * almost nothing (Keepa is token-metered and gated at 20 tokens/min).
 *
 * getCatalogItem returns summaries[].brand for free. Four functions here
 * already parse it, so this reuses verify-store-scan-match/_amazon-catalog.ts
 * rather than writing a fifth copy of the same normalisation.
 *
 * ── THE REPRICER DOES NOT NEED PAUSING ────────────────────────────────────
 *
 * Amazon rate-limits PER OPERATION. _shared/rate-limiter.ts's `pricing_api`
 * bucket covers getItemOffers / getCompetitivePricing at ~0.5/s;
 * getCatalogItem is a separate operation with its own quota and is not one of
 * the ten functions sharing that bucket. This backfill and repricing do not
 * compete, so nothing is paused for it.
 *
 * ── BOUNDED, NOT ONE BIG RUN ──────────────────────────────────────────────
 *
 * BATCH_SIZE caps each invocation. 4,262 ASINs could be done in one long pass,
 * but an edge function that runs for many minutes is one timeout away from
 * losing everything it did, and this database already has a documented pattern
 * of a cleanup that cannot finish inside its window compounding into the next
 * run. Bounded work that records progress as it goes cannot do that: every
 * batch commits, and the next invocation resumes from brand_checked_at.
 *
 * ── WHY brand_checked_at IS STAMPED EVEN ON A MISS ────────────────────────
 *
 * Plenty of ASINs genuinely have no brand in Amazon's catalogue. Without a
 * timestamp on the attempt, those look identical to "not tried yet" and the
 * backfill re-asks for the same blanks on every pass forever, spending quota
 * to learn nothing. The column carries the attempt; brand carries the answer.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchAmazonDetailsBatch } from "../verify-store-scan-match/_amazon-catalog.ts";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// One invocation's worth. 200 ASINs at the fetcher's 4-way concurrency is well
// inside the function timeout with room to spare, and clears 4,262 in ~22 runs.
const BATCH_SIZE = 200;

// Which table to fill in. Parameterised rather than cloned into a second
// function: the lookup, the dedupe, the miss-stamping and the product_catalog
// caching are identical, and two copies would drift the moment one is fixed.
//
// `inventory` was done on 2026-08-30. `seller_watch_new_listings` follows
// because "not one of my brands" is about to drive DELETION, and today 6,161
// of 8,181 detections have no brand at all -- deleting on that would destroy
// rows whose brand was merely never looked up.
const TARGETS = {
  inventory: { table: 'inventory', writesManufacturer: true },
  listings:  { table: 'seller_watch_new_listings', writesManufacturer: false },
} as const;
type TargetKey = keyof typeof TARGETS;
const MAX_BATCH = 500;

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

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const targetKey: TargetKey = body?.target === 'listings' ? 'listings' : 'inventory';
    const target = TARGETS[targetKey];
    const limit = Math.min(
      Math.max(Number(body?.limit) || BATCH_SIZE, 1),
      MAX_BATCH,
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Distinct ASINs, not rows: the same ASIN often has several SKUs, and
    // asking Amazon once per SKU would multiply the work for one answer.
    const { data: rows, error } = await supabase
      .from(target.table)
      .select("asin")
      .is("brand_checked_at", null)
      .not("asin", "is", null)
      .limit(limit * 4);
    if (error) return json({ error: error.message }, 500);

    const asins = Array.from(new Set((rows ?? []).map((r: any) => r.asin).filter(Boolean))).slice(0, limit);
    if (asins.length === 0) {
      return json({ done: true, target: targetKey, message: `No ${target.table} rows awaiting a brand lookup.` });
    }

    const { count: remainingBefore } = await supabase
      .from(target.table)
      .select("asin", { count: "exact", head: true })
      .is("brand_checked_at", null);

    if (dryRun) {
      return json({ dryRun: true, target: targetKey, wouldLookUp: asins.length, sample: asins.slice(0, 10), rowsRemaining: remainingBefore ?? null });
    }

    const details = await fetchAmazonDetailsBatch(asins);

    const now = new Date().toISOString();
    let withBrand = 0;
    let checked = 0;

    for (const asin of asins) {
      const d = details.get(asin);
      const brand = d?.brand ?? null;
      const manufacturer = d?.manufacturer ?? null;

      // Written per ASIN, so every SKU sharing it gets the same answer and a
      // partial run still leaves everything it touched marked as done.
      // seller_watch_new_listings has no manufacturer column, so the patch is
      // built per target rather than sending a field the table lacks -- which
      // PostgREST rejects for the whole batch, not just that column.
      const patch: Record<string, unknown> = { brand, brand_checked_at: now };
      if (target.writesManufacturer) patch.manufacturer = manufacturer;

      const { error: upErr } = await supabase
        .from(target.table)
        .update(patch)
        .eq("asin", asin)
        .is("brand_checked_at", null);
      if (upErr) {
        console.warn(`[backfill-asin-brands] update failed for ${asin}:`, upErr.message);
        continue;
      }
      checked++;
      if (brand) withBrand++;

      // Cache globally too. product_catalog is the first source
      // _shared/asin-catalog-lookup.ts consults, so every other feature that
      // resolves an ASIN benefits from work already paid for here.
      if (brand || d?.title) {
        await supabase
          .from("product_catalog")
          .upsert({ asin, brand, title: d?.title ?? null, image_url: d?.image_url ?? null }, { onConflict: "asin" })
          .then(({ error: e }) => { if (e) console.warn(`[backfill-asin-brands] catalog cache ${asin}:`, e.message); });
      }
    }

    const { count: remainingAfter } = await supabase
      .from(target.table)
      .select("asin", { count: "exact", head: true })
      .is("brand_checked_at", null);

    return json({
      target: targetKey,
      askedAmazon: asins.length,
      asinsMarked: checked,
      brandsFound: withBrand,
      // Amazon genuinely has no brand for some ASINs. Reported rather than
      // hidden so a low hit rate reads as a fact about the catalogue, not as a
      // silent failure of this job.
      noBrandReturned: checked - withBrand,
      rowsRemaining: remainingAfter ?? null,
      rowsRemainingBefore: remainingBefore ?? null,
    });
  } catch (err) {
    console.error("[backfill-asin-brands]", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
