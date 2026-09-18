-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: lowering the min must not get the listing DEACTIVATED -- Amazon
-- keeps its own minimum price on the offer, and a price below it deactivates
-- the listing. repricer-auto-lower-min writes min_price_override but never
-- sets bounds_sync_status = 'pending' (no trigger does either), so its lowered
-- mins may never reach Amazon. For every assignment it has lowered, compare
-- our min with what Amazon was last told, and the price we push.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    SELECT count(*) AS lowered,
           count(*) FILTER (WHERE a.bounds_sync_status = 'pending') AS pending,
           count(*) FILTER (WHERE a.bounds_synced_at IS NULL OR a.bounds_synced_at < a.updated_at) AS synced_before_last_change,
           count(*) FILTER (WHERE a.last_min_price_on_amazon IS NOT NULL AND a.last_min_price_on_amazon > a.min_price_override + 0.005) AS amazon_min_higher,
           count(*) FILTER (WHERE a.last_min_price_on_amazon IS NOT NULL AND a.last_applied_price < a.last_min_price_on_amazon - 0.005) AS price_below_amazon_min
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.marketplace = 'US' AND COALESCE(a.auto_floor_drop_count, 0) > 0
  LOOP
    RAISE NOTICE 'auto-lowered assignments: % | bounds pending % | last Amazon sync older than last change % | Amazon min still HIGHER than ours % | price pushed BELOW Amazon min %',
      r.lowered, r.pending, r.synced_before_last_change, r.amazon_min_higher, r.price_below_amazon_min;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT a.asin, a.min_price_override AS our_min, a.last_min_price_on_amazon AS amazon_min, a.amazon_min_price,
                  a.last_applied_price AS price, a.bounds_sync_status AS st, a.bounds_synced_at, a.updated_at,
                  COALESCE(a.listing_status, to_jsonb(a)->>'intl_listing_status') AS listing_status
           FROM public.repricer_assignments a
           WHERE a.user_id = v_uid AND a.marketplace = 'US' AND COALESCE(a.auto_floor_drop_count, 0) > 0
           ORDER BY a.updated_at DESC LIMIT 12 LOOP
    RAISE NOTICE '  % our min % | Amazon min % (amazon_min_price %) | price % | bounds % synced % | changed %',
      r.asin, r.our_min, r.amazon_min, r.amazon_min_price, r.price, r.st, r.bounds_synced_at, r.updated_at;
  END LOOP;
EXCEPTION WHEN undefined_column THEN
  RAISE NOTICE 'column mismatch: %', SQLERRM;
END
$p$;
