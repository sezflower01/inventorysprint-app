-- PROBE (read-only): the database grew 12 GB -> 15 GB while a VACUUM FULL was
-- killed partway. Where did the 3 GB go?
--
-- A VACUUM FULL does not shrink in place. It writes a COMPLETE NEW COPY of the
-- table and its indexes, then swaps and drops the old one. So while it runs,
-- the database temporarily holds BOTH copies -- for this table that is an
-- extra ~7 GB at peak. If the backend is killed rather than rolled back
-- cleanly, the half-written copy can be left on disk as an orphaned
-- relfilenode: no pg_class row points at it, so it is invisible to every
-- normal size query, but it still occupies space and still counts toward
-- pg_database_size.
--
-- The test is arithmetic: add up every relation Postgres knows about and
-- compare to what the database actually occupies. A large unexplained
-- remainder is orphaned files.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_known bigint; v_db bigint;
BEGIN
  SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0) INTO v_known
  FROM pg_class c
  WHERE c.relkind IN ('r','m','i','t','S')
    AND c.relpersistence <> 't';

  SELECT pg_database_size(current_database()) INTO v_db;

  RAISE NOTICE '======== accounted for vs actual ========';
  RAISE NOTICE '   sum of all known relations : %', pg_size_pretty(v_known);
  RAISE NOTICE '   pg_database_size           : %', pg_size_pretty(v_db);
  RAISE NOTICE '   UNACCOUNTED                : %', pg_size_pretty(v_db - v_known);
  IF v_db - v_known > 1073741824 THEN
    RAISE NOTICE '   -> over 1 GB unaccounted: consistent with orphaned files left by';
    RAISE NOTICE '      the killed VACUUM FULL. Those are reclaimed on a database';
    RAISE NOTICE '      restart, not by VACUUM.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== ten largest relations right now ========';
  FOR r IN
    SELECT n.nspname || '.' || c.relname AS rel,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS sz
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','m')
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10
  LOOP
    RAISE NOTICE '   %-46s %', r.rel, r.sz;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== did repricer_price_actions grow, or stay put? ========';
  FOR r IN
    SELECT pg_size_pretty(pg_relation_size('public.repricer_price_actions'::regclass)) AS heap,
           pg_size_pretty(pg_indexes_size('public.repricer_price_actions'::regclass)) AS idx,
           pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'::regclass)) AS total,
           (SELECT n_live_tup FROM pg_stat_all_tables
             WHERE schemaname='public' AND relname='repricer_price_actions') AS live,
           (SELECT n_dead_tup FROM pg_stat_all_tables
             WHERE schemaname='public' AND relname='repricer_price_actions') AS dead
  LOOP
    RAISE NOTICE '   heap % | indexes % | total % | live % / dead %',
      r.heap, r.idx, r.total, r.live, r.dead;
  END LOOP;

  -- The size-history block that was here referenced a column that does not
  -- exist on database_size_snapshots, and its EXCEPTION handler only caught
  -- undefined_table, so the whole probe aborted and blocked every migration
  -- queued behind it. Removed rather than guessed at; 20260906102000 reads the
  -- sizes directly instead.
END
$probe$;
