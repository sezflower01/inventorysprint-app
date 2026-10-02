-- READ-ONLY PROBE. Build the ghost-ASIN brand list from EVERY source that
-- holds a brand, not just asin_brand_cache (which covered 53 of 1,190).
--
-- Precedence: inventory.brand first -- it was backfilled from SP-API for these
-- exact rows -- then the caches, then the catalogs. Still split into
--   A: brands seen ONLY on ghosted listings  -> safe to exclude from leads
--   B: brands that also have live listings   -> excluding them would block
--      sourcing for products still selling.

DO $p$
DECLARE r record; n int;
BEGIN
  CREATE TEMP TABLE _g ON COMMIT DROP AS
  SELECT DISTINCT asin FROM public.inventory
  WHERE upper(COALESCE(listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
    AND asin IS NOT NULL;

  CREATE TEMP TABLE _l ON COMMIT DROP AS
  SELECT DISTINCT asin FROM public.inventory
  WHERE upper(COALESCE(listing_status, '')) NOT IN ('NOT_IN_CATALOG', 'DELETED')
    AND asin IS NOT NULL;

  -- one brand per ASIN, best available source
  CREATE TEMP TABLE _brand ON COMMIT DROP AS
  SELECT a.asin,
         NULLIF(btrim(COALESCE(
           (SELECT i.brand FROM public.inventory i WHERE i.asin = a.asin AND NULLIF(btrim(i.brand), '') IS NOT NULL LIMIT 1),
           (SELECT c.brand FROM public.asin_brand_cache c WHERE c.asin = a.asin AND NULLIF(btrim(c.brand), '') IS NOT NULL LIMIT 1),
           (SELECT p.brand FROM public.product_catalog p WHERE p.asin = a.asin AND NULLIF(btrim(p.brand), '') IS NOT NULL LIMIT 1),
           (SELECT k.brand FROM public.keepa_products k WHERE k.asin = a.asin AND NULLIF(btrim(k.brand), '') IS NOT NULL LIMIT 1)
         )), '') AS brand  -- catalog_brands is keyed by brand, not asin, so it is not a lookup source here
  FROM (SELECT asin FROM _g UNION SELECT asin FROM _l) a;

  SELECT count(*) INTO n FROM _g;
  RAISE NOTICE 'ghosted ASINs: %', n;
  SELECT count(*) INTO n FROM _g g JOIN _brand b ON b.asin = g.asin WHERE b.brand IS NOT NULL;
  RAISE NOTICE 'ghosted ASINs with a brand from ANY source: %', n;
  SELECT count(DISTINCT b.brand) INTO n FROM _g g JOIN _brand b ON b.asin = g.asin WHERE b.brand IS NOT NULL;
  RAISE NOTICE 'distinct brands among them: %', n;

  RAISE NOTICE '';
  RAISE NOTICE '=== GROUP A: ghost-only brands (safe to exclude) ===';
  FOR r IN
    SELECT b.brand, count(DISTINCT b.asin) AS dead
    FROM _g g JOIN _brand b ON b.asin = g.asin
    WHERE b.brand IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM _l l JOIN _brand lb ON lb.asin = l.asin WHERE lb.brand = b.brand)
    GROUP BY 1 ORDER BY 2 DESC, 1
  LOOP
    RAISE NOTICE '%|%', r.brand, r.dead;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== GROUP B: also have live listings (do NOT exclude) — count only ===';
  SELECT count(DISTINCT b.brand) INTO n
  FROM _g g JOIN _brand b ON b.asin = g.asin
  WHERE b.brand IS NOT NULL
    AND EXISTS (SELECT 1 FROM _l l JOIN _brand lb ON lb.asin = l.asin WHERE lb.brand = b.brand);
  RAISE NOTICE '  % brand(s) excluded from the list for this reason', n;
END
$p$;
