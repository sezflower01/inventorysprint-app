-- Read-only probe: does Keepa's asinList order carry RECENCY? Writes nothing.
--
-- "Newest 1,000" is only implementable if the stored array is ordered by when
-- the seller added each item. Keepa does not document an order, and guessing
-- would mean shipping an arbitrary slice under a "newest" label -- the exact
-- class of error that made detected_at read as "seller added".
--
-- The test uses data we already hold. seller_watch_new_listings.detected_at
-- marks ASINs we saw a seller ADD. If the array is newest-first those ASINs sit
-- near ordinal 1; newest-last, near the end; if the order is arbitrary they
-- scatter uniformly and the mean normalised position lands near 0.50.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_n bigint; v_mean numeric; v_p10 numeric; v_p50 numeric; v_p90 numeric;
  v_recent_n bigint; v_recent_mean numeric;
  r RECORD;
BEGIN
  CREATE TEMP TABLE _pos AS
  SELECT
    w.seller_id,
    l.asin,
    l.detected_at,
    t.ord::numeric / GREATEST(jsonb_array_length(w.known_asin_list), 1) AS pos
  FROM public.seller_watchlist w
  JOIN public.seller_watch_new_listings l
    ON l.seller_id = w.seller_id
   AND l.marketplace = w.marketplace
   AND l.user_id = w.user_id
  CROSS JOIN LATERAL jsonb_array_elements_text(w.known_asin_list)
                     WITH ORDINALITY t(a, ord)
  WHERE jsonb_typeof(w.known_asin_list) = 'array'
    AND t.a = l.asin
    -- Only sellers where position is meaningful: a 68-item catalogue tells us
    -- nothing about ordering at 100,000 scale.
    AND jsonb_array_length(w.known_asin_list) > 1000;

  SELECT count(*), round(avg(pos), 4),
         round(percentile_cont(0.10) WITHIN GROUP (ORDER BY pos)::numeric, 4),
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY pos)::numeric, 4),
         round(percentile_cont(0.90) WITHIN GROUP (ORDER BY pos)::numeric, 4)
    INTO v_n, v_mean, v_p10, v_p50, v_p90 FROM _pos;

  RAISE NOTICE 'detected ASINs located in capped catalogues: %', v_n;
  RAISE NOTICE 'normalised position  mean=%  p10=%  median=%  p90=%',
    v_mean, v_p10, v_p50, v_p90;
  RAISE NOTICE '  (0.00 = head of list, 1.00 = end, ~0.50 = no ordering signal)';

  -- Detections since the re-baseline are the ones we are most confident are
  -- genuinely new, so they are the sharpest version of the same test.
  SELECT count(*), round(avg(pos), 4) INTO v_recent_n, v_recent_mean
    FROM _pos WHERE detected_at >= timestamptz '2026-09-02 00:00:00+00';
  RAISE NOTICE 'post-2-Sep detections only: n=% mean position=%', v_recent_n, v_recent_mean;

  FOR r IN
    SELECT seller_id, count(*) AS n, round(avg(pos), 3) AS mean_pos
    FROM _pos GROUP BY seller_id HAVING count(*) >= 20
    ORDER BY count(*) DESC LIMIT 8
  LOOP
    RAISE NOTICE '  seller %: % detected, mean position %', r.seller_id, r.n, r.mean_pos;
  END LOOP;

  DROP TABLE _pos;
END $$;
