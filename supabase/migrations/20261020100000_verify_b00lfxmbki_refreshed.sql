-- READ-ONLY. Did the priority-1 refresh actually write Amazon's numbers, now
-- that the status lock is gone? This is the real test of the fix: the stock did
-- not come from me, it came from rescue-inventory-asin on its normal path.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== B00LFXMBKI AFTER the refresh ==';
  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(listing_status,'-') AS lstatus,
           COALESCE(available::text,'NULL') AS avail,
           COALESCE(reserved::text,'NULL') AS reserved,
           COALESCE(inbound::text,'NULL') AS inbound,
           COALESCE(source,'-') AS src,
           COALESCE(last_inventory_sync_at::text,'never') AS last_sync,
           COALESCE(cost::text,'-') AS cost,
           COALESCE(ghost_reason,'(none)') AS ghost
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | % | avail % | reserved % | inbound %',
      r.sku, r.lstatus, r.avail, r.reserved, r.inbound;
    RAISE NOTICE '   source % | last_inventory_sync % | cost % | ghost_reason %',
      r.src, r.last_sync, r.cost, r.ghost;
    RAISE NOTICE '   Amazon said: available 145 | reserved 11 | inbound 3';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the queue row for it ==';
  FOR r IN
    SELECT status, COALESCE(priority::text,'-') AS pri, COALESCE(attempts::text,'-') AS att,
           COALESCE(processed_at::text,'-') AS done, COALESCE(last_error,'-') AS err
    FROM public.inventory_refresh_queue
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
    ORDER BY created_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '   % | pri % | attempts % | processed % | %',
      rpad(r.status,9), r.pri, r.att, r.done, left(r.err,120);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is it back in the repricer and the valuation? ==';
  FOR r IN
    SELECT to_jsonb(a)::text AS j
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   repricer: %', left(r.j, 700);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   repricer: NO assignment row -- auto-assign-bulk decides this, on its own cadence';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== valuation contribution (available x cost) ==';
  FOR r IN
    SELECT COALESCE(available,0) AS a, COALESCE(cost,0) AS c,
           round(COALESCE(available,0) * COALESCE(cost,0), 2) AS val
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   % units x % = %   (was 0 x % = 0.00)', r.a, r.c, r.val, r.c;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the skipped status in use across the whole queue ==';
  FOR r IN
    SELECT status, count(*) AS rows, max(processed_at) AS latest
    FROM public.inventory_refresh_queue WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | latest %', rpad(r.status,9), lpad(r.rows::text,7), r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what reasons is it recording? (the new observability) ==';
  FOR r IN
    SELECT COALESCE(last_error,'(none)') AS reason, count(*) AS rows
    FROM public.inventory_refresh_queue
    WHERE user_id = v_uid AND status = 'skipped'
    GROUP BY 1 ORDER BY rows DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % rows', rpad(left(r.reason,44),44), r.rows;
  END LOOP;
END
$p$;
