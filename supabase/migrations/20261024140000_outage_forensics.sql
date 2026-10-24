-- READ-ONLY. Items 1, 2 and 5.
--
-- ITEM 1 caveat stated up front: pg_stat_activity is a LIVE view. The outage is
-- over, so it cannot show what was running then -- only what is running now.
-- Historical evidence has to come from what was recorded at the time:
-- cron.job_run_details, the system-load capture table if it has one, and
-- whatever survives in net._http_response (which is purged in batches, so
-- absence there is not evidence of absence).
DO $p$
DECLARE r record; v_n bigint; v_has_load boolean;
BEGIN
  RAISE NOTICE '############ ITEM 1: OUTAGE FORENSICS ############';
  RAISE NOTICE '';
  RAISE NOTICE '== pg_stat_activity NOW (baseline, not the outage) ==';
  FOR r IN
    SELECT state, count(*) AS n, max(now() - query_start) AS longest
    FROM pg_stat_activity WHERE datname = current_database()
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % conns | longest query %', rpad(COALESCE(r.state,'(null)'),20), r.n, r.longest; END LOOP;

  SELECT count(*) INTO v_n FROM pg_stat_activity WHERE datname = current_database();
  RAISE NOTICE '   total % connections', v_n;
  FOR r IN SELECT setting FROM pg_settings WHERE name='max_connections'
  LOOP RAISE NOTICE '   max_connections %', r.setting; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== who holds connections now, by application ==';
  FOR r IN
    SELECT COALESCE(NULLIF(application_name,''),'(none)') AS app, usename, count(*) AS n
    FROM pg_stat_activity WHERE datname = current_database()
    GROUP BY 1,2 ORDER BY n DESC LIMIT 10
  LOOP RAISE NOTICE '   % | % | %', rpad(r.app,28), rpad(COALESCE(r.usename,'-'),18), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is there a recorded system-load history? ==';
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='system_load_samples')
    INTO v_has_load;
  IF NOT v_has_load THEN
    FOR r IN
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND (table_name ILIKE '%system_load%' OR table_name ILIKE '%slow_quer%'
          OR table_name ILIKE '%db_load%' OR table_name ILIKE '%_metrics%')
      ORDER BY table_name
    LOOP RAISE NOTICE '   candidate table: %', r.table_name; END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   no load-history table found by name'; END IF;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== cron runs in the outage window (2026-10-23 22:00 .. 2026-10-24 05:00) ==';
  FOR r IN
    SELECT j.jobname, count(*) AS runs,
           count(*) FILTER (WHERE d.status <> 'succeeded') AS failed,
           round(avg(EXTRACT(EPOCH FROM (d.end_time - d.start_time)))::numeric,1) AS avg_s,
           round(max(EXTRACT(EPOCH FROM (d.end_time - d.start_time)))::numeric,1) AS max_s
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= '2026-10-23 22:00+00' AND d.start_time < '2026-10-24 05:00+00'
    GROUP BY 1 ORDER BY runs DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % | % runs | % failed | avg %s | max %s',
      rpad(r.jobname,40), lpad(r.runs::text,4), lpad(r.failed::text,3),
      lpad(COALESCE(r.avg_s::text,'-'),6), COALESCE(r.max_s::text,'-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no cron run details in that window'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== total cron runs per hour across the window ==';
  FOR r IN
    SELECT to_char(date_trunc('hour', start_time),'MM-DD HH24:00') AS hr,
           count(*) AS runs, count(*) FILTER (WHERE status <> 'succeeded') AS failed
    FROM cron.job_run_details
    WHERE start_time >= '2026-10-23 20:00+00' AND start_time < '2026-10-24 06:00+00'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % runs | % failed', r.hr, lpad(r.runs::text,5), r.failed; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== pg_net: what survives, and how much ==';
  FOR r IN
    SELECT count(*) AS responses, min(id) AS lo, max(id) AS hi,
           min(created) AS oldest, max(created) AS newest
    FROM net._http_response
  LOOP
    RAISE NOTICE '   % responses | ids % .. % | % .. %',
      r.responses, r.lo, r.hi, r.oldest, r.newest;
  END LOOP;
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   queue depth now %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== MY job: how many times did it ever run? ==';
  FOR r IN
    SELECT count(*) AS n FROM public.repull_reports
  LOOP RAISE NOTICE '   repull_reports rows (one per completed function run): %', r.n; END LOOP;
  FOR r IN
    SELECT left(month,7) AS m, count(*) AS runs, min(captured_at) AS first, max(captured_at) AS last
    FROM public.repull_reports GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % runs | % .. %', r.m, r.runs, to_char(r.first,'MM-DD HH24:MI'), to_char(r.last,'MM-DD HH24:MI'); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '############ ITEM 2: REALTIME BROADCAST FIX ############';
  RAISE NOTICE '';
  RAISE NOTICE '== are the 2026-08-27 migrations applied? ==';
  FOR r IN
    SELECT v AS version,
           EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v) AS applied
    FROM (VALUES ('20260827120000'),('20260827120001'),('20260827120002')) AS t(v)
  LOOP RAISE NOTICE '   % | applied %', r.version, r.applied; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== which tables are in the realtime publication? ==';
  FOR r IN
    SELECT schemaname, tablename FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' ORDER BY tablename
  LOOP RAISE NOTICE '   %.%', r.schemaname, r.tablename; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   publication supabase_realtime has NO tables'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ ITEM 5: THE NINE TABLES WITHOUT RLS ############';
  FOR r IN
    SELECT c.relname AS t,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
           (SELECT n_live_tup FROM pg_stat_user_tables s WHERE s.relid = c.oid) AS rows,
           (SELECT greatest(COALESCE(last_autovacuum,'-infinity'),
                            COALESCE(last_vacuum,'-infinity'),
                            COALESCE(last_analyze,'-infinity'))
            FROM pg_stat_user_tables s WHERE s.relid = c.oid) AS last_maint,
           (SELECT n_tup_ins + n_tup_upd + n_tup_del FROM pg_stat_user_tables s
            WHERE s.relid = c.oid) AS writes_since_stats_reset
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '   % | % | % rows | writes % | last maint %',
      rpad(r.t,42), lpad(r.size,10), lpad(COALESCE(r.rows::text,'-'),8),
      lpad(COALESCE(r.writes_since_stats_reset::text,'-'),8),
      COALESCE(to_char(r.last_maint,'YYYY-MM-DD'),'-');
  END LOOP;
END
$p$;
