-- Read-only: is the backfill still draining, and are the 401s ours?
DO $$
DECLARE v_pending bigint; r RECORD;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_pending FROM public.asin_brand_cache;
  RAISE NOTICE 'pending now = %', v_pending;

  FOR r IN
    SELECT d.start_time, j.jobname, d.status, left(COALESCE(d.return_message,''),40) AS msg
    FROM cron.job_run_details d JOIN cron.job j USING (jobid)
    WHERE j.jobname = 'catalog-brand-backfill'
    ORDER BY d.start_time DESC LIMIT 4
  LOOP
    RAISE NOTICE '  run % % %', r.start_time, r.status, r.msg;
  END LOOP;

  -- Correlate 401s with the jobs that fire near them.
  FOR r IN
    SELECT status_code, left(content::text, 90) AS body, created
    FROM net._http_response WHERE created > now() - interval '6 minutes'
    ORDER BY id DESC LIMIT 6
  LOOP
    RAISE NOTICE '  % HTTP % : %', r.created, r.status_code, r.body;
  END LOOP;
END $$;
