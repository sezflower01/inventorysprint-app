-- Brand on inventory, plus a queue marker for backfilling it.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Asked 2026-08-30: "identify all brands I already have". Measured answer:
--
--   (unknown)   4,262 ASINs
--   Nintendo            3
--   GE                  2
--   ... 20 more brands, one ASIN each
--
-- 99.5% blank. Neither `inventory` nor `created_listings` carries a brand at
-- all, so the only source was a join to product_catalog / keepa_* -- and those
-- are Keepa-derived (see _shared/asin-catalog-lookup.ts), filled from this
-- app's own earlier Keepa calls. Keepa is token-metered and gated at 20
-- tokens/min, so it has only ever covered a handful of ASINs.
--
-- ── WHY NOT KEEPA TO FILL IT ──────────────────────────────────────────────
--
-- /product costs 1 token per ASIN. 4,262 ASINs is 4,262 tokens, roughly 3.5
-- hours of the ENTIRE account budget, which would starve the repricer for a
-- piece of reference data. SP-API getCatalogItem returns summaries[].brand for
-- free -- four functions in this repo already parse it -- so that is the source.
--
-- ── AND WHY THE REPRICER DOES NOT NEED PAUSING ────────────────────────────
--
-- The user offered to pause repricing to make room. It is not necessary and
-- the offer is worth answering in writing so nobody pauses it later for the
-- same reason: Amazon rate-limits PER OPERATION. The `pricing_api` bucket in
-- _shared/rate-limiter.ts covers getItemOffers / getCompetitivePricing at
-- ~0.5/s; getCatalogItem is a different operation with its own quota (~2/s)
-- and is not among the ten functions sharing that bucket. A catalog backfill
-- and the repricer do not compete.

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  -- Stamped on every attempt, success or not. Without it a backfill cannot
  -- distinguish "not looked up yet" from "looked up, Amazon returned no brand"
  -- and would re-ask for the same blanks on every run, forever.
  ADD COLUMN IF NOT EXISTS brand_checked_at timestamptz;

COMMENT ON COLUMN public.inventory.brand IS
  'SP-API summaries[].brand, falling back to attributes.brand. NULL with a non-null brand_checked_at means Amazon returned no brand for this ASIN.';
COMMENT ON COLUMN public.inventory.brand_checked_at IS
  'When the catalog lookup last ran. Set even when no brand came back, so the backfill does not retry known-blank ASINs on every pass.';

-- Drives the backfill: unchecked rows first, cheap to scan as the queue drains.
CREATE INDEX IF NOT EXISTS idx_inventory_brand_backfill
  ON public.inventory (user_id)
  WHERE brand_checked_at IS NULL;

-- For the actual question -- group by brand.
CREATE INDEX IF NOT EXISTS idx_inventory_brand
  ON public.inventory (user_id, brand)
  WHERE brand IS NOT NULL;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.inventory WHERE brand_checked_at IS NULL;
  RAISE NOTICE 'inventory.brand ready; % row(s) awaiting lookup', n;
END $$;
