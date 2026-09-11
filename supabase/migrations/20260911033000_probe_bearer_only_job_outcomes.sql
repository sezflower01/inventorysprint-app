-- PROBE (read-only): outcome evidence for the cron jobs that authenticate with
-- nothing but a hardcoded anon bearer and have no vault-secret twin.
--
-- The twin map (20260911032000) found 16 such jobs. Whether each is dead
-- depends on its target's auth guard -- but code can be read wrong, and a
-- guard-less target would make the anon bearer irrelevant. Observable outcomes
-- settle it independently: a job whose target logs success to
-- cron_run_history, or whose data keeps arriving, is alive whatever the code
-- says.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== cron_run_history, last 24h, names matching the suspect targets ========';
  FOR r IN
    SELECT job_name,
           count(*) AS runs,
           count(*) FILTER (WHERE status = 'success') AS ok,
           count(*) FILTER (WHERE status <> 'success') AS not_ok,
           max(started_at) FILTER (WHERE status = 'success') AS last_ok,
           max(started_at) AS last_any
    FROM public.cron_run_history
    WHERE started_at > now() - interval '24 hours'
      AND (job_name ILIKE '%disposition%' OR job_name ILIKE '%settlement%'
        OR job_name ILIKE '%ghost%' OR job_name ILIKE '%dead-assign%'
        OR job_name ILIKE '%enrich-pending%' OR job_name ILIKE '%health-retry%'
        OR job_name ILIKE '%fee-multiplier%' OR job_name ILIKE '%monitor-snapshot%'
        OR job_name ILIKE '%valuation%' OR job_name ILIKE '%pending-price%'
        OR job_name ILIKE '%evaluate-outcome%' OR job_name ILIKE '%fbm-cleanup%'
        OR job_name ILIKE '%inventory-report%' OR job_name ILIKE '%sellabil%'
        OR job_name ILIKE '%fba-shipment%' OR job_name ILIKE '%sales-order%'
        OR job_name ILIKE '%auto-turbo%' OR job_name ILIKE '%sequential%'
        OR job_name ILIKE '%unified-dispatch%')
    GROUP BY job_name ORDER BY job_name
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   %  runs=% ok=% not_ok=% last_ok=% last_any=%',
      rpad(left(r.job_name,40),40), r.runs, r.ok, r.not_ok, r.last_ok, r.last_any;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no cron_run_history rows for any suspect in 24h';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== all job_names in cron_run_history, last 24h (for mapping) ========';
  FOR r IN
    SELECT job_name, count(*) AS runs, max(started_at) AS last_any
    FROM public.cron_run_history
    WHERE started_at > now() - interval '24 hours'
    GROUP BY job_name ORDER BY job_name
  LOOP
    RAISE NOTICE '   %  runs=% last=%', rpad(left(r.job_name,40),40), r.runs, r.last_any;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== data-arrival evidence ========';
  FOR r IN
    SELECT max(created_at) AS newest_order_row, max(updated_at) AS newest_order_update
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   sales_orders: newest insert % | newest update %', r.newest_order_row, r.newest_order_update;
  END LOOP;

  BEGIN
    FOR r IN SELECT max(created_at) AS newest FROM public.settlement_line_items
    LOOP RAISE NOTICE '   settlement_line_items newest: %', r.newest; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '   settlement_line_items: %', SQLERRM; END;

  BEGIN
    FOR r IN SELECT max(updated_at) AS newest FROM public.inventory_valuation_summary
    LOOP RAISE NOTICE '   inventory_valuation_summary newest: %', r.newest; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '   inventory_valuation_summary: %', SQLERRM; END;
END
$probe$;