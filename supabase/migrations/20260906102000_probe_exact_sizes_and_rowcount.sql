-- PROBE (read-only): exact byte sizes and a real row count.
--
-- Correcting my own previous probe: it summed pg_total_relation_size over
-- relkind in ('r','m','i','t'), which double-counts -- pg_total_relation_size
-- ALREADY includes a table's indexes and TOAST. The "unaccounted" figure it
-- printed came out negative for that reason and means nothing. Sum over base
-- tables only.
--
-- Two things that actually matter now:
--   1. Did anything get lost? repricer_price_actions reports live 0 / dead 0,
--      which is what a stats reset looks like -- VACUUM FULL resets those
--      counters when it starts on a relation. A real COUNT(*) settles whether
--      the rows are still there.
--   2. Where did 12 GB -> 15 GB come from? pg_size_pretty rounds, so compare
--      exact bytes rather than rounded labels.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_tables bigint; v_db bigint; v_rows bigint;
BEGIN
  RAISE NOTICE '======== is the data still there? ========';
  SELECT count(*) INTO v_rows FROM public.repricer_price_actions;
  RAISE NOTICE '   repricer_price_actions actual row count: %', v_rows;
  RAISE NOTICE '   (was 1,475,420 before the vacuum attempt)';

  RAISE NOTICE '';
  RAISE NOTICE '======== exact bytes, no rounding ========';
  SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0) INTO v_tables
  FROM pg_class c
  WHERE c.relkind IN ('r','m') AND c.relpersistence = 'p';
  SELECT pg_database_size(current_database()) INTO v_db;
  RAISE NOTICE '   sum of base tables (incl their indexes+TOAST): % bytes = %',
    v_tables, pg_size_pretty(v_tables);
  RAISE NOTICE '   pg_database_size                             : % bytes = %',
    v_db, pg_size_pretty(v_db);
  RAISE NOTICE '   difference (catalogs, orphans, everything else): %',
    pg_size_pretty(v_db - v_tables);

  RAISE NOTICE '';
  RAISE NOTICE '======== repricer_price_actions, exact ========';
  FOR r IN
    SELECT pg_relation_size('public.repricer_price_actions'::regclass) AS heap_b,
           pg_indexes_size('public.repricer_price_actions'::regclass) AS idx_b,
           pg_total_relation_size('public.repricer_price_actions'::regclass) AS tot_b
  LOOP
    RAISE NOTICE '   heap % | indexes % | total % (exact: % bytes)',
      pg_size_pretty(r.heap_b), pg_size_pretty(r.idx_b), pg_size_pretty(r.tot_b), r.tot_b;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== stats reset time -- did a vacuum full touch it? ========';
  FOR r IN
    SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum,
           last_analyze, last_autoanalyze, vacuum_count, autovacuum_count
    FROM pg_stat_all_tables
    WHERE schemaname='public' AND relname IN ('repricer_price_actions','repricer_ai_decisions')
  LOOP
    RAISE NOTICE '   % | live % dead % | vacuum % (n=%) | auto % (n=%) | analyze %',
      r.relname, r.n_live_tup, r.n_dead_tup, r.last_vacuum, r.vacuum_count,
      r.last_autovacuum, r.autovacuum_count, r.last_analyze;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== biggest relations, exact, top 12 ========';
  FOR r IN
    SELECT n.nspname||'.'||c.relname AS rel, pg_total_relation_size(c.oid) AS b
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','m') AND c.relpersistence='p'
    ORDER BY 2 DESC LIMIT 12
  LOOP
    RAISE NOTICE '   %-46s %', r.rel, pg_size_pretty(r.b);
  END LOOP;
END
$probe$;
