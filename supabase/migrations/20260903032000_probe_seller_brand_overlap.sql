-- Read-only probe: how many sellers could a brand-filtered catalogue view
-- actually serve, and is intersecting with known_asin_list affordable?
DO $$
DECLARE
  v_sellers bigint; v_matched_sellers bigint; v_still bigint; v_gone bigint;
  r RECORD; t0 timestamptz; 
BEGIN
  SELECT count(DISTINCT seller_id) INTO v_sellers FROM public.seller_watch_new_listings;
  SELECT count(DISTINCT seller_id) INTO v_matched_sellers
    FROM public.seller_watch_new_listings WHERE brand_match_state = 'matched';
  RAISE NOTICE 'sellers with any detection=% | with a BRAND-MATCHED detection=%',
    v_sellers, v_matched_sellers;

  t0 := clock_timestamp();
  SELECT
    count(*) FILTER (WHERE w.known_asin_list @> to_jsonb(l.asin)),
    count(*) FILTER (WHERE NOT (w.known_asin_list @> to_jsonb(l.asin)))
    INTO v_still, v_gone
  FROM (SELECT DISTINCT seller_id, marketplace, user_id, asin
        FROM public.seller_watch_new_listings WHERE brand_match_state = 'matched') l
  JOIN public.seller_watchlist w
    ON w.seller_id = l.seller_id AND w.marketplace = l.marketplace AND w.user_id = l.user_id
  WHERE jsonb_typeof(w.known_asin_list) = 'array';
  RAISE NOTICE 'matched detections STILL in the seller catalogue=% | no longer listed=% (took %)',
    v_still, v_gone, clock_timestamp() - t0;

  FOR r IN
    SELECT l.seller_id, count(*) AS matched,
           max(jsonb_array_length(w.known_asin_list)) AS catalogue
    FROM (SELECT DISTINCT seller_id, marketplace, user_id, asin
          FROM public.seller_watch_new_listings WHERE brand_match_state = 'matched') l
    JOIN public.seller_watchlist w
      ON w.seller_id = l.seller_id AND w.marketplace = l.marketplace AND w.user_id = l.user_id
    GROUP BY l.seller_id ORDER BY count(*) DESC LIMIT 8
  LOOP
    RAISE NOTICE '  seller %: % of my brands known, catalogue=%',
      r.seller_id, r.matched, r.catalogue;
  END LOOP;
END $$;
