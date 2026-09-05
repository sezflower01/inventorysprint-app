-- Read-only: what does the health dashboard show now?
DO $$
DECLARE r RECORD; v_backlog bigint; v_size text;
BEGIN
  SELECT count(*) INTO v_backlog FROM public.repricer_price_actions
   WHERE created_at < now() - interval '14 days';
  SELECT pg_size_pretty(pg_database_size(current_database())) INTO v_size;
  RAISE NOTICE 'price_actions backlog: % rows | DB size: %', v_backlog, v_size;

  FOR r IN
    SELECT severity, kind, left(message, 72) AS msg, created_at
    FROM public.database_maintenance_alerts
    WHERE acknowledged_at IS NULL
    ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '  OPEN [%] % : % (%)', r.severity, r.kind, r.msg, r.created_at;
  END LOOP;

  FOR r IN
    SELECT status, rows_affected, finished_at
    FROM public.database_maintenance_jobs
    WHERE action = 'nightly_cleanup_repricer_price_actions'
    ORDER BY finished_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '  run % : % (% rows)', r.finished_at, r.status, r.rows_affected;
  END LOOP;
END $$;
