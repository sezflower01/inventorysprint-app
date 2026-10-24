-- READ-ONLY. The current cron picture, before the three approved changes.
-- Nothing is altered here: I want the exact job list and the exact command of
-- the sampler in front of me before touching either.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== is cron.max_running_jobs even settable without a restart? ==';
  FOR r IN
    SELECT name, setting, context, short_desc
    FROM pg_settings WHERE name LIKE 'cron.%' ORDER BY name
  LOOP RAISE NOTICE '   % = % | context %', rpad(r.name,32), rpad(r.setting,8), r.context; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every job on a bare every-minute schedule ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job WHERE schedule IN ('* * * * *','*/1 * * * *')
    ORDER BY jobname
  LOOP RAISE NOTICE '   [%] % | % | active %', lpad(r.jobid::text,4), rpad(r.jobname,42), r.schedule, r.active; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how long do those every-minute jobs actually take? (24h) ==';
  FOR r IN
    SELECT j.jobname,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,2) AS avg_s,
           round(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,2) AS p95_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS max_s
    FROM cron.job j JOIN cron.job_run_details d ON d.jobid=j.jobid
    WHERE j.schedule IN ('* * * * *','*/1 * * * *')
      AND d.start_time >= now() - interval '24 hours'
    GROUP BY 1 ORDER BY avg_s DESC
  LOOP RAISE NOTICE '   % | avg % s | p95 % s | max % s', rpad(r.jobname,42), lpad(r.avg_s::text,6), lpad(r.p95_s::text,6), r.max_s; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the two target jobs, full command ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active, command
    FROM cron.job
    WHERE jobname IN ('capture-slow-queries-1m','seller-catalog-queue-topup')
    ORDER BY jobname
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   [%] % | % | active %', r.jobid, r.jobname, r.schedule, r.active;
    RAISE NOTICE '   command:';
    RAISE NOTICE '%', left(r.command, 2000);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== total jobs, and how many are active ==';
  FOR r IN SELECT count(*) AS total, count(*) FILTER (WHERE active) AS act FROM cron.job
  LOOP RAISE NOTICE '   % jobs, % active', r.total, r.act; END LOOP;
END
$p$;
