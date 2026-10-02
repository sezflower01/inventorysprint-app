-- READ-ONLY EXPORT. Group A only -- brands that appear on ghosted
-- (NOT_IN_CATALOG / DELETED) listings and on NO live listing -- emitted as
-- "BRAND_A|<brand>|<dead asins>" so it can be machine-extracted into an
-- exclusion file without hand-copying.
--
-- Group B (brands with both dead and live listings) is deliberately NOT
-- exported: 442 of them, and excluding a brand that still has live listings
-- would block sourcing for products still selling.

DO $p$
DECLARE r record; n_g int; n_named int; n_brands int; n_a int; n_b int;
BEGIN
  CREATE TEMP TABLE _g ON COMMIT DROP AS
  SELECT DISTINCT asin FROM public.inventory
  WHERE upper(COALESCE(listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED') AND asin IS NOT NULL;

  CREATE TEMP TABLE _l ON COMMIT DROP AS
  SELECT DISTINCT asin FROM public.inventory
  WHERE upper(COALESCE(listing_status, '')) NOT IN ('NOT_IN_CATALOG', 'DELETED') AND asin IS NOT NULL;

  CREATE TEMP TABLE _brand ON COMMIT DROP AS
  SELECT a.asin,
         NULLIF(btrim(COALESCE(
           (SELECT i.brand FROM public.inventory i WHERE i.asin = a.asin AND NULLIF(btrim(i.brand), '') IS NOT NULL LIMIT 1),
           (SELECT c.brand FROM public.asin_brand_cache c WHERE c.asin = a.asin AND NULLIF(btrim(c.brand), '') IS NOT NULL LIMIT 1),
           (SELECT p.brand FROM public.product_catalog p WHERE p.asin = a.asin AND NULLIF(btrim(p.brand), '') IS NOT NULL LIMIT 1),
           (SELECT k.brand FROM public.keepa_products k WHERE k.asin = a.asin AND NULLIF(btrim(k.brand), '') IS NOT NULL LIMIT 1)
         )), '') AS brand
  FROM (SELECT asin FROM _g UNION SELECT asin FROM _l) a;

  SELECT count(*) INTO n_g FROM _g;
  SELECT count(*) INTO n_named FROM _g g JOIN _brand b ON b.asin = g.asin WHERE b.brand IS NOT NULL;
  SELECT count(DISTINCT b.brand) INTO n_brands FROM _g g JOIN _brand b ON b.asin = g.asin WHERE b.brand IS NOT NULL;

  CREATE TEMP TABLE _a ON COMMIT DROP AS
  SELECT b.brand, count(DISTINCT b.asin) AS dead
  FROM _g g JOIN _brand b ON b.asin = g.asin
  WHERE b.brand IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM _l l JOIN _brand lb ON lb.asin = l.asin WHERE lb.brand = b.brand)
  GROUP BY 1;

  SELECT count(*) INTO n_a FROM _a;
  n_b := n_brands - n_a;

  RAISE NOTICE 'STAT|ghosted_asins|%', n_g;
  RAISE NOTICE 'STAT|ghosted_with_known_brand|%', n_named;
  RAISE NOTICE 'STAT|distinct_brands_on_ghosts|%', n_brands;
  RAISE NOTICE 'STAT|group_a_ghost_only_brands|%', n_a;
  RAISE NOTICE 'STAT|group_b_also_live_brands|%', n_b;

  FOR r IN SELECT brand, dead FROM _a ORDER BY dead DESC, brand LOOP
    RAISE NOTICE 'BRAND_A|%|%', r.brand, r.dead;
  END LOOP;
END
$p$;
