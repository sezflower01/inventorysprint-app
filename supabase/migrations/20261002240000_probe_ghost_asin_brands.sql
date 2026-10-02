-- READ-ONLY PROBE. Brands behind the ghosted (NOT_IN_CATALOG / DELETED)
-- inventory rows, for a lead-source exclusion list.
--
-- Split deliberately into two groups, because they are NOT equivalent:
--   * brands that appear ONLY on ghosted rows -- safe to exclude from leads;
--   * brands that also have live listings -- excluding those would block
--     sourcing for products still selling, which is worse than the noise the
--     exclusion was meant to remove.
-- inventory has no brand column, so brands come from asin_brand_cache.

DO $p$
DECLARE r record; n_ghost int; n_named int;
BEGIN
  CREATE TEMP TABLE _ghosts ON COMMIT DROP AS
  SELECT DISTINCT i.asin
  FROM public.inventory i
  WHERE upper(COALESCE(i.listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED');

  CREATE TEMP TABLE _live ON COMMIT DROP AS
  SELECT DISTINCT i.asin
  FROM public.inventory i
  WHERE upper(COALESCE(i.listing_status, '')) NOT IN ('NOT_IN_CATALOG', 'DELETED');

  SELECT count(*) INTO n_ghost FROM _ghosts;
  RAISE NOTICE 'ghosted ASINs: %', n_ghost;

  CREATE TEMP TABLE _gb ON COMMIT DROP AS
  SELECT g.asin, NULLIF(btrim(c.brand), '') AS brand
  FROM _ghosts g
  LEFT JOIN public.asin_brand_cache c ON c.asin = g.asin;

  SELECT count(*) INTO n_named FROM _gb WHERE brand IS NOT NULL;
  RAISE NOTICE 'of those, % have a known brand (%.0f%%), % do not',
    n_named, (100.0 * n_named / NULLIF(n_ghost, 0)), n_ghost - n_named;

  RAISE NOTICE '';
  RAISE NOTICE '=== GROUP A: brands seen ONLY on ghosted listings (safe to exclude) ===';
  FOR r IN
    SELECT b.brand, count(DISTINCT b.asin) AS ghost_asins
    FROM _gb b
    WHERE b.brand IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM _live l
        JOIN public.asin_brand_cache lc ON lc.asin = l.asin
        WHERE NULLIF(btrim(lc.brand), '') = b.brand)
    GROUP BY 1 ORDER BY 2 DESC, 1
  LOOP
    RAISE NOTICE '  % (% dead ASIN(s))', r.brand, r.ghost_asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== GROUP B: brands with ghosts BUT ALSO live listings (do NOT exclude) ===';
  FOR r IN
    SELECT b.brand, count(DISTINCT b.asin) AS ghost_asins,
           (SELECT count(DISTINCT l.asin) FROM _live l
            JOIN public.asin_brand_cache lc ON lc.asin = l.asin
            WHERE NULLIF(btrim(lc.brand), '') = b.brand) AS live_asins
    FROM _gb b
    WHERE b.brand IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM _live l
        JOIN public.asin_brand_cache lc ON lc.asin = l.asin
        WHERE NULLIF(btrim(lc.brand), '') = b.brand)
    GROUP BY 1 ORDER BY 2 DESC, 1
  LOOP
    RAISE NOTICE '  % — % dead, % LIVE', r.brand, r.ghost_asins, r.live_asins;
  END LOOP;
END
$p$;
