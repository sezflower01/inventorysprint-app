-- READ-ONLY. Does NOT call drain_tick(). Calling it by hand is what hid the
-- problem last time: the work got done, so "is cron firing" went unanswered.
DO $p$
DECLARE r record; n int; v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname='drain-stuck-pending-5m';
  RAISE NOTICE 'now % | job %', now(), COALESCE(v_jobid::text,'(not scheduled)');

  SELECT count(*) INTO n FROM cron.job_run_details WHERE jobid = v_jobid;
  RAISE NOTICE 'automatic runs recorded for job %: %', v_jobid, n;
  FOR r IN SELECT status, start_time, end_time, left(COALESCE(return_message,''),120) AS msg
           FROM cron.job_run_details WHERE jobid = v_jobid
           ORDER BY COALESCE(start_time, end_time) DESC NULLS LAST LIMIT 5 LOOP
    RAISE NOTICE '  % | start % | end % | %', rpad(r.status,12), r.start_time, r.end_time, r.msg;
  END LOOP;

  FOR r IN SELECT last_run_at, last_cohort, consecutive_zero_runs, last_note
           FROM public.stuck_pending_drain_state WHERE id=1 LOOP
    RAISE NOTICE 'drain state: last_run % | %', r.last_run_at, r.last_note;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'pg_cron liveness -- other jobs in the last 4 minutes:';
  FOR r IN SELECT jobid, status, start_time FROM cron.job_run_details
           WHERE start_time > now() - interval '4 minutes' ORDER BY start_time DESC LIMIT 4 LOOP
    RAISE NOTICE '  job % | % | %', r.jobid, rpad(r.status,10), r.start_time;
  END LOOP;
END
$p$;
