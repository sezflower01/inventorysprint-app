-- READ-ONLY. Compare the 2026-10-24 12:33 and 2026-10-28 13:32 cron stalls.
-- No cron job is touched.
DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== A. the two stalls, shape ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI:SS') AS started, count(*) AS jobs,
           round(min(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS min_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS max_s,
           to_char(max(d.end_time),'HH24:MI:SS') AS released
    FROM cron.job_run_details d
    WHERE d.status <> 'succeeded'
      AND (d.start_time BETWEEN '2026-10-24 12:30+00' AND '2026-10-24 12:40+00'
        OR d.start_time BETWEEN '2026-10-28 13:28+00' AND '2026-10-28 13:40+00')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % jobs | held % .. % s | released %',
    r.started, r.jobs, r.min_s, r.max_s, r.released; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B. jobs that failed in BOTH stalls ==';
  FOR r IN
    SELECT j.jobname, count(DISTINCT date_trunc('day', d.start_time)) AS in_n_stalls
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.status <> 'succeeded'
      AND (d.start_time BETWEEN '2026-10-24 12:30+00' AND '2026-10-24 12:40+00'
        OR d.start_time BETWEEN '2026-10-28 13:28+00' AND '2026-10-28 13:40+00')
    GROUP BY 1 HAVING count(DISTINCT date_trunc('day', d.start_time)) = 2
    ORDER BY 1
  LOOP RAISE NOTICE '   %', r.jobname; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none in common'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== C. what ran in the 5 minutes BEFORE each, over 5s ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI:SS') AS t, j.jobname,
           round(EXTRACT(EPOCH FROM (d.end_time-d.start_time))::numeric,1) AS secs, d.status
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE ((d.start_time BETWEEN '2026-10-24 12:28+00' AND '2026-10-24 12:33+00')
        OR (d.start_time BETWEEN '2026-10-28 13:27+00' AND '2026-10-28 13:32+00'))
      AND EXTRACT(EPOCH FROM (d.end_time-d.start_time)) > 5
    ORDER BY d.start_time
  LOOP RAISE NOTICE '   % | % | % s | %', r.t, rpad(r.jobname,34), lpad(r.secs::text,7), r.status; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   nothing over 5s preceded either'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== D. connections and waiting, around each ==';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI') AS t, active_connections AS c,
           waiting_queries AS w
    FROM public.system_load_snapshot
    WHERE (captured_at BETWEEN '2026-10-24 12:28+00' AND '2026-10-24 12:36+00')
       OR (captured_at BETWEEN '2026-10-28 13:27+00' AND '2026-10-28 13:36+00')
    ORDER BY captured_at
  LOOP RAISE NOTICE '   % | % conns | % waiting', r.t, lpad(r.c::text,4), r.w; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== E. is there a job scheduled at :30-:33 that could be common? ==';
  FOR r IN
    SELECT jobname, schedule FROM cron.job
    WHERE schedule ~ '^(3[0-3]|\*/3[0-3])' OR schedule LIKE '3_ %' OR schedule LIKE '%,3_ %'
    ORDER BY jobname LIMIT 10
  LOOP RAISE NOTICE '   % | %', rpad(r.jobname,38), r.schedule; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no job keyed to those minutes'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== F. pg_net queue now (11 seen at pre-flight) ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   depth %', v_n;
  FOR r IN
    SELECT left(regexp_replace(url, '^https?://[^/]+', ''), 46) AS path, count(*) AS n
    FROM net.http_request_queue GROUP BY 1 ORDER BY n DESC LIMIT 6
  LOOP RAISE NOTICE '   % | % queued', rpad(r.path,48), r.n; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   queue empty'; END IF;
END
$p$;
