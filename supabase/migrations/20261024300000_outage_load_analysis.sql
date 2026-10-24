-- ITEM 1, READ-ONLY. The outage window from the recorded history.
--
-- NO CPU METRIC EXISTS. system_load_snapshot records active_connections,
-- waiting_queries and avg_query_ms_5m only, so "CPU" cannot be answered from
-- this data and I will not infer it from query latency.
--
-- The first version of this file died on round(double precision, integer),
-- which does not exist: avg_query_ms_5m and percentile_cont both return
-- double precision. Every round() here casts to numeric first. A failed
-- migration blocks the whole queue, so this is rewritten in place.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== 7-day baseline percentiles (context for the 21-conn/6-wait spike) ==';
  FOR r IN
    SELECT round(percentile_cont(0.50) WITHIN GROUP (ORDER BY active_connections)::numeric,0) AS p50,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY active_connections)::numeric,0) AS p95,
           round(percentile_cont(0.99) WITHIN GROUP (ORDER BY active_connections)::numeric,0) AS p99,
           max(active_connections) AS mx,
           count(*) FILTER (WHERE waiting_queries > 0) AS waitmins,
           count(*) FILTER (WHERE waiting_queries >= 5) AS badmins,
           count(*) AS total
    FROM public.system_load_snapshot
  LOOP
    RAISE NOTICE '   connections p50 % | p95 % | p99 % | max %', r.p50, r.p95, r.p99, r.mx;
    RAISE NOTICE '   minutes with ANY waiting query: % of %, pct %',
      r.waitmins, r.total, round(100.0*r.waitmins/r.total,1);
    RAISE NOTICE '   minutes with 5+ waiting:        % of %, pct %',
      r.badmins, r.total, round(100.0*r.badmins/r.total,2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is avg_query_ms_5m a real metric? it never moved in part 1 ==';
  FOR r IN
    SELECT count(DISTINCT round(avg_query_ms_5m::numeric,0)) AS vals,
           round(min(avg_query_ms_5m)::numeric,1) AS lo,
           round(max(avg_query_ms_5m)::numeric,1) AS hi,
           round(stddev(avg_query_ms_5m)::numeric,2) AS sd,
           count(*) AS rows_total
    FROM public.system_load_snapshot
  LOOP
    RAISE NOTICE '   % distinct whole-ms values across % rows | % .. % | stddev %',
      r.vals, r.rows_total, r.lo, r.hi, r.sd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== slow_query_samples coverage ==';
  FOR r IN SELECT count(*) AS n, min(sampled_at) AS lo, max(sampled_at) AS hi
           FROM public.slow_query_samples
  LOOP RAISE NOTICE '   % rows | % .. %', r.n, r.lo, r.hi; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== slow queries sampled 12:20..13:00 on 2026-10-24 (the outage) ==';
  FOR r IN
    SELECT to_char(sampled_at,'HH24:MI:SS') AS t,
           COALESCE(NULLIF(application_name,''),'(none)') AS app,
           round((duration_ms/1000.0)::numeric,1) AS secs,
           COALESCE(wait_event_type,'-')||'/'||COALESCE(wait_event,'-') AS waiting,
           left(regexp_replace(COALESCE(query,''), '\s+', ' ', 'g'), 100) AS q
    FROM public.slow_query_samples
    WHERE sampled_at >= '2026-10-24 12:20+00' AND sampled_at < '2026-10-24 13:00+00'
    ORDER BY duration_ms DESC NULLS LAST LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | %s | %', r.t, rpad(r.app,20),
      lpad(COALESCE(r.secs::text,'-'),7), r.waiting;
    RAISE NOTICE '      %', r.q;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NOTHING sampled in that window'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== top offenders by total slow seconds, last 48h ==';
  FOR r IN
    SELECT COALESCE(NULLIF(application_name,''),'(none)') AS app,
           count(*) AS n,
           round((max(duration_ms)/1000.0)::numeric,1) AS worst_s,
           round((sum(duration_ms)/1000.0)::numeric,0) AS total_s,
           left(regexp_replace(mode() WITHIN GROUP (ORDER BY left(query,100)), '\s+',' ','g'),85) AS q
    FROM public.slow_query_samples WHERE sampled_at >= now() - interval '48 hours'
    GROUP BY 1 ORDER BY total_s DESC NULLS LAST LIMIT 6
  LOOP
    RAISE NOTICE '   % | % samples | worst %s | total %s',
      rpad(r.app,22), lpad(r.n::text,5), lpad(COALESCE(r.worst_s::text,'-'),7), r.total_s;
    RAISE NOTICE '      %', r.q;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no slow queries recorded in 48h at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== cron runs over 2s, 12:28..12:46 on 2026-10-24 ==';
  FOR r IN
    SELECT j.jobname, to_char(d.start_time,'HH24:MI:SS') AS st,
           round(EXTRACT(EPOCH FROM (d.end_time - d.start_time))::numeric,1) AS secs, d.status
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time >= '2026-10-24 12:28+00' AND d.start_time < '2026-10-24 12:46+00'
      AND EXTRACT(EPOCH FROM (d.end_time - d.start_time)) > 2
    ORDER BY secs DESC LIMIT 10
  LOOP RAISE NOTICE '   % | % | %s | %', r.st, rpad(r.jobname,38), lpad(r.secs::text,7), r.status; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no cron run over 2s in that window'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the two jobs the user named: measured cost over 24h ==';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           count(d.runid) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,2) AS avg_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS max_s,
           round(sum(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,0) AS total_s,
           count(d.runid) FILTER (WHERE d.status <> 'succeeded') AS failed
    FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid=j.jobid
      AND d.start_time >= now() - interval '24 hours'
    WHERE j.jobname ILIKE '%slow%quer%' OR j.jobname ILIKE '%catalog%queue%topup%'
       OR j.jobname ILIKE '%system%load%'
    GROUP BY 1,2,3 ORDER BY total_s DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % | active % | sched: %', r.jobname, r.active, r.schedule;
    RAISE NOTICE '      % runs/24h | avg %s | max %s | TOTAL %s | % failed',
      r.runs, r.avg_s, r.max_s, r.total_s, r.failed;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   neither job matched by name'; END IF;
END
$p$;
