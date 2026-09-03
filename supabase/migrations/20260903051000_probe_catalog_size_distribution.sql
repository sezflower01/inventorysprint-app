-- Read-only probe: if the backfill runs smallest-catalogue-first, how quickly
-- do whole SELLERS become complete? Writes nothing.
--
-- Ordering matters more than throughput here. Five sellers hold ~500,000 ASINs
-- and are truncated at Amazon's 100,000 cap, so they can never be exhaustive;
-- spending the first ten hours on them would leave every ordinary seller still
-- partial. Smallest-first inverts that.

SET statement_timeout TO '600s';

DO $$
DECLARE r RECORD; v_running bigint := 0; v_sellers bigint := 0; v_all bigint;
BEGIN
  SELECT count(*) INTO v_all FROM public.seller_watchlist
   WHERE jsonb_typeof(known_asin_list) = 'array';

  FOR r IN
    SELECT bucket, count(*) AS sellers, sum(n) AS asins FROM (
      SELECT jsonb_array_length(known_asin_list) AS n,
             CASE
               WHEN jsonb_array_length(known_asin_list) <= 100    THEN '1. <=100'
               WHEN jsonb_array_length(known_asin_list) <= 1000   THEN '2. 101-1k'
               WHEN jsonb_array_length(known_asin_list) <= 10000  THEN '3. 1k-10k'
               WHEN jsonb_array_length(known_asin_list) <= 50000  THEN '4. 10k-50k'
               ELSE                                                    '5. 50k+'
             END AS bucket
      FROM public.seller_watchlist
      WHERE jsonb_typeof(known_asin_list) = 'array'
    ) s GROUP BY bucket ORDER BY bucket
  LOOP
    v_running := v_running + r.asins;
    v_sellers := v_sellers + r.sellers;
    RAISE NOTICE '% : % sellers, % ASINs | cumulative: % of % sellers (%%%), % ASINs',
      r.bucket, r.sellers, r.asins, v_sellers, v_all,
      round(100.0 * v_sellers / GREATEST(v_all,1), 1), v_running;
  END LOOP;
END $$;
