-- READ-ONLY PROBE. asin_brand_cache knows the brand for only 53 of the 1,190
-- ghosted ASINs (4.5%), so an exclusion list built from it would cover almost
-- nothing. Find every column in the database that holds a brand, and measure
-- which one actually covers these ASINs before building the list.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== every brand-ish column in public ==';
  FOR r IN SELECT table_name, column_name
           FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name ILIKE '%brand%'
           ORDER BY table_name, column_name LOOP
    RAISE NOTICE '  %.%', r.table_name, r.column_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== coverage of the ghosted ASINs, per source ==';

  CREATE TEMP TABLE _ghosts ON COMMIT DROP AS
  SELECT DISTINCT asin FROM public.inventory
  WHERE upper(COALESCE(listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
    AND asin IS NOT NULL;

  FOR r IN SELECT count(*) AS n FROM _ghosts LOOP
    RAISE NOTICE '  ghosted ASINs total: %', r.n;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM _ghosts g
           JOIN public.asin_brand_cache c ON c.asin = g.asin
           WHERE NULLIF(btrim(c.brand), '') IS NOT NULL LOOP
    RAISE NOTICE '  asin_brand_cache.brand      : %', r.n;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM _ghosts g
           JOIN public.asin_brand_cache c ON c.asin = g.asin
           WHERE NULLIF(btrim(c.title), '') IS NOT NULL LOOP
    RAISE NOTICE '  asin_brand_cache.title      : % (a title can yield a brand)', r.n;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM _ghosts g
           JOIN public.inventory i ON i.asin = g.asin
           WHERE NULLIF(btrim(i.title), '') IS NOT NULL LOOP
    RAISE NOTICE '  inventory.title             : %', r.n;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM _ghosts g
           JOIN public.created_listings cl ON cl.asin = g.asin
           WHERE NULLIF(btrim(cl.title), '') IS NOT NULL LOOP
    RAISE NOTICE '  created_listings.title      : %', r.n;
  END LOOP;

  -- (removed: sales_orders has no product_name column; that query failed and
  --  blocked the migration queue, which is why this file is edited rather than
  --  deleted. Title coverage above is the useful part: inventory.title 2,106
  --  rows and created_listings.title 1,995, against only 53 known brands.)

END
$p$;
