-- PROBE (read-only): why does the 5,000-row DELETE time out, and would
-- VACUUM FULL actually reclaim anything?
--
-- Two specific things to settle, both of which I have got wrong before on
-- this table:
--
-- 1. THE DASHBOARD'S BLOAT NUMBER CANNOT SEE TOAST. It reads n_dead_tup on the
--    main relation, which is why repricer_price_actions shows 0.0% bloat while
--    carrying 5,166 MB of TOAST against a 751 MB heap. The advice I gave on
--    2026-09-05 -- "wait for the row count to fall, then VACUUM FULL" -- rests
--    on VACUUM FULL having something to reclaim. Check the TOAST relation's own
--    dead tuples rather than assuming either way.
--
-- 2. `ctid IN (SELECT ctid ... LIMIT 5000)` does not reliably produce a Tid
--    Scan. Postgres plans `ctid = ANY(array)` as a Tid Scan, but a subquery
--    often becomes a hash join against the whole relation -- which on 2M rows
--    with 13 indexes is exactly the shape that hits a statement timeout while
--    looking like a harmless 5k batch. EXPLAIN settles it; no guessing.
--
-- Creates nothing, changes nothing. EXPLAIN without ANALYZE does not execute.

DO $probe$
DECLARE r record; v_plan text := '';
BEGIN
  RAISE NOTICE '======== 1. TOAST relation: is there dead space to reclaim? ========';
  FOR r IN
    SELECT c.relname AS main,
           t.relname AS toast_rel,
           pg_size_pretty(pg_relation_size(t.oid)) AS toast_size,
           s.n_live_tup, s.n_dead_tup,
           CASE WHEN s.n_live_tup + s.n_dead_tup > 0
                THEN round(100.0 * s.n_dead_tup / (s.n_live_tup + s.n_dead_tup), 1)
                ELSE 0 END AS dead_pct,
           s.last_vacuum, s.last_autovacuum
    FROM pg_class c
    JOIN pg_class t ON t.oid = c.reltoastrelid
    LEFT JOIN pg_stat_all_tables s ON s.relid = t.oid
    WHERE c.relname = 'repricer_price_actions'
      AND c.relnamespace = 'public'::regnamespace
  LOOP
    RAISE NOTICE '   % -> % (%) | live % / dead % (% %% dead) | last vacuum % / auto %',
      r.main, r.toast_rel, r.toast_size, r.n_live_tup, r.n_dead_tup, r.dead_pct,
      r.last_vacuum, r.last_autovacuum;
  END LOOP;

  -- Main-relation stats for contrast: this is what the dashboard reads.
  FOR r IN
    SELECT n_live_tup, n_dead_tup, last_vacuum, last_autovacuum, n_tup_del
    FROM pg_stat_all_tables
    WHERE schemaname='public' AND relname='repricer_price_actions'
  LOOP
    RAISE NOTICE '   main heap: live % / dead % | rows deleted since stats reset: % | last vacuum %',
      r.n_live_tup, r.n_dead_tup, r.n_tup_del, r.last_vacuum;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. plan for the DELETE that keeps timing out ========';
  FOR r IN
    EXPLAIN (COSTS ON, VERBOSE OFF)
    DELETE FROM public.repricer_price_actions
     WHERE ctid IN (SELECT ctid FROM public.repricer_price_actions
                     WHERE created_at < now() - make_interval(days => 14)
                     LIMIT 5000)
  LOOP
    RAISE NOTICE '   %', r."QUERY PLAN";
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. plan for the primary-key alternative ========';
  FOR r IN
    EXPLAIN (COSTS ON, VERBOSE OFF)
    DELETE FROM public.repricer_price_actions
     WHERE id IN (SELECT id FROM public.repricer_price_actions
                   WHERE created_at < now() - make_interval(days => 14)
                   ORDER BY created_at
                   LIMIT 5000)
  LOOP
    RAISE NOTICE '   %', r."QUERY PLAN";
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. plan for ctid = ANY(array), which forces a Tid Scan ========';
  FOR r IN
    EXPLAIN (COSTS ON, VERBOSE OFF)
    DELETE FROM public.repricer_price_actions
     WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.repricer_price_actions
                              WHERE created_at < now() - make_interval(days => 14)
                              LIMIT 5000))
  LOOP
    RAISE NOTICE '   %', r."QUERY PLAN";
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. what 7-day retention would remove ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE created_at < now() - interval '14 days') AS over_14d,
           count(*) FILTER (WHERE created_at < now() - interval '7 days')  AS over_7d,
           count(*) AS total
    FROM public.repricer_price_actions
  LOOP
    RAISE NOTICE '   total % rows | over 14d % (current policy, not yet deleted) | over 7d % = % %% of table',
      r.total, r.over_14d, r.over_7d, round(100.0*r.over_7d/NULLIF(r.total,0),1);
  END LOOP;
END
$probe$;
