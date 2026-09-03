-- Read-only probe: the REAL size of a full brand backfill. Writes nothing.
--
-- 1,778,439 is ASIN *slots* across all watches, not distinct ASINs -- watched
-- sellers compete on the same products, so the true figure is what decides
-- whether a backfill is hours or weeks. The earlier attempt at this timed out
-- at the default 2 minutes, hence the raised limit.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_distinct bigint; v_uncapped bigint; v_capped_sellers bigint;
  v_known bigint; v_todo bigint;
  r RECORD;
BEGIN
  CREATE TEMP TABLE _probe_asins AS
  SELECT DISTINCT jsonb_array_elements_text(w.known_asin_list) AS asin,
         w.marketplace
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array';

  SELECT count(*), count(DISTINCT asin) INTO v_distinct, v_uncapped FROM _probe_asins;
  RAISE NOTICE 'distinct (asin, marketplace) pairs = % | distinct ASINs = %',
    v_distinct, v_uncapped;

  -- Amazon/Keepa truncate a storefront at 100,000. Those catalogues are
  -- incomplete AT SOURCE, so no amount of backfill makes those sellers
  -- exhaustive -- worth stating before promising completeness.
  SELECT count(*) INTO v_capped_sellers FROM public.seller_watchlist
   WHERE jsonb_typeof(known_asin_list) = 'array'
     AND jsonb_array_length(known_asin_list) >= 100000;
  RAISE NOTICE 'sellers at the 100,000 cap (permanently incomplete) = %', v_capped_sellers;

  -- What we would NOT have to look up.
  SELECT count(*) INTO v_known
  FROM _probe_asins p
  WHERE EXISTS (SELECT 1 FROM public.seller_watch_new_listings l
                 WHERE l.asin = p.asin AND l.brand IS NOT NULL AND btrim(l.brand) <> '')
     OR EXISTS (SELECT 1 FROM public.inventory i
                 WHERE i.asin = p.asin AND i.brand IS NOT NULL AND btrim(i.brand) <> '');
  v_todo := v_distinct - v_known;
  RAISE NOTICE 'already have a brand = % | STILL TO LOOK UP = %', v_known, v_todo;

  FOR r IN SELECT marketplace, count(*) AS n FROM _probe_asins
           GROUP BY marketplace ORDER BY count(*) DESC LOOP
    RAISE NOTICE '  marketplace %: % ASINs', r.marketplace, r.n;
  END LOOP;

  -- At the catalog_api bucket's 2 req/s and 20 ASINs per searchCatalogItems
  -- call, the ceiling is 40 ASINs/sec -- but the bucket is SHARED, so this is
  -- an upper bound, not a forecast.
  RAISE NOTICE 'at 40 ASINs/sec (2 req/s x 20): % hours of pure API time',
    round((v_todo / 40.0 / 3600.0)::numeric, 1);

  DROP TABLE _probe_asins;
END $$;
