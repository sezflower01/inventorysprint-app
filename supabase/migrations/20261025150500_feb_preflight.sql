-- STAGE 2, FEBRUARY -- PRE-FLIGHT ONLY. READ-ONLY. Nothing is fired here.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_blockers int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '############ 1. CRON FAILURE CLUSTERS, LAST 24H ############';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS minute, count(*) AS failed,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS held_s,
           left(COALESCE(max(d.return_message),'-'),50) AS msg
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1
  LOOP
    RAISE NOTICE '   CLUSTER % | % jobs | held % s | %', r.minute, r.failed, r.held_s, r.msg;
    v_blockers := v_blockers + 1;
  END LOOP;
  IF v_blockers = 0 THEN
    RAISE NOTICE '   CLEAR -- no minute in 24h had 3+ jobs fail together';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   individual failures in 24h, by job:';
  FOR r IN
    SELECT j.jobname, count(*) AS n, left(COALESCE(max(d.return_message),'-'),46) AS msg
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 ORDER BY n DESC LIMIT 6
  LOOP RAISE NOTICE '      % | % | %', rpad(r.jobname,36), lpad(r.n::text,4), r.msg; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      none at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ 2. PG_NET BACKLOG ############';
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   request queue depth: %', v_n;
  IF v_n > 0 THEN v_blockers := v_blockers + 1; RAISE NOTICE '   !! non-zero'; END IF;
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  RAISE NOTICE '   of which repull calls: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   load in the last hour:';
  FOR r IN
    SELECT count(*) AS samples, max(active_connections) AS mc,
           max(waiting_queries) AS mw, round(max(avg_query_ms_5m)::numeric,0) AS mms
    FROM public.system_load_snapshot WHERE captured_at >= now() - interval '1 hour'
  LOOP RAISE NOTICE '      % samples | conns max % | waiting max % | ms max %', r.samples, r.mc, r.mw, r.mms; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '############ 3. pl_sync_progress -- anything running? ############';
  BEGIN
    FOR r IN
      SELECT left(to_jsonb(s)::text, 400) AS j
      FROM public.pl_sync_progress s
      ORDER BY 1 DESC LIMIT 5
    LOOP RAISE NOTICE '   %', r.j; END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   table is EMPTY -- nothing in progress'; END IF;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE '   no table named pl_sync_progress; looking for similar:';
    FOR r IN
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (table_name ILIKE '%sync_progress%' OR table_name ILIKE '%pl_sync%')
    LOOP RAISE NOTICE '      candidate: %', r.table_name; END LOOP;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '############ 4. FEBRUARY, AS IT STANDS ############';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-02-01' AND event_date < '2026-03-01';
  RAISE NOTICE '   live rows in February (all event types): %   (expected 4,964)', v_n;
  IF v_n <> 4964 THEN
    v_blockers := v_blockers + 1;
    RAISE NOTICE '   !! row count has MOVED since the pre-flight on 2026-10-24';
  END IF;

  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month = '2026-02-01';
  RAISE NOTICE '   existing February backup rows: %  (0 = still to be taken)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   the four non-adjustment fingerprints, BEFORE:';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-02-01') ORDER BY event_type
  LOOP RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '############ VERDICT ############';
  IF v_blockers = 0 THEN
    RAISE NOTICE '   PRE-FLIGHT CLEAR -- safe to fire the fresh February dry run';
  ELSE
    RAISE NOTICE '   % BLOCKER(S) -- do not proceed', v_blockers;
  END IF;
END
$p$;
