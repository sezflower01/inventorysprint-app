DO $p$
DECLARE r record; v_n int := 0;
BEGIN
  RAISE NOTICE '== realtime publication contents ==';
  FOR r IN
    SELECT schemaname, tablename FROM pg_publication_tables
    WHERE pubname='supabase_realtime' ORDER BY tablename
  LOOP v_n := v_n + 1; RAISE NOTICE '   %.%', r.schemaname, r.tablename; END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   NO tables in supabase_realtime'; END IF;
  RAISE NOTICE '   total % tables broadcasting', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== heaviest recurring cron, by total seconds per hour ==';
  FOR r IN
    SELECT j.jobname, count(*) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time - d.start_time)))::numeric,1) AS avg_s,
           round(sum(EXTRACT(EPOCH FROM (d.end_time - d.start_time)))::numeric/7,0) AS sec_per_hour
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time >= '2026-10-23 22:00+00' AND d.start_time < '2026-10-24 05:00+00'
    GROUP BY 1 HAVING sum(EXTRACT(EPOCH FROM (d.end_time - d.start_time))) > 0
    ORDER BY sec_per_hour DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | % runs | avg %s | %s of every hour',
      rpad(r.jobname,40), lpad(r.runs::text,4), lpad(r.avg_s::text,6), r.sec_per_hour;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 5: the nine public tables without RLS ==';
  FOR r IN
    SELECT c.relname AS t,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
           s.n_live_tup AS rows,
           s.n_tup_ins AS inserts, s.n_tup_upd AS updates, s.n_tup_del AS deletes,
           COALESCE(to_char(greatest(s.last_autovacuum, s.last_vacuum, s.last_analyze),
                            'YYYY-MM-DD'),'never') AS last_maint
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '   %', r.t;
    RAISE NOTICE '      % | % rows | ins % upd % del % | maint %',
      r.size, COALESCE(r.rows::text,'-'), COALESCE(r.inserts::text,'-'),
      COALESCE(r.updates::text,'-'), COALESCE(r.deletes::text,'-'), r.last_maint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do those tables carry a user_id (can they be owner-scoped)? ==';
  FOR r IN
    SELECT t.table_name,
           bool_or(c.column_name = 'user_id') AS has_user_id,
           count(*) AS cols
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema=t.table_schema AND c.table_name=t.table_name
    WHERE t.table_schema='public'
      AND t.table_name IN (SELECT cl.relname FROM pg_class cl
                           JOIN pg_namespace ns ON ns.oid=cl.relnamespace
                           WHERE ns.nspname='public' AND cl.relkind='r' AND NOT cl.relrowsecurity)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | user_id % | % columns', rpad(r.table_name,42), r.has_user_id, r.cols;
  END LOOP;
END
$p$;
