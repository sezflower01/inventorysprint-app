-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- backfill-catalog-brands already writes titles into asin_brand_cache from
-- SP-API. Do the 43,544 blank new-listing rows have a title (or image) waiting
-- there, i.e. can they be filled for free from a table we already hold?

DO $p$
DECLARE r record; c text;
BEGIN
  RAISE NOTICE 'asin_brand_cache columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'asin_brand_cache' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;

  FOR r IN SELECT count(*) AS rows, count(*) FILTER (WHERE title IS NOT NULL) AS with_title FROM public.asin_brand_cache LOOP
    RAISE NOTICE 'asin_brand_cache: % rows, % with a title', r.rows, r.with_title;
  END LOOP;

  FOR r IN SELECT count(*) AS blanks,
                  count(b.asin) AS in_cache,
                  count(*) FILTER (WHERE b.title IS NOT NULL) AS cache_has_title
           FROM public.seller_watch_new_listings l
           LEFT JOIN public.asin_brand_cache b ON b.asin = l.asin
           WHERE l.image_url IS NULL LOOP
    RAISE NOTICE 'blank rows % | ASIN present in brand cache % | of those, cache holds a title %', r.blanks, r.in_cache, r.cache_has_title;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every other table that might hold these ASINs ==';
  FOR r IN SELECT count(*) AS n FROM public.seller_watch_new_listings WHERE image_url IS NULL LOOP
    RAISE NOTICE '  blanks: %', r.n;
  END LOOP;
  FOR c IN SELECT t FROM unnest(ARRAY['asin_brand_cache','keepa_catalog_products','product_catalog_cache','asin_fee_cache']) t LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=c) THEN
      EXECUTE format('SELECT count(*) FROM public.seller_watch_new_listings l WHERE l.image_url IS NULL AND EXISTS (SELECT 1 FROM public.%I x WHERE x.asin = l.asin)', c) INTO r;
      RAISE NOTICE '  % covers % blanks', c, r;
    ELSE
      RAISE NOTICE '  % does not exist', c;
    END IF;
  END LOOP;
END
$p$;
