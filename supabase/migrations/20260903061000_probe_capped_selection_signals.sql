-- Read-only probe: for the 180 sellers the 1,000 cap bites, do we hold any
-- signal worth ranking their catalogue by, or is "the first 1,000" the only
-- honest option? Writes nothing.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_capped_sellers bigint; v_with_detections bigint; v_fillable bigint;
  v_shared bigint; v_shared_in_capped bigint;
  r RECORD;
BEGIN
  SELECT count(*) INTO v_capped_sellers FROM public.seller_watchlist
   WHERE jsonb_typeof(known_asin_list) = 'array'
     AND jsonb_array_length(known_asin_list) > 1000;

  -- SIGNAL 1: ASINs we detected ourselves. These are genuinely additions the
  -- seller made while we watched -- the only real recency signal we own.
  SELECT count(*), count(*) FILTER (WHERE d >= 1000) INTO v_with_detections, v_fillable
  FROM (
    SELECT w.seller_id,
           (SELECT count(DISTINCT l.asin) FROM public.seller_watch_new_listings l
             WHERE l.seller_id = w.seller_id AND l.marketplace = w.marketplace) AS d
    FROM public.seller_watchlist w
    WHERE jsonb_typeof(w.known_asin_list) = 'array'
      AND jsonb_array_length(w.known_asin_list) > 1000
  ) s WHERE d > 0;

  RAISE NOTICE 'capped sellers=% | of those, with ANY detection of ours=% | with >=1000 (cap fillable from detections alone)=%',
    v_capped_sellers, v_with_detections, v_fillable;

  -- SIGNAL 2: ASINs carried by more than one watched seller. Cheap relevance
  -- proxy -- a product several of your competitors stock is likelier to be
  -- real retail inventory than a one-off.
  CREATE TEMP TABLE _freq AS
  SELECT asin, count(*) AS sellers FROM (
    SELECT DISTINCT w.seller_id, jsonb_array_elements_text(w.known_asin_list) AS asin
    FROM public.seller_watchlist w
    WHERE jsonb_typeof(w.known_asin_list) = 'array'
  ) x GROUP BY asin HAVING count(*) > 1;

  SELECT count(*) INTO v_shared FROM _freq;
  RAISE NOTICE 'ASINs carried by 2+ watched sellers = % (of 1,749,990 distinct)', v_shared;

  FOR r IN
    SELECT w.seller_id, jsonb_array_length(w.known_asin_list) AS n,
      (SELECT count(*) FROM _freq f
        WHERE w.known_asin_list @> to_jsonb(f.asin)) AS shared
    FROM public.seller_watchlist w
    WHERE jsonb_typeof(w.known_asin_list) = 'array'
      AND jsonb_array_length(w.known_asin_list) > 1000
    ORDER BY jsonb_array_length(w.known_asin_list) DESC LIMIT 5
  LOOP
    RAISE NOTICE '  seller % (% items): % are carried by another watched seller too',
      r.seller_id, r.n, r.shared;
  END LOOP;

  DROP TABLE _freq;
END $$;
