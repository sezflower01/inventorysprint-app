-- READ-ONLY. Step 1: which writer set NOT_IN_CATALOG on the 7 proven-selling
-- rows, and when. inventory_history is fed by trg_inventory_history, so it
-- should carry the transition.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== inventory_history columns ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_history'
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== CONFIRM the 7 proven-selling NOT_IN_CATALOG rows ==';
  FOR r IN
    SELECT inv.asin, COALESCE(inv.sku,'-') AS sku,
           COALESCE(inv.cost::text,'-') AS cost,
           COALESCE(inv.available::text,'NULL') AS avail,
           COALESCE(inv.source,'-') AS src,
           inv.updated_at,
           COALESCE(inv.last_inventory_sync_at::text,'never') AS last_sync,
           (SELECT count(*) FROM public.sales_orders so
            WHERE so.user_id = v_uid AND so.asin = inv.asin
              AND so.order_date >= CURRENT_DATE - 30
              AND COALESCE(so.is_cancelled,false) = false
              AND so.order_id NOT LIKE '%-REFUND%') AS orders_30d
    FROM public.inventory inv
    WHERE inv.user_id = v_uid AND inv.listing_status = 'NOT_IN_CATALOG'
      AND EXISTS (SELECT 1 FROM public.sales_orders so
                  WHERE so.user_id = v_uid AND so.asin = inv.asin
                    AND so.order_date >= CURRENT_DATE - 30
                    AND COALESCE(so.is_cancelled,false) = false
                    AND so.order_id NOT LIKE '%-REFUND%')
    ORDER BY inv.asin
  LOOP
    RAISE NOTICE '   % | sku % | cost % | avail % | src % | %d orders | sync %',
      r.asin, rpad(r.sku,16), lpad(r.cost,8), lpad(r.avail,5),
      rpad(r.src,10), r.orders_30d, r.last_sync;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== history for those ASINs: the listing_status transitions ==';
  FOR r IN
    SELECT to_jsonb(h)::text AS j
    FROM public.inventory_history h
    WHERE h.user_id = v_uid
      AND h.asin IN (
        SELECT inv.asin FROM public.inventory inv
        WHERE inv.user_id = v_uid AND inv.listing_status = 'NOT_IN_CATALOG'
          AND EXISTS (SELECT 1 FROM public.sales_orders so
                      WHERE so.user_id = v_uid AND so.asin = inv.asin
                        AND so.order_date >= CURRENT_DATE - 30
                        AND COALESCE(so.is_cancelled,false) = false
                        AND so.order_id NOT LIKE '%-REFUND%'))
    ORDER BY h.captured_at DESC LIMIT 25
  LOOP
    RAISE NOTICE '   %', left(r.j, 520);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no history rows for these ASINs)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== are the three tombstoning writers on a cron? ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job
    WHERE command ILIKE '%clean-ghost-listings%'
       OR command ILIKE '%nightly-ghost-cleanup%'
       OR command ILIKE '%check-fba-listing-eligibility%'
       OR command ILIKE '%refresh-stale-inventory%'
    ORDER BY jobname
  LOOP
    RAISE NOTICE '   [%] % | % | active %', r.jobid, rpad(r.jobname,40), rpad(r.schedule,16), r.active;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE of them run on a cron -- they are invoked manually'; END IF;
END
$p$;
