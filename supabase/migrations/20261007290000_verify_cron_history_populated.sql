-- STEP 4 verification, read-only.
DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== cron_run_history for the status sync (was: zero rows ever) ==';
  FOR r IN SELECT job_name, status, started_at, duration_ms,
                  COALESCE(items_processed::text,'-') AS items,
                  COALESCE(left(error,60),'-') AS err,
                  COALESCE(detail->>'ordersSeen','-') AS seen
           FROM public.cron_run_history
           WHERE job_name = 'sync-order-status-updates-hourly'
           ORDER BY started_at DESC LIMIT 5 LOOP
    RAISE NOTICE '  % | % | %ms | % updated | % seen | %',
      r.started_at, rpad(r.status,9), lpad(r.duration_ms::text,7),
      lpad(r.items,5), lpad(r.seen,5), r.err;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (still nothing -- the run may not have finished yet)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the HTTP reply ==';
  FOR r IN SELECT status_code, left(content, 600) AS body FROM net._http_response WHERE id = 46623 LOOP
    RAISE NOTICE '  http % | %', r.status_code, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no reply recorded yet)'; END IF;

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE status_source = 'amazon_status_sync';
  RAISE NOTICE '';
  RAISE NOTICE '  rows stamped by the new sync path: %', n;
END
$p$;
