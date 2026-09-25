-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- B0C69ZH2D6 / MIQ-AAW-8EH3 shows "FBA inbound ineligible — FBA_INB_0004"
-- dated 2026-08-04, but the seller shipped it in with no issue and has sold
-- units since. Is the flag simply never re-checked, and how many other rows
-- are in the same state?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now %', now();

  RAISE NOTICE '== inventory rows ==';
  FOR r IN SELECT sku, available, reserved, inbound, listing_status, fba_blocked, fba_block_reason,
                  to_char(last_inventory_sync_at, 'YYYY-MM-DD HH24:MI') AS synced,
                  to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS upd, to_char(first_received_at, 'YYYY-MM-DD') AS first_rx
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B0C69ZH2D6' ORDER BY sku LOOP
    RAISE NOTICE '  % | avail % res % inb % | % | fba_blocked % (%) | synced % | updated % | first received %',
      r.sku, r.available, r.reserved, r.inbound, r.listing_status, r.fba_blocked, COALESCE(r.fba_block_reason,'-'), r.synced, r.upd, COALESCE(r.first_rx,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== created_listings rows (the other source of the flag) ==';
  FOR r IN SELECT sku, fba_blocked, fba_block_reason, validation_status,
                  to_char(date_created, 'YYYY-MM-DD') AS created, to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS upd,
                  inbound_dry_run_status, to_char(inbound_dry_run_at, 'YYYY-MM-DD HH24:MI') AS dry_run_at
           FROM public.created_listings WHERE user_id = v_uid AND asin = 'B0C69ZH2D6' ORDER BY date_created LOOP
    RAISE NOTICE '  % | fba_blocked % (%) | % | created % | updated % | dry run % %',
      r.sku, r.fba_blocked, COALESCE(r.fba_block_reason,'-'), r.validation_status, r.created, r.upd,
      COALESCE(r.inbound_dry_run_status,'-'), COALESCE(r.dry_run_at,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== did it actually sell? ==';
  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units, min(order_date) AS first_sale, max(order_date) AS last_sale,
                  count(*) FILTER (WHERE fulfillment_channel = 'AFN') AS fba_orders
           FROM public.sales_orders WHERE user_id = v_uid AND asin = 'B0C69ZH2D6' AND COALESCE(is_cancelled,false) = false LOOP
    RAISE NOTICE '  % orders, % units (% marked FBA), % .. %', r.orders, r.units, r.fba_orders, r.first_sale, r.last_sale;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how stale are FBA-blocked flags generally? ==';
  FOR r IN SELECT count(*) AS blocked_rows,
                  count(*) FILTER (WHERE (COALESCE(available,0) + COALESCE(reserved,0)) > 0) AS with_stock,
                  count(*) FILTER (WHERE fba_block_reason ILIKE '%FBA_INB_0004%') AS inb_0004,
                  min(updated_at)::date AS oldest_update, max(updated_at)::date AS newest_update
           FROM public.inventory WHERE user_id = v_uid AND fba_blocked = true LOOP
    RAISE NOTICE '  inventory: % blocked (% with stock, % are FBA_INB_0004) | updated % .. %',
      r.blocked_rows, r.with_stock, r.inb_0004, r.oldest_update, r.newest_update;
  END LOOP;
  FOR r IN SELECT count(*) AS blocked_rows,
                  count(*) FILTER (WHERE fba_block_reason ILIKE '%FBA_INB_0004%') AS inb_0004
           FROM public.created_listings WHERE user_id = v_uid AND fba_blocked = true LOOP
    RAISE NOTICE '  created_listings: % blocked (% are FBA_INB_0004)', r.blocked_rows, r.inb_0004;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== blocked rows that have sold since being flagged ==';
  FOR r IN SELECT i.asin, i.sku, left(COALESCE(i.fba_block_reason,'-'), 28) AS reason,
                  to_char(i.updated_at, 'MM-DD') AS flagged_upd,
                  (SELECT count(*) FROM public.sales_orders s
                   WHERE s.user_id = v_uid AND s.asin = i.asin AND COALESCE(s.is_cancelled,false) = false
                     AND s.order_date > i.updated_at::date) AS sales_since
           FROM public.inventory i
           WHERE i.user_id = v_uid AND i.fba_blocked = true
           ORDER BY 5 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % % | % | flagged % | % sales since', r.asin, r.sku, r.reason, r.flagged_upd, r.sales_since;
  END LOOP;
END
$p$;
