-- Refresh the rollup immediately rather than waiting for the :07 tick.
-- The counts lag the backfill by up to an hour by design, which is fine while
-- it runs but reads as a discrepancy against a freshly-fixed item list.
SET statement_timeout TO '900s';
DO $$
DECLARE v_rows bigint; v_pending bigint; v_sellers bigint; v_matched bigint;
BEGIN
  SELECT public.refresh_seller_brand_catalog_rollup() INTO v_rows;
  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_pending FROM public.asin_brand_cache;
  SELECT count(*), COALESCE(sum(matched_items),0) INTO v_sellers, v_matched
    FROM public.seller_brand_catalog_rollup WHERE matched_items > 0;
  RAISE NOTICE 'rollup=% rows | sellers with a match=% | matched items=% | pending lookups=%',
    v_rows, v_sellers, v_matched, v_pending;
END $$;
