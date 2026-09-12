-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Reads the health score and the bloat counters after the ANALYZEs, from a
-- transaction separate from them (stats snapshots are fixed per transaction).
--
-- Also reads when cumulative statistics were last reset. Every table checked
-- today reported last_vacuum/last_analyze = never, including 300k-row tables
-- that take constant writes -- which is what a stats reset looks like, since a
-- reset wipes those timestamps along with the counters.

DO $probe$
DECLARE r record; v jsonb;
BEGIN
  RAISE NOTICE 'now: %', now();

  FOR r IN SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()
  LOOP
    RAISE NOTICE '  cumulative stats last reset: %', COALESCE(r.stats_reset::text, 'never recorded');
  END LOOP;

  FOR r IN
    SELECT s.relname AS tbl, c.reltuples::bigint AS reltuples, s.n_live_tup, s.n_dead_tup,
           round(s.n_dead_tup::numeric / NULLIF(s.n_live_tup + s.n_dead_tup, 0) * 100, 1) AS pct,
           COALESCE(array_to_string(c.reloptions, ','), '-') AS opts
    FROM pg_stat_user_tables s
    JOIN pg_class c ON c.oid = s.relid
    WHERE s.relname IN ('financial_events_cache', 'asin_brand_cache', 'seller_catalog_queue')
    ORDER BY s.relname
  LOOP
    RAISE NOTICE '  % reltuples=% live=% dead=% bloat=% reloptions=%',
      rpad(r.tbl, 24), r.reltuples, r.n_live_tup, r.n_dead_tup, r.pct, r.opts;
  END LOOP;

  SELECT public.get_db_health_score() INTO v;
  RAISE NOTICE '';
  RAISE NOTICE '  score=% (%)  critical=% warn=% worst_bloat=% queue=% failed_cron=%',
    v ->> 'score', v ->> 'label', v ->> 'open_critical', v ->> 'open_warn',
    v ->> 'max_bloat_pct', v ->> 'queue_backlog', v ->> 'failed_cron_24h';

  FOR r IN
    SELECT s.schemaname || '.' || s.relname AS tbl, s.n_live_tup, s.n_dead_tup,
           round(s.n_dead_tup::numeric / NULLIF(s.n_live_tup + s.n_dead_tup, 0) * 100, 1) AS pct
    FROM pg_stat_all_tables s
    WHERE s.schemaname IN ('public', 'cron')
      AND (s.n_live_tup + s.n_dead_tup) >= 1000
      AND pg_total_relation_size(format('%I.%I', s.schemaname, s.relname)::regclass) >= 1024 * 1024
    ORDER BY pct DESC NULLS LAST
    LIMIT 3
  LOOP
    RAISE NOTICE '  worst: % % pct (live % dead %)', rpad(r.tbl, 40), r.pct, r.n_live_tup, r.n_dead_tup;
  END LOOP;
END
$probe$;
