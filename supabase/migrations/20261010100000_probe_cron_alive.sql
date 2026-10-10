DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE 'server time now: %', now();
  SELECT count(*) INTO n FROM cron.job_run_details;
  RAISE NOTICE 'cron.job_run_details holds % rows in total', n;
  FOR r IN SELECT jobid, status, start_time, left(COALESCE(return_message,''),60) AS msg
           FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5 LOOP
    RAISE NOTICE '  job % | % | % | %', r.jobid, rpad(r.status,9), r.start_time, r.msg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'calling drain_tick() by hand to see what it does:';
  FOR r IN SELECT public.drain_tick() AS result LOOP
    RAISE NOTICE '  -> %', r.result;
  END LOOP;

  FOR r IN SELECT last_run_at, last_cohort, consecutive_zero_runs, last_note
           FROM public.stuck_pending_drain_state WHERE id=1 LOOP
    RAISE NOTICE '  state: last_run % | cohort % | zero runs % | %',
      r.last_run_at, r.last_cohort, r.consecutive_zero_runs, r.last_note;
  END LOOP;
END
$p$;
