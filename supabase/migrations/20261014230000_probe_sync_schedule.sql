-- READ-ONLY. When does the next sync run, and will it respect the new lock?
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== cron jobs that touch sales_orders prices ==';
  RAISE NOTICE '   now() is % UTC', date_trunc('second', now());
  RAISE NOTICE '';
  FOR r IN
    SELECT jobid, jobname, schedule, active,
           (SELECT max(start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run,
           (SELECT status FROM cron.job_run_details d WHERE d.jobid = j.jobid
            ORDER BY start_time DESC LIMIT 1) AS last_status
    FROM cron.job j
    WHERE jobname ILIKE '%order%' OR jobname ILIKE '%sale%' OR jobname ILIKE '%live%'
       OR jobname ILIKE '%price%' OR jobname ILIKE '%pending%' OR jobname ILIKE '%enrich%'
       OR jobname ILIKE '%status%' OR jobname ILIKE '%settle%' OR jobname ILIKE '%financial%'
    ORDER BY jobname
  LOOP
    RAISE NOTICE '   [%] % | % | active % | last % (%)',
      lpad(r.jobid::text,3), rpad(r.jobname,38), rpad(r.schedule,16),
      r.active, COALESCE(date_trunc('second',r.last_run)::text,'never'), COALESCE(r.last_status,'-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no matching cron jobs)'; END IF;
END
$p$;
