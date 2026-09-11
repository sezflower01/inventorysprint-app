-- PROBE (read-only): the rescheduled repair job's 13:07 UTC tick produced no
-- response carrying checks_recorded, recorded no verdicts, and the shortlist
-- is still 290 at 13:10 -- after the run should have finished. Find where it
-- stopped instead of assuming it is just late.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_n int := 0;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== cron run details since the reschedule ========';
  FOR r IN
    SELECT d.runid, d.status, d.start_time, d.end_time,
           left(COALESCE(d.return_message,''), 300) AS msg
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'repair-collapsed-orders-15min'
      AND d.start_time > now() - interval '30 minutes'
    ORDER BY d.start_time DESC
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   run % | % | % -> %', r.runid, r.status, r.start_time, r.end_time;
    RAISE NOTICE '        message: %', r.msg;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no runs in the last 30 minutes for this job name';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== the scheduled command, as stored ========';
  FOR r IN SELECT jobid, left(command, 1500) AS cmd FROM cron.job
           WHERE jobname = 'repair-collapsed-orders-15min'
  LOOP
    RAISE NOTICE '   jobid %', r.jobid;
    RAISE NOTICE '%', r.cmd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== every HTTP response in the last 15 minutes that mentions repair ========';
  v_n := 0;
  FOR r IN
    SELECT id, created, status_code, left(COALESCE(content::text,''), 260) AS body,
           left(COALESCE(error_msg,''), 200) AS err
    FROM net._http_response
    WHERE created > now() - interval '15 minutes'
      AND (content::text LIKE '%repaired%' OR content::text LIKE '%already_correct%'
           OR content::text LIKE '%repair%' OR error_msg IS NOT NULL)
    ORDER BY created DESC LIMIT 15
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   id=% % | % | %', r.id, r.created, r.status_code, r.body;
    IF r.err <> '' THEN RAISE NOTICE '        error_msg: %', r.err; END IF;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   none -- the request was never dispatched, or has not completed';
  END IF;
END
$probe$;