-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The maintenance dashboard reports 15.2 GB with nightly cleanup succeeding and
-- table sizes that never move (6.9 GB -> 6.9 GB, every night). It also reports
-- "Cleanup DELETEs: 0 B" reclaimed against 14.9M rows deleted. Those are not in
-- conflict -- a DELETE never returns disk to the filesystem -- but the dashboard
-- cannot say how much of the 6.9 GB is reusable free space versus live data,
-- and that is the number that decides whether VACUUM FULL is worth a lock.
--
-- Measures:
--   1. heap vs index vs TOAST for the biggest tables -- a table that is mostly
--      index is a REINDEX CONCURRENTLY job (no lock), not a VACUUM FULL job.
--   2. per-index size and scan count on repricer_price_actions -- an index with
--      zero scans is free space with no downside to dropping.
--   3. the retention window actually in force, from the oldest surviving row.
--   4. autovacuum state on the tables the dashboard says were NEVER vacuumed.
--   5. long transactions and replication slots, which hold the xmin horizon
--      back and make VACUUM unable to free anything however often it runs.

DO $probe$
DECLARE
  r record;
  v_bytes bigint;
BEGIN
  RAISE NOTICE 'now: %', now();
  SELECT pg_database_size(current_database()) INTO v_bytes;
  RAISE NOTICE 'database size: %', pg_size_pretty(v_bytes);

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. heap vs index vs toast ========';
  FOR r IN
    SELECT c.relname                                            AS tbl,
           pg_size_pretty(pg_relation_size(c.oid))              AS heap,
           pg_size_pretty(pg_indexes_size(c.oid))               AS idx,
           pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
           pg_size_pretty(pg_total_relation_size(c.oid))        AS total,
           c.reltuples::bigint                                  AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname IN ('public', 'cron')
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 12
  LOOP
    RAISE NOTICE '  % heap=% idx=% toast=% total=% rows=%',
      rpad(r.tbl, 38), lpad(r.heap, 9), lpad(r.idx, 9), lpad(r.toast, 9),
      lpad(r.total, 9), r.est_rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. indexes on repricer_price_actions ========';
  RAISE NOTICE '   (idx_scan = 0 means nothing has used it since stats were reset)';
  FOR r IN
    SELECT indexrelname AS idx,
           pg_size_pretty(pg_relation_size(indexrelid)) AS sz,
           idx_scan
    FROM pg_stat_user_indexes
    WHERE relname = 'repricer_price_actions'
    ORDER BY pg_relation_size(indexrelid) DESC
  LOOP
    RAISE NOTICE '  % % scans=%', rpad(r.idx, 46), lpad(r.sz, 9), r.idx_scan;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. retention actually in force ========';
  FOR r IN
    SELECT min(created_at) AS oldest,
           max(created_at) AS newest,
           count(*)        AS n
    FROM public.repricer_price_actions
  LOOP
    RAISE NOTICE '  repricer_price_actions: % rows, oldest %, newest %', r.n, r.oldest, r.newest;
    RAISE NOTICE '  span: % days (retention setting says 14)',
      round(EXTRACT(epoch FROM (r.newest - r.oldest)) / 86400.0, 1);
  END LOOP;
  FOR r IN
    SELECT min(created_at) AS oldest, count(*) AS n
    FROM public.repricer_ai_decisions
  LOOP
    RAISE NOTICE '  repricer_ai_decisions:  % rows, oldest % (retention 30, recommended 14)', r.n, r.oldest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. autovacuum state ========';
  FOR r IN
    SELECT relname AS tbl, n_live_tup, n_dead_tup,
           last_vacuum, last_autovacuum, last_analyze
    FROM pg_stat_user_tables
    WHERE relname IN ('repricer_price_actions', 'repricer_ai_decisions',
                      'financial_events_cache', 'fba_inbound_fees',
                      'repricer_competitor_snapshots')
    ORDER BY n_dead_tup DESC
  LOOP
    RAISE NOTICE '  % live=% dead=% vac=% autovac=%',
      rpad(r.tbl, 32), lpad(r.n_live_tup::text, 10), lpad(r.n_dead_tup::text, 8),
      COALESCE(r.last_vacuum::text, 'never'), COALESCE(r.last_autovacuum::text, 'never');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. what holds the xmin horizon back ========';
  RAISE NOTICE '   VACUUM cannot free a row newer than the oldest running snapshot,';
  RAISE NOTICE '   so an old transaction or a stale replication slot makes nightly';
  RAISE NOTICE '   cleanup unable to reclaim space however often it runs.';
  FOR r IN
    SELECT pid, state, usename,
           now() - xact_start AS xact_age,
           left(regexp_replace(query, '\s+', ' ', 'g'), 60) AS q
    FROM pg_stat_activity
    WHERE xact_start IS NOT NULL
      AND now() - xact_start > interval '2 minutes'
    ORDER BY xact_start
    LIMIT 10
  LOOP
    RAISE NOTICE '  pid=% % % age=% | %', r.pid, rpad(COALESCE(r.state,'?'), 20),
      rpad(COALESCE(r.usename,'?'), 18), r.xact_age, r.q;
  END LOOP;

  FOR r IN
    SELECT slot_name, active, COALESCE(wal_status, 'n/a') AS wal_status,
           pg_size_pretty(
             pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
    FROM pg_replication_slots
    ORDER BY slot_name
  LOOP
    RAISE NOTICE '  slot % active=% wal=% retained=%',
      rpad(r.slot_name, 46), r.active, r.wal_status, r.retained_wal;
  END LOOP;

  FOR r IN
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE state = 'idle in transaction'
  LOOP
    RAISE NOTICE '  idle in transaction right now: %', r.n;
  END LOOP;
END
$probe$;
