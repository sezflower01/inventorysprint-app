-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- B09PJPB34P: Amazon deleted the ASIN's listing, the seller recreated it ~12 h
-- ago under a DIFFERENT SKU, Seller Central shows it active, and the repricer
-- still does not have it. The COG page shows the ASIN with SKU FSG-IM9-UBG1 at
-- $5.40 (100 units, Jan 2 2026), so the cost side already exists.
--
-- The question is which SKU each layer believes in: inventory, the assignment
-- rows, created_listings and the COG view can each be keyed to the old SKU, the
-- new one, or both.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== repricer_assignments ==';
  FOR r IN SELECT marketplace, sku, fulfillment_type, item_condition, status, is_enabled,
                  manual_paused, paused_reason, sku_validation_status, sku_validation_message,
                  marketplace_sellable, marketplace_sellability_reason,
                  is_listing_inactive_not_buyable AS not_buyable, listing_inactive_statuses,
                  min_price_override, max_price_override, manual_min_price,
                  last_skip_lane, last_skip_reason, last_dispatch_at, restock_reentry_at,
                  created_at, updated_at
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % | sku % | % % | status % | enabled % | paused % (%)',
      r.marketplace, r.sku, r.fulfillment_type, r.item_condition, r.status, r.is_enabled, r.manual_paused, r.paused_reason;
    RAISE NOTICE '      sku_validation % :: % | sellable % :: %',
      r.sku_validation_status, left(COALESCE(r.sku_validation_message, ''), 120),
      r.marketplace_sellable, left(COALESCE(r.marketplace_sellability_reason, ''), 120);
    RAISE NOTICE '      not_buyable % % | bounds min % max % manual_min %',
      r.not_buyable, r.listing_inactive_statuses, r.min_price_override, r.max_price_override, r.manual_min_price;
    RAISE NOTICE '      skip % :: % | last dispatch % | reentry %',
      r.last_skip_lane, left(COALESCE(r.last_skip_reason, ''), 140), r.last_dispatch_at, r.restock_reentry_at;
    RAISE NOTICE '      created % | updated %', r.created_at, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (NO assignment row for this ASIN at all)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== inventory (every SKU on this ASIN) ==';
  FOR r IN SELECT sku, listing_status, available, inbound, reserved, units,
                  price, my_price, min_price, max_price, cost, amount,
                  fba_blocked, fba_block_reason, ghosted_at, ghost_reason,
                  listing_created_at, last_inventory_sync_at, updated_at
           FROM public.inventory
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' ORDER BY updated_at DESC LOOP
    RAISE NOTICE '  sku % | listing_status % | avail % inbound % reserved % units %',
      r.sku, r.listing_status, r.available, r.inbound, r.reserved, r.units;
    RAISE NOTICE '      price % my_price % | bounds %/% | cost % amount %',
      r.price, r.my_price, r.min_price, r.max_price, r.cost, r.amount;
    RAISE NOTICE '      fba_blocked % (%) | ghosted % (%)',
      r.fba_blocked, left(COALESCE(r.fba_block_reason, ''), 80), r.ghosted_at, left(COALESCE(r.ghost_reason, ''), 80);
    RAISE NOTICE '      listing_created % | synced % | updated %', r.listing_created_at, r.last_inventory_sync_at, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (NO inventory row for this ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== created_listings (where the purchase cost lives) ==';
  FOR r IN SELECT sku, cost, amount, price, units, received_quantity,
                  validation_status, validation_failure_code, date_created, created_at
           FROM public.created_listings
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' ORDER BY created_at DESC LIMIT 8 LOOP
    RAISE NOTICE '  sku % | cost % amount % price % | units % received % | validation % % | % / %',
      r.sku, r.cost, r.amount, r.price, r.units, r.received_quantity,
      r.validation_status, COALESCE(r.validation_failure_code, ''), r.date_created, r.created_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (NO created_listings row)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== COG on record (the view the repricer reads) ==';
  FOR r IN SELECT to_jsonb(v) AS j FROM public.asin_cog_for_repricer v
           WHERE v.user_id = v_uid AND v.asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no COG row for this ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== sales, to see which SKU Amazon actually bills ==';
  FOR r IN SELECT sku, fulfillment_channel, count(*) AS orders, max(order_date) AS last_order
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B09PJPB34P'
           GROUP BY 1, 2 ORDER BY 4 DESC NULLS LAST LIMIT 8 LOOP
    RAISE NOTICE '  sku % | % | % order(s) | last %', r.sku, r.fulfillment_channel, r.orders, r.last_order;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the repricer see competitors for it? ==';
  FOR r IN SELECT count(*) AS n, max(created_at) AS newest
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % snapshot(s) | newest %', r.n, r.newest;
  END LOOP;
END
$p$;
