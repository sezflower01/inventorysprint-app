-- PROBE (read-only): after the backlog drain, is there now dead space for
-- VACUUM FULL to reclaim?
--
-- This morning the answer was no: heap and TOAST both showed 0 dead tuples
-- and 12.5 GB of live data, which is why the VACUUM FULL advice was retracted.
-- The picture should be different now that the deletes have actually landed --
-- "Clean now" reports only 3 rows left past the 14-day retention, down from
-- 513,776.
--
-- Deletes create dead tuples; plain VACUUM marks that space reusable but does
-- not hand it back to the operating system. Only VACUUM FULL shrinks the file.
-- So the question is how much dead space exists RIGHT NOW, before autovacuum
-- has a chance to quietly recycle it into new rows.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== rows remaining past retention ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE created_at < now() - interval '14 days') AS over_14d,
           count(*) FILTER (WHERE created_at < now() - interval '7 days')  AS over_7d
    FROM public.repricer_price_actions
  LOOP
    RAISE NOTICE '   repricer_price_actions: % rows | % past 14d | % past 7d',
      r.total, r.over_14d, r.over_7d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== dead tuples: heap and TOAST ========';
  FOR r IN
    SELECT 'heap' AS part, s.n_live_tup, s.n_dead_tup,
           CASE WHEN s.n_live_tup + s.n_dead_tup > 0
                THEN round(100.0*s.n_dead_tup/(s.n_live_tup+s.n_dead_tup),1) ELSE 0 END AS dead_pct,
           pg_size_pretty(pg_relation_size(s.relid)) AS sz,
           s.last_vacuum, s.last_autovacuum
    FROM pg_stat_all_tables s
    WHERE s.schemaname='public' AND s.relname='repricer_price_actions'
    UNION ALL
    SELECT 'TOAST', st.n_live_tup, st.n_dead_tup,
           CASE WHEN st.n_live_tup + st.n_dead_tup > 0
                THEN round(100.0*st.n_dead_tup/(st.n_live_tup+st.n_dead_tup),1) ELSE 0 END,
           pg_size_pretty(pg_relation_size(st.relid)),
           st.last_vacuum, st.last_autovacuum
    FROM pg_class c
    JOIN pg_class t ON t.oid = c.reltoastrelid
    JOIN pg_stat_all_tables st ON st.relid = t.oid
    WHERE c.relname='repricer_price_actions' AND c.relnamespace='public'::regnamespace
  LOOP
    RAISE NOTICE '   %-6s live % / dead % (% %% dead) | % | vacuum % / auto %',
      r.part, r.n_live_tup, r.n_dead_tup, r.dead_pct, r.sz, r.last_vacuum, r.last_autovacuum;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== current size split ========';
  FOR r IN
    SELECT c.relname AS tbl,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_size_pretty(pg_table_size(c.oid) - COALESCE(pg_relation_size(t.oid),0)
                          - COALESCE(pg_relation_size(ti.oid),0)) AS heap,
           pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
           pg_size_pretty(COALESCE(pg_relation_size(t.oid),0)
                        + COALESCE(pg_relation_size(ti.oid),0)) AS toast
    FROM pg_class c
    LEFT JOIN pg_class t  ON t.oid  = c.reltoastrelid
    LEFT JOIN pg_index it ON it.indrelid = c.reltoastrelid
    LEFT JOIN pg_class ti ON ti.oid = it.indexrelid
    WHERE c.relname IN ('repricer_price_actions','repricer_ai_decisions','repricer_competitor_snapshots')
      AND c.relnamespace='public'::regnamespace
    ORDER BY pg_total_relation_size(c.oid) DESC
  LOOP
    RAISE NOTICE '   %-32s total % | heap % | indexes % | TOAST %',
      r.tbl, r.total, r.heap, r.indexes, r.toast;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== whole database ========';
  FOR r IN SELECT pg_size_pretty(pg_database_size(current_database())) AS sz
  LOOP RAISE NOTICE '   %', r.sz; END LOOP;
END
$probe$;
