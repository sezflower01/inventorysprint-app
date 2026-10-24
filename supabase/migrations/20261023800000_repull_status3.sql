DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== cron job ==';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname = 'repull-adjustments-2m'
  LOOP RAISE NOTICE '   [%] % | % | active %', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NOT SCHEDULED'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== work list ==';
  FOR r IN
    SELECT seq, to_char(month,'YYYY-MM') AS m, stage, status, attempts, sync_retries,
           COALESCE(req_id::text,'-') AS req, COALESCE(left(note,60),'-') AS note
    FROM public.repull_schedule ORDER BY seq
  LOOP
    RAISE NOTICE '   % | % | % | % | att % | sync % | req % | %',
      r.seq, r.m, rpad(r.stage,5), rpad(r.status,7), r.attempts, r.sync_retries, r.req, r.note;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== recent cron runs ==';
  FOR r IN
    SELECT status, left(COALESCE(return_message,'-'),70) AS msg, start_time
    FROM cron.job_run_details
    WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname='repull-adjustments-2m')
    ORDER BY start_time DESC LIMIT 5
  LOOP RAISE NOTICE '   % | % | %', rpad(r.status,10), r.msg, r.start_time; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no runs yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== persisted reports ==';
  FOR r IN
    SELECT month, applied, report->>'pages' AS pages,
           report->>'api_rows_after_dedupe' AS api_rows,
           report->>'stored_rows' AS stored,
           report->>'api_clawback_total' AS claw,
           COALESCE(report->>'aborted', report->>'error','-') AS problem
    FROM public.repull_reports ORDER BY captured_at
  LOOP
    RAISE NOTICE '   % | applied % | pages % | api % | stored % | claw % | %',
      COALESCE(r.month,'-'), r.applied, COALESCE(r.pages,'-'), COALESCE(r.api_rows,'-'),
      COALESCE(r.stored,'-'), COALESCE(r.claw,'-'), left(r.problem,40);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none yet'; END IF;
END
$p$;
