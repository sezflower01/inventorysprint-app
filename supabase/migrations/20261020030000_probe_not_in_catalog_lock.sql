-- READ-ONLY. The row is NOT ghosted: ghost_reason is empty and ghosted_at is
-- never. The blocker is listing_status = 'NOT_IN_CATALOG'.
--
-- That matters because the two are governed differently, and NOT_IN_CATALOG is
-- the one that cannot be lifted: a trigger demands source = 'force_relist' to
-- clear it while a CHECK constraint forbids that value. Verify both here
-- rather than trusting the recollection.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== CHECK constraints on inventory mentioning source or listing_status ==';
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.inventory'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%source%'
        OR pg_get_constraintdef(oid) ILIKE '%listing_status%')
  LOOP
    RAISE NOTICE '   % :: %', r.conname, left(r.def, 500);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== triggers on inventory ==';
  FOR r IN
    SELECT t.tgname, p.proname,
           pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.inventory'::regclass AND NOT t.tgisinternal
  LOOP
    RAISE NOTICE '   % -> %()', r.tgname, r.proname;
    RAISE NOTICE '        %', left(regexp_replace(r.def, '\s+', ' ', 'g'), 300);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no user triggers)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== any trigger function body that mentions NOT_IN_CATALOG ==';
  FOR r IN
    SELECT p.proname, left(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'), 1400) AS body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ILIKE '%NOT_IN_CATALOG%'
  LOOP
    RAISE NOTICE '   --- %() ---', r.proname;
    RAISE NOTICE '   %', r.body;
    RAISE NOTICE '';
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no function mentions NOT_IN_CATALOG)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== scale: the NOT_IN_CATALOG population ==';
  FOR r IN
    SELECT COALESCE(listing_status,'(null)') AS lstatus, count(*) AS rows,
           count(*) FILTER (WHERE COALESCE(available,0) = 0) AS zero_avail,
           count(*) FILTER (WHERE COALESCE(ghost_reason,'') <> '') AS ghosted,
           count(*) FILTER (WHERE COALESCE(cost,0) > 0) AS have_cost
    FROM public.inventory WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | % rows | % zero avail | % ghosted | % have a cost',
      rpad(r.lstatus,18), lpad(r.rows::text,5), lpad(r.zero_avail::text,5),
      lpad(r.ghosted::text,4), r.have_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== which NOT_IN_CATALOG rows have SOLD recently? (false tombstones) ==';
  FOR r IN
    SELECT inv.asin, COALESCE(inv.sku,'-') AS sku,
           COALESCE(inv.cost::text,'-') AS cost,
           count(so.id) AS orders_30d, sum(so.quantity) AS units_30d,
           max(so.order_date) AS last_sale
    FROM public.inventory inv
    JOIN public.sales_orders so
      ON so.user_id = inv.user_id AND so.asin = inv.asin
         AND so.order_date >= CURRENT_DATE - 30
         AND COALESCE(so.is_cancelled,false) = false
         AND so.order_id NOT LIKE '%-REFUND%'
    WHERE inv.user_id = v_uid AND inv.listing_status = 'NOT_IN_CATALOG'
    GROUP BY 1,2,3 ORDER BY units_30d DESC NULLS LAST LIMIT 20
  LOOP
    RAISE NOTICE '   % | sku % | cost % | % orders / % units in 30d | last sale %',
      r.asin, rpad(r.sku,14), lpad(r.cost,6),
      lpad(r.orders_30d::text,3), lpad(COALESCE(r.units_30d::text,'0'),4), r.last_sale;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none have sold in 30 days)'; END IF;
END
$p$;
