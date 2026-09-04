-- Read-only: where did the catalogue brand backfill land?
DO $$
DECLARE v_pending bigint; v_brand bigint; v_miss bigint; v_sellers bigint; v_matched bigint;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NOT NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NULL)
    INTO v_pending, v_brand, v_miss FROM public.asin_brand_cache;
  SELECT count(*), COALESCE(sum(matched_items),0) INTO v_sellers, v_matched
    FROM public.seller_brand_catalog_rollup WHERE matched_items > 0;
  RAISE NOTICE 'pending=% | with brand=% | no brand=% | hit rate=% pct',
    v_pending, v_brand, v_miss,
    round(100.0 * v_brand / GREATEST(v_brand + v_miss, 1), 1);
  RAISE NOTICE 'sellers with a match=% | matched items=%', v_sellers, v_matched;
END $$;
