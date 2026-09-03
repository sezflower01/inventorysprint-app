-- Read-only probe: sizing the stored seller catalogues, and finding what
-- ASIN->brand data exists to filter them with. Writes nothing.
DO $$
DECLARE
  v_watches bigint; v_seeded bigint; v_biggest bigint; v_total bigint; v_median bigint;
  v_catalog bigint; v_brands bigint;
  v_nl_asins bigint; v_nl_branded bigint; v_nl_matched bigint;
  r RECORD;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE jsonb_typeof(known_asin_list) = 'array')
    INTO v_watches, v_seeded FROM public.seller_watchlist;
  SELECT COALESCE(max(n),0), COALESCE(sum(n),0),
         COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY n), 0)
    INTO v_biggest, v_total, v_median
  FROM (SELECT jsonb_array_length(known_asin_list) AS n FROM public.seller_watchlist
        WHERE jsonb_typeof(known_asin_list) = 'array') s;
  SELECT count(*) INTO v_catalog FROM public.keepa_catalog_products;
  SELECT count(*) INTO v_brands FROM public.user_brands WHERE COALESCE(status,'') <> 'ignore';

  RAISE NOTICE 'watches=% seeded=% biggest=% median=% total_asin_slots=%',
    v_watches, v_seeded, v_biggest, v_median, v_total;
  RAISE NOTICE 'keepa_catalog_products=% rows | active user_brands=%', v_catalog, v_brands;

  -- The only ASIN->brand data we actually hold.
  SELECT count(DISTINCT asin),
         count(DISTINCT asin) FILTER (WHERE brand IS NOT NULL AND btrim(brand) <> ''),
         count(DISTINCT asin) FILTER (WHERE brand_match_state = 'matched')
    INTO v_nl_asins, v_nl_branded, v_nl_matched
  FROM public.seller_watch_new_listings;
  RAISE NOTICE 'seller_watch_new_listings: distinct asins=% with_brand=% matched=%',
    v_nl_asins, v_nl_branded, v_nl_matched;

  -- Per-seller coverage for the ten biggest watched catalogues.
  FOR r IN
    SELECT w.seller_id, jsonb_array_length(w.known_asin_list) AS n,
      (SELECT count(DISTINCT l.asin) FROM public.seller_watch_new_listings l
        WHERE l.seller_id = w.seller_id
          AND l.brand IS NOT NULL AND btrim(l.brand) <> '') AS known_brands
    FROM public.seller_watchlist w
    WHERE jsonb_typeof(w.known_asin_list) = 'array'
    ORDER BY jsonb_array_length(w.known_asin_list) DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  seller % : catalogue=% asins, we know the brand of %',
      r.seller_id, r.n, r.known_brands;
  END LOOP;
END $$;
