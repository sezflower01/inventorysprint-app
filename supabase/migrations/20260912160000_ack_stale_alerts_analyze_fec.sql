-- Clear two alerts that describe problems which no longer exist, and fix the
-- statistics on financial_events_cache.
--
-- ---- WHY THE HEALTH SCORE READS 10 --------------------------------------
--
-- get_db_health_score() on 2026-09-12:
--
--   100
--   - 30   database > 6 GB                               real
--   - 40   two open critical alerts (20 each, capped)    one of them stale
--   -  5   one open warn alert                           stale
--   - 15   worst bloat > 50%                             financial_events_cache
--   = 10
--
-- ---- THE TWO STALE ALERTS -----------------------------------------------
--
-- nightly_cleanup_failed (raised 2026-09-03). Nothing in the system EVER
-- acknowledges this kind -- evaluate_health_alerts() auto-clears the size,
-- history and backlog alerts when their condition passes, but not this one.
-- So a single bad night holds 20 points off the score forever. The nightly has
-- completed every night since 2026-09-06. Acknowledged here only if a
-- completed nightly_cleanup for the same table exists AFTER the alert, so a
-- genuinely unresolved failure is left alone.
--
-- db_size_warn (raised 2026-06-24, "6133 MB > 4 GB"). The evaluator raises
-- this only for 4-6 GB and auto-clears it only at or below 4 GB. Once the
-- database passed 6 GB it raised db_size_critical instead, and the warn was
-- stranded: superseded, but never cleared. Acknowledged here only while a
-- db_size_critical is open, i.e. only when it is genuinely superseded.
--
-- db_size_critical is NOT touched. The database really is 15 GB; that alert
-- is accurate and the cleanup work in 20260912110000/120000/130000 is what
-- will eventually clear it.
--
-- ---- financial_events_cache ---------------------------------------------
--
-- Never vacuumed, never analysed. Measured 2026-09-12: pg_class.reltuples says
-- 116,924 rows while the stats counters say 1,369 live and 5,633 dead.
--
-- That stale reltuples is probably why autovacuum has never run on it.
-- Autovacuum triggers at 50 + 0.2 x reltuples dead rows = ~23,400 using the
-- stale figure, so 5,633 dead rows never qualify. ANALYZE corrects reltuples;
-- if the table really holds ~1.4k rows the threshold drops to a few hundred and
-- autovacuum should pick the table up on its own.
--
-- ANALYZE rather than VACUUM ANALYZE because VACUUM cannot run inside a
-- transaction block, and every migration is one.

DO $fix$
DECLARE
  r record;
  v jsonb;
  v_acked int;
BEGIN
  RAISE NOTICE 'now: %', now();

  SELECT public.get_db_health_score() INTO v;
  RAISE NOTICE '';
  RAISE NOTICE '======== before ========';
  RAISE NOTICE '  score=% (%)  critical=% warn=% worst_bloat=% failed_cron=%',
    v ->> 'score', v ->> 'label', v ->> 'open_critical', v ->> 'open_warn',
    v ->> 'max_bloat_pct', v ->> 'failed_cron_24h';
  FOR r IN
    SELECT severity, kind, created_at, left(message, 70) AS msg
    FROM public.database_maintenance_alerts
    WHERE acknowledged_at IS NULL
    ORDER BY created_at
  LOOP
    RAISE NOTICE '  open: % % % | %', rpad(r.severity, 8), rpad(r.kind, 24), r.created_at, r.msg;
  END LOOP;

  -- nightly_cleanup_failed: only where a later completed run for that table exists.
  UPDATE public.database_maintenance_alerts a
     SET acknowledged_at = now()
   WHERE a.acknowledged_at IS NULL
     AND a.kind = 'nightly_cleanup_failed'
     AND EXISTS (
       SELECT 1 FROM public.database_maintenance_jobs j
       WHERE j.action = 'nightly_cleanup_' || (a.context ->> 'table_key')
         AND j.status = 'completed'
         AND j.started_at > a.created_at
     );
  GET DIAGNOSTICS v_acked = ROW_COUNT;
  RAISE NOTICE '';
  RAISE NOTICE '  acknowledged % nightly_cleanup_failed (later completed run found)', v_acked;

  -- db_size_warn: only while superseded by an open db_size_critical.
  UPDATE public.database_maintenance_alerts
     SET acknowledged_at = now()
   WHERE acknowledged_at IS NULL
     AND kind = 'db_size_warn'
     AND EXISTS (
       SELECT 1 FROM public.database_maintenance_alerts c
       WHERE c.kind = 'db_size_critical' AND c.acknowledged_at IS NULL
     );
  GET DIAGNOSTICS v_acked = ROW_COUNT;
  RAISE NOTICE '  acknowledged % db_size_warn (superseded by an open db_size_critical)', v_acked;

  RAISE NOTICE '';
  RAISE NOTICE '======== financial_events_cache, before ANALYZE ========';
  FOR r IN
    SELECT c.reltuples::bigint AS reltuples, s.n_live_tup, s.n_dead_tup,
           s.last_analyze, s.last_autoanalyze
    FROM pg_class c
    JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.oid = 'public.financial_events_cache'::regclass
  LOOP
    RAISE NOTICE '  reltuples=% live=% dead=% analyzed=%',
      r.reltuples, r.n_live_tup, r.n_dead_tup,
      COALESCE(r.last_analyze::text, COALESCE(r.last_autoanalyze::text, 'never'));
  END LOOP;
END
$fix$;

ANALYZE public.financial_events_cache;

DO $after$
DECLARE r record; v jsonb; v_real bigint;
BEGIN
  SELECT count(*) INTO v_real FROM public.financial_events_cache;

  RAISE NOTICE '';
  RAISE NOTICE '======== financial_events_cache, after ANALYZE ========';
  FOR r IN
    SELECT c.reltuples::bigint AS reltuples, s.n_live_tup, s.n_dead_tup
    FROM pg_class c
    JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.oid = 'public.financial_events_cache'::regclass
  LOOP
    RAISE NOTICE '  reltuples=% (actual count %) live=% dead=%',
      r.reltuples, v_real, r.n_live_tup, r.n_dead_tup;
    RAISE NOTICE '  autovacuum now triggers at ~% dead rows', 50 + round(0.2 * r.reltuples);
  END LOOP;

  SELECT public.get_db_health_score() INTO v;
  RAISE NOTICE '';
  RAISE NOTICE '======== after ========';
  RAISE NOTICE '  score=% (%)  critical=% warn=% worst_bloat=% failed_cron=%',
    v ->> 'score', v ->> 'label', v ->> 'open_critical', v ->> 'open_warn',
    v ->> 'max_bloat_pct', v ->> 'failed_cron_24h';
  FOR r IN
    SELECT severity, kind, created_at
    FROM public.database_maintenance_alerts
    WHERE acknowledged_at IS NULL
    ORDER BY created_at
  LOOP
    RAISE NOTICE '  still open: % % %', rpad(r.severity, 8), rpad(r.kind, 24), r.created_at;
  END LOOP;

  -- Name the table behind "worst bloat", since that is the next 15 points.
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
    RAISE NOTICE '  bloat: % % pct (live % dead %)', rpad(r.tbl, 40), r.pct, r.n_live_tup, r.n_dead_tup;
  END LOOP;
END
$after$;
