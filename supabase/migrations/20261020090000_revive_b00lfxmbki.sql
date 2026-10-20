-- WRITE. Clears the false tombstone on B00LFXMBKI / 6DA-X5B-Y5SO.
--
-- WHY THIS ONE ROW AND NOT SEVEN. The approved scope was "the 7 proven-selling
-- NOT_IN_CATALOG ASINs". That figure came from an ASIN-level join against
-- sales_orders and it was wrong: probe 20261020050000 showed 12 of the 13 have
-- an ACTIVE SIBLING SKU holding the real stock (e.g. B000EYYP62 has a
-- tombstoned amzn.gr.1065205682 row beside an ACTIVE 1065205682 with 68
-- available). For those the tombstone is CORRECT -- it marks a dead duplicate
-- SKU, not a dead ASIN, and clearing it would resurrect a second row competing
-- with the live one. Only B00LFXMBKI is an orphan: one row, tombstoned,
-- nowhere else for the stock to live.
--
-- WHY THE TOMBSTONE IS PROVABLY FALSE. Asked Amazon directly on 2026-10-20 via
-- rescue-inventory-asin (pg_net request 61477), which could not write because
-- its own tombstone guard fires first. The FBA summary for this exact seller
-- SKU came back:
--
--   sellerSku 6DA-X5B-Y5SO, fnSku X0059SGQQL, exact_seller_sku_match: true
--   totalQuantity 159 = fulfillable 145 + reserved 11 + inboundReceiving 3
--   "Bath and Body Works Cinnamon Stick Wallflowers Fragrance Refills"
--
-- So the 145 units the seller can see ARE on the tombstoned SKU. This is not a
-- missing-row problem; the row is right and its status is wrong.
--
-- HOW IT GOT WRONG. The row was created 2026-09-03 17:52 and tombstoned about
-- 8 minutes later at 18:00:35 -- its entire history is that one transition.
-- clean-ghost-listings tombstones any inventory row whose SKU is absent from
-- the catalog report, and a freshly created listing is exactly the case where
-- that report lags. None of the three tombstoning writers is on a cron
-- (confirmed by probe 20261020040000 against cron.job), so nothing re-applies
-- this automatically.
--
-- WHY IT STAYED WRONG FOR SEVEN WEEKS. The refresh queue reported success on
-- every one of its 3-hourly runs while rescue-inventory-asin was declining to
-- write each time and saying so in skipped_update_reason. Fixed separately in
-- migration 20261020060000 plus the inventory-refresh-worker change; 16 rows
-- were already recording skipped / tombstoned:NOT_IN_CATALOG within a minute
-- of that deploy.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not type Amazon's numbers into the
-- row. It clears the status lock and hands the row back to the normal refresh
-- path, so the quantities arrive from Amazon through rescue-inventory-asin like
-- any other row. source is returned to live_api afterwards because
-- fn_inventory_freshness_guard lets force_relist BYPASS the stale-write
-- watermark -- leaving it behind would quietly opt this row out of that
-- protection (the lesson from B09PJPB34P, migration 20261002230000).
--
-- Nothing here reaches Amazon. force_relist is read only by
-- fn_protect_ghost_tombstone and fn_inventory_freshness_guard, both Postgres
-- triggers. No edge function and no frontend code branches on it, and no
-- listings submission is keyed to it.

CREATE TABLE IF NOT EXISTS public.inventory_revive_backup_20261020 AS
SELECT * FROM public.inventory WHERE false;

DO $p$
DECLARE
  v_uid uuid; v_id uuid; r record;
  v_before_status text; v_before_avail int; v_before_src text;
  v_after_status text; v_after_avail int; v_after_src text;
  v_backed int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT id, listing_status, COALESCE(available,0), source
    INTO v_id, v_before_status, v_before_avail, v_before_src
  FROM public.inventory
  WHERE user_id = v_uid AND asin = 'B00LFXMBKI' AND sku = '6DA-X5B-Y5SO';

  IF v_id IS NULL THEN
    RAISE NOTICE 'ABORT: no inventory row for B00LFXMBKI / 6DA-X5B-Y5SO';
    RETURN;
  END IF;

  -- 1. BACK UP THE ROW FIRST, in full, before anything is touched.
  INSERT INTO public.inventory_revive_backup_20261020
  SELECT * FROM public.inventory WHERE id = v_id;
  SELECT count(*) INTO v_backed FROM public.inventory_revive_backup_20261020;
  RAISE NOTICE '== backed up % row(s) to inventory_revive_backup_20261020 ==', v_backed;
  RAISE NOTICE '   BEFORE: status % | available % | source %',
    v_before_status, v_before_avail, v_before_src;

  IF v_before_status NOT IN ('NOT_IN_CATALOG','DELETED') THEN
    RAISE NOTICE 'Nothing to do: status is already % (not a tombstone)', v_before_status;
    RETURN;
  END IF;

  -- 2. Lift the tombstone. force_relist is the only source value the guard
  --    accepts, and ACTIVE is what Amazon's own summary supports.
  UPDATE public.inventory
  SET listing_status = 'ACTIVE', source = 'force_relist', updated_at = now()
  WHERE id = v_id;

  SELECT listing_status INTO v_after_status FROM public.inventory WHERE id = v_id;
  IF v_after_status IN ('NOT_IN_CATALOG','DELETED') THEN
    RAISE EXCEPTION 'TOMBSTONE GUARD STILL BLOCKING: status is % after the write', v_after_status;
  END IF;
  RAISE NOTICE '   tombstone lifted: status now %', v_after_status;

  -- 3. Hand the row back to the normal freshness rules.
  UPDATE public.inventory
  SET source = 'live_api', updated_at = now()
  WHERE id = v_id AND source = 'force_relist';

  -- 4. Queue a priority-1 refresh so the quantities come from Amazon, not me.
  INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
  VALUES (v_uid, 'B00LFXMBKI', '6DA-X5B-Y5SO', 'US', 'pending', 1);
  RAISE NOTICE '   queued a priority-1 refresh';

  SELECT listing_status, COALESCE(available,0), source
    INTO v_after_status, v_after_avail, v_after_src
  FROM public.inventory WHERE id = v_id;

  RAISE NOTICE '';
  RAISE NOTICE '== B00LFXMBKI / 6DA-X5B-Y5SO ==';
  RAISE NOTICE '   status    : %  ->  %', v_before_status, v_after_status;
  RAISE NOTICE '   available : %  ->  %   (Amazon says 145 fulfillable; awaiting the refresh)',
    v_before_avail, v_after_avail;
  RAISE NOTICE '   source    : %  ->  %', v_before_src, v_after_src;

  RAISE NOTICE '';
  RAISE NOTICE '== the 12 DUPLICATES left tombstoned on purpose ==';
  FOR r IN
    SELECT t.asin, t.sku AS tomb_sku,
           (SELECT string_agg(i2.sku || '(' || i2.listing_status || ':' || COALESCE(i2.available,0) || ')', ', ')
            FROM public.inventory i2
            WHERE i2.user_id = v_uid AND i2.asin = t.asin
              AND COALESCE(i2.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_sibling
    FROM public.inventory t
    WHERE t.user_id = v_uid AND t.listing_status = 'NOT_IN_CATALOG'
      AND EXISTS (SELECT 1 FROM public.sales_orders so
                  WHERE so.user_id = v_uid AND so.asin = t.asin
                    AND so.order_date >= CURRENT_DATE - 30
                    AND COALESCE(so.is_cancelled,false) = false
                    AND so.order_id NOT LIKE '%-REFUND%')
    ORDER BY t.asin
  LOOP
    RAISE NOTICE '   % | tombstoned % | live: %',
      r.asin, rpad(r.tomb_sku,28), COALESCE(r.live_sibling,'(none)');
  END LOOP;
END
$p$;
