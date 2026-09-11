-- PROBE (read-only): did the guarded, twin-less cron jobs actually stop doing
-- their work? Code says each sends only an anon bearer to a guard that wants
-- the internal secret, a service-role key or a real user. None of them log to
-- cron_run_history, so the proof has to be the work itself.
--
-- A report-driven sync writes MANY rows in the same minute, which is what
-- separates it from one-off writers such as fbm-quick-check (a handful of rows).
-- So look for bursts, not the single newest row.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== job 78 sync-fbm-cleanup-all: bulk writes to amazon_sync_fbm rows ========';
  v_n := 0;
  FOR r IN
    SELECT date_trunc('minute', last_inventory_sync_at) AS m, count(*) AS n
    FROM public.inventory
    WHERE user_id = v_uid AND source = 'amazon_sync_fbm' AND last_inventory_sync_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= 5
    ORDER BY 1 DESC LIMIT 6
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % : % rows in one minute', r.m, r.n;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   no bulk write of 5+ amazon_sync_fbm rows ever recorded'; END IF;
  FOR r IN
    SELECT count(*) AS rows_n, max(last_inventory_sync_at) AS newest_any, max(created_at) AS newest_created
    FROM public.inventory WHERE user_id = v_uid AND source = 'amazon_sync_fbm'
  LOOP
    RAISE NOTICE '   % rows total | newest sync on any row % | newest row created %',
      r.rows_n, r.newest_any, r.newest_created;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== job 77 sync-inventory-report-all: bulk writes to amazon_sync rows ========';
  v_n := 0;
  FOR r IN
    SELECT date_trunc('minute', last_inventory_sync_at) AS m, count(*) AS n
    FROM public.inventory
    WHERE user_id = v_uid AND source = 'amazon_sync' AND last_inventory_sync_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= 5
    ORDER BY 1 DESC LIMIT 6
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % : % rows in one minute', r.m, r.n;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   no bulk write of 5+ amazon_sync rows ever recorded'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== jobs 9 + 96 enrich-pending-orders ========';
  FOR r IN
    SELECT max(last_enrich_at) AS newest_enrich,
           max(last_enrich_attempt_at) AS newest_attempt,
           count(*) FILTER (WHERE last_enrich_attempt_at > now() - interval '24 hours') AS attempts_24h,
           count(*) FILTER (WHERE order_status = 'Pending') AS pending_now
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   newest enrich % | newest attempt % | rows attempted in 24h % | Pending now %',
      r.newest_enrich, r.newest_attempt, r.attempts_24h, r.pending_now;
  END LOOP;
  v_n := 0;
  FOR r IN
    SELECT date_trunc('day', last_enrich_attempt_at)::date AS d, count(*) AS n
    FROM public.sales_orders
    WHERE user_id = v_uid AND last_enrich_attempt_at > now() - interval '45 days'
    GROUP BY 1 ORDER BY 1 DESC LIMIT 10
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % : % enrich attempts', r.d, r.n;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   no enrich attempts in 45 days'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== job 6 repair-pending-prices ========';
  FOR r IN
    SELECT max(price_last_attempt_at) AS newest_price_attempt,
           count(*) FILTER (WHERE price_last_attempt_at > now() - interval '24 hours') AS attempts_24h,
           max(pending_enrich_last_attempt_at) AS newest_pending_attempt
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   newest price attempt % (% in 24h) | newest pending-enrich attempt %',
      r.newest_price_attempt, r.attempts_24h, r.newest_pending_attempt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== job 25 clean-ghost-listings ========';
  FOR r IN
    SELECT COALESCE(ghost_source,'(null)') AS src, count(*) AS n, max(ghosted_at) AS newest
    FROM public.inventory
    WHERE user_id = v_uid AND ghosted_at IS NOT NULL
    GROUP BY 1 ORDER BY max(ghosted_at) DESC LIMIT 8
  LOOP
    RAISE NOTICE '   ghost_source=%  % rows, newest %', rpad(r.src,28), r.n, r.newest;
  END LOOP;
END
$probe$;