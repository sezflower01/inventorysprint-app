-- ITEM 1, READ-ONLY, part 3.
--
-- Part 2 found the outage: at 12:33:00 EVERY pg_cron job started and every one
-- failed after exactly 677.4 seconds. Ten different jobs failing with an
-- identical duration is not ten failures, it is ONE blocking event that held
-- them all and released at ~12:44:17 -- which is precisely the far edge of the
-- 12:32 -> 12:44 sampling gap, because capture-system-load-1m was one of the
-- jobs stuck.
--
-- This part asks: how wide was it, what failed, and did the database restart?
DO $p$
DECLARE r record; v_n bigint;
BEGIN
  RAISE NOTICE '== every cron job that started 12:30..12:50, by status ==';
  FOR r IN
    SELECT to_char(d.start_time,'HH24:MI:SS') AS st, d.status, count(*) AS jobs,
           round(min(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS min_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS max_s
    FROM cron.job_run_details d
    WHERE d.start_time >= '2026-10-24 12:30+00' AND d.start_time < '2026-10-24 12:50+00'
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '   % | % | % jobs | duration % .. % s', r.st, rpad(r.status,12), lpad(r.jobs::text,4), r.min_s, r.max_s;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the actual failure message (one example) ==';
  FOR r IN
    SELECT j.jobname, left(COALESCE(d.return_message,'(null)'), 300) AS msg
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time >= '2026-10-24 12:30+00' AND d.start_time < '2026-10-24 12:50+00'
      AND d.status <> 'succeeded'
    ORDER BY d.start_time LIMIT 3
  LOOP RAISE NOTICE '   %:', r.jobname; RAISE NOTICE '      %', r.msg; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no failed run found in the window'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== did the database restart? ==';
  FOR r IN
    SELECT pg_postmaster_start_time() AS started,
           round((EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))/3600)::numeric,1) AS uptime_h
  LOOP RAISE NOTICE '   postmaster started % | uptime % hours', r.started, r.uptime_h; END LOOP;

  FOR r IN SELECT setting AS mc FROM pg_settings WHERE name='max_connections'
  LOOP RAISE NOTICE '   max_connections %', r.mc; END LOOP;
  FOR r IN SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()
  LOOP RAISE NOTICE '   pg_stat_database stats_reset %', r.stats_reset; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== other same-shape mass failures in the last 7 days ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS st, count(*) AS jobs_failed,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS held_s
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '7 days' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 5
    ORDER BY 1 DESC LIMIT 15
  LOOP RAISE NOTICE '   % | % jobs failed | held up to % s', r.st, lpad(r.jobs_failed::text,4), r.held_s; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   12:33 today is the ONLY mass failure in 7 days'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ COST OF THE TWO JOBS THE USER NAMED ############';
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           count(d.runid) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,2) AS avg_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS max_s,
           round(sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,0) AS total_s,
           count(d.runid) FILTER (WHERE d.status <> 'succeeded') AS failed
    FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid=j.jobid
      AND d.start_time >= now() - interval '24 hours'
    WHERE j.jobname ILIKE '%slow%quer%' OR j.jobname ILIKE '%catalog%queue%topup%'
       OR j.jobname ILIKE '%system%load%'
    GROUP BY 1,2,3,4 ORDER BY total_s DESC NULLS LAST
  LOOP
    RAISE NOTICE '   [%] % | active % | sched: %', r.jobid, r.jobname, r.active, r.schedule;
    RAISE NOTICE '        % runs/24h | avg % s | max % s | TOTAL % s | % failed',
      r.runs, r.avg_s, r.max_s, r.total_s, r.failed;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   neither job matched by name'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what capture-slow-queries-1m is actually storing ==';
  FOR r IN
    SELECT COALESCE(NULLIF(application_name,''),'(none)') AS app, count(*) AS n,
           round((100.0*count(*) / (SELECT count(*) FROM public.slow_query_samples))::numeric,1) AS pct
    FROM public.slow_query_samples GROUP BY 1 ORDER BY n DESC LIMIT 8
  LOOP RAISE NOTICE '   % | % rows | pct % of the table', rpad(r.app,26), lpad(r.n::text,8), r.pct; END LOOP;

  SELECT count(*) INTO v_n FROM public.slow_query_samples
  WHERE wait_event = 'WalSenderWaitForWAL' OR application_name ILIKE 'realtime_replication%';
  RAISE NOTICE '   of which idle WAL senders (not queries at all): %', v_n;

  FOR r IN SELECT pg_size_pretty(pg_total_relation_size('public.slow_query_samples')) AS sz1,
                  pg_size_pretty(pg_total_relation_size('public.system_load_snapshot')) AS sz2
  LOOP RAISE NOTICE '   slow_query_samples % | system_load_snapshot %', r.sz1, r.sz2; END LOOP;
END
$p$;
