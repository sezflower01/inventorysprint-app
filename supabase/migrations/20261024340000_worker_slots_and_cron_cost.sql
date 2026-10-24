-- ITEM 1, READ-ONLY, part 4. The cause is now named: "job startup timeout".
-- That is pg_cron failing to LAUNCH a background worker, not a slow query.
-- So the limit that matters is worker slots, not connections -- connections
-- peaked at 21 of 90. This part prints the slot budget and ranks every cron
-- job by the worker-time it actually consumes, so the schedule proposals are
-- grounded in measurement rather than guesswork.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== the slot budget that actually bound us ==';
  FOR r IN
    SELECT name, setting FROM pg_settings
    WHERE name IN ('max_connections','max_worker_processes',
                   'max_parallel_workers','max_parallel_workers_per_gather',
                   'autovacuum_max_workers','max_logical_replication_workers')
    ORDER BY name
  LOOP RAISE NOTICE '   % = %', rpad(r.name,34), r.setting; END LOOP;

  FOR r IN SELECT setting FROM pg_settings WHERE name='cron.max_running_jobs'
  LOOP RAISE NOTICE '   cron.max_running_jobs = %', r.setting; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   cron.max_running_jobs not set (pg_cron default)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== EVERY cron job ranked by worker-seconds consumed in 24h ==';
  RAISE NOTICE '   (concurrency = total_s / 86400: how many worker slots it holds on average)';
  FOR r IN
    SELECT j.jobname, j.schedule,
           count(d.runid) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS avg_s,
           round(sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,0) AS total_s,
           round((sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))/86400.0)::numeric,3) AS concurrency,
           count(d.runid) FILTER (WHERE d.status <> 'succeeded') AS failed
    FROM cron.job j JOIN cron.job_run_details d ON d.jobid=j.jobid
    WHERE d.start_time >= now() - interval '24 hours'
    GROUP BY 1,2 ORDER BY total_s DESC NULLS LAST LIMIT 14
  LOOP
    RAISE NOTICE '   % | % runs | avg % s | total % s | conc % | % failed',
      rpad(r.jobname,38), lpad(r.runs::text,5), lpad(r.avg_s::text,7),
      lpad(r.total_s::text,7), lpad(r.concurrency::text,6), r.failed;
    RAISE NOTICE '        sched: %', r.schedule;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== total cron worker-seconds vs wall clock, 24h ==';
  FOR r IN
    SELECT round(sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,0) AS total_s,
           round((sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))/86400.0)::numeric,2) AS avg_workers,
           count(*) AS runs, count(*) FILTER (WHERE d.status <> 'succeeded') AS failed
    FROM cron.job_run_details d WHERE d.start_time >= now() - interval '24 hours'
  LOOP
    RAISE NOTICE '   % runs | % worker-seconds | average % workers held continuously | % failed',
      r.runs, r.total_s, r.avg_workers, r.failed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every job whose runs ALWAYS fail (pure waste) ==';
  FOR r IN
    SELECT j.jobname, j.schedule, count(*) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS avg_s,
           round(sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,0) AS wasted_s,
           left(COALESCE(max(d.return_message),'(null)'),90) AS msg
    FROM cron.job j JOIN cron.job_run_details d ON d.jobid=j.jobid
    WHERE d.start_time >= now() - interval '24 hours'
    GROUP BY 1,2
    HAVING count(*) FILTER (WHERE d.status = 'succeeded') = 0 AND count(*) >= 3
    ORDER BY wasted_s DESC
  LOOP
    RAISE NOTICE '   % | sched % | % runs | avg % s | % s WASTED',
      r.jobname, r.schedule, r.runs, r.avg_s, r.wasted_s;
    RAISE NOTICE '        last message: %', r.msg;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- every job succeeds at least sometimes'; END IF;
END
$p$;
