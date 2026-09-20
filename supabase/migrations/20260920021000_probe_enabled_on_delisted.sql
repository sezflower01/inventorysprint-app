-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- B00FAIUBKG is a deleted listing (Amazon restricted it), yet one of its
-- assignments is still enabled: US/amzn.gr.89-3H71-R3GF...-LN, active,
-- is_enabled = true, updated today. How many enabled assignments point at a
-- SKU Amazon no longer lists? Each one costs SP-API calls on every pass for a
-- listing that cannot sell.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT count(*) AS enabled_on_delisted,
                  count(DISTINCT a.asin) AS asins,
                  count(*) FILTER (WHERE a.marketplace = 'US') AS us,
                  count(*) FILTER (WHERE a.sku LIKE 'amzn.gr.%') AS returned_sku
           FROM public.repricer_assignments a
           JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
           WHERE a.user_id = v_uid AND a.is_enabled AND a.status = 'active'
             AND i.listing_status = 'NOT_IN_CATALOG' LOOP
    RAISE NOTICE 'enabled assignments on SKUs Amazon no longer lists: % (% ASINs, % US, % returned-item SKUs)',
      r.enabled_on_delisted, r.asins, r.us, r.returned_sku;
  END LOOP;

  FOR r IN SELECT a.marketplace, a.asin, a.sku, i.available, to_char(i.last_inventory_sync_at, 'YYYY-MM-DD') AS sync,
                  to_char(a.last_evaluated_at, 'YYYY-MM-DD HH24:MI') AS last_eval, a.last_skip_reason
           FROM public.repricer_assignments a
           JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
           WHERE a.user_id = v_uid AND a.is_enabled AND a.status = 'active'
             AND i.listing_status = 'NOT_IN_CATALOG'
           ORDER BY a.marketplace, a.asin LIMIT 15 LOOP
    RAISE NOTICE '  %/% % | avail % | inventory synced % | last evaluated % | skip %',
      r.marketplace, r.asin, r.sku, r.available, r.sync, COALESCE(r.last_eval, 'never'), COALESCE(r.last_skip_reason, '-');
  END LOOP;
END
$p$;
