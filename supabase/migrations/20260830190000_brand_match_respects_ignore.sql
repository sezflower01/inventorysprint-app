-- Let the user exclude a brand from matching, permanently.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- The "My brands only" filter matched 151 listings on 2026-08-30 and roughly
-- 90% were noise: WARNER BROS, UNIVERSAL, Simon & Schuster, Penguin, Square
-- Enix, Bandai Namco, Ubisoft, 2K, SEGA -- all at 0 units held.
--
-- They are in user_brands because selling a single DVD or paperback records its
-- studio or publisher as that item's "brand". They are an artefact of how
-- Amazon catalogues media, not brands anyone sources. WARNER BROS shows 9 ASINs
-- carried, so no automatic threshold on breadth separates it from a real brand
-- either.
--
-- ── WHY MANUAL ────────────────────────────────────────────────────────────
--
-- Every automatic rule tried on paper fails: ASIN count keeps WARNER BROS (9);
-- units held drops brands sold through, which are exactly the ones worth
-- restocking; product category is a property of a listing, not of a brand.
--
-- The distinction being drawn here is "is this a brand I actually source",
-- which is a judgement, not a computation. The same reasoning governs
-- source_excluded_terms, which is deliberately hand-curated. So this reads a
-- flag the user sets and applies no rule of its own.
--
-- status is otherwise free text and stays that way -- only the exact value
-- 'ignore' has any effect, so notes like 'watch' or 'seasonal' are unaffected.

CREATE OR REPLACE VIEW public.seller_new_listings_branded
WITH (security_invoker = true) AS
SELECT
  l.*,
  (b.brand IS NOT NULL) AS is_my_brand,
  b.unit_count  AS my_brand_units,
  b.asin_count  AS my_brand_asins
FROM public.seller_watch_new_listings l
LEFT JOIN public.user_brands b
  ON  b.user_id = l.user_id
  AND lower(trim(b.brand)) = lower(trim(l.brand))
  -- In the JOIN, not a WHERE: an ignored brand must make the listing read as
  -- NOT mine, so it disappears from the filter. A WHERE clause would drop the
  -- listing from the view entirely, hiding it even with the filter switched
  -- off -- which is a much bigger claim than the user made.
  AND COALESCE(b.status, '') <> 'ignore';

COMMENT ON VIEW public.seller_new_listings_branded IS
  'seller_watch_new_listings plus is_my_brand / my_brand_units / my_brand_asins from user_brands, matched case-insensitively. Brands with status = ''ignore'' never match. security_invoker so RLS still applies to the caller.';

GRANT SELECT ON public.seller_new_listings_branded TO authenticated;

DO $$
DECLARE
  v_ignored bigint;
  v_matches bigint;
BEGIN
  SELECT count(*) INTO v_ignored FROM public.user_brands WHERE status = 'ignore';
  SELECT count(*) INTO v_matches FROM public.seller_new_listings_branded WHERE is_my_brand;
  RAISE NOTICE '% brand(s) marked ignore; % listing(s) currently match.', v_ignored, v_matches;
  RAISE NOTICE 'Mark one with: update user_brands set status = ''ignore'' where brand = ''WARNER BROS'';';
END $$;
