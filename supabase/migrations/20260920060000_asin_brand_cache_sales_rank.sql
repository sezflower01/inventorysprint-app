-- Store the sales rank Amazon returns, so "BSR —" can be explained instead of
-- guessed at.
--
-- Keepa has no rank for ~8% of scanned products (313 of 3,838 cached on
-- 2026-09-20). Extension 1.4.6 falls back to Amazon's own rank, which rides
-- free on the catalog call fetch-listing-snapshot already makes -- but nothing
-- kept it, so when a product still shows "—" there is no way to tell
-- "Amazon has no rank either" from "the fallback did not run". B0GZ9LNTJT is
-- exactly that case: Keepa has nothing, the panel is on 1.4.6, and the dash
-- persists.
--
-- asin_brand_cache is the existing ASIN-keyed catalog cache (brand, title,
-- product_group from SP-API), so the rank belongs beside them.

ALTER TABLE public.asin_brand_cache
  ADD COLUMN IF NOT EXISTS sales_rank    integer,
  ADD COLUMN IF NOT EXISTS sales_rank_at timestamptz;

COMMENT ON COLUMN public.asin_brand_cache.sales_rank IS
  'Broad department rank from SP-API Catalog Items salesRanks[].displayGroupRanks[] -- the number sellers mean by BSR, not the narrow classificationRanks. NULL means Amazon returned no rank for this ASIN.';
COMMENT ON COLUMN public.asin_brand_cache.sales_rank_at IS
  'When sales_rank was last read from Amazon. A rank moves daily, so age matters when it is shown.';
