DO $p$
DECLARE r record; n int; v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname='drain-stuck-pending-5m';
  RAISE NOTICE 'now % | job id %', now(), v_jobid;

  SELECT count(*) INTO n FROM cron.job_run_details WHERE jobid = v_jobid;
  RAISE NOTICE 'run details for this job: %', n;
  FOR r IN SELECT status, start_time, end_time, left(COALESCE(return_message,''),90) AS msg
           FROM cron.job_run_details WHERE jobid = v_jobid
           ORDER BY COALESCE(start_time, end_time) DESC NULLS LAST LIMIT 5 LOOP
    RAISE NOTICE '  % | % | %', rpad(r.status,12), r.start_time, r.msg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== are OTHER jobs firing right now? (is pg_cron alive at all) ==';
  FOR r IN SELECT jobid, status, start_time FROM cron.job_run_details
           WHERE start_time > now() - interval '12 minutes'
           ORDER BY start_time DESC LIMIT 6 LOOP
    RAISE NOTICE '  job % | % | %', r.jobid, rpad(r.status,10), r.start_time;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NO job has started in the last 12 minutes'; END IF;
END
$p$;
