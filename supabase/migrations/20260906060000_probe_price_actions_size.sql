-- PROBE (read-only): why is repricer_price_actions 6.9 GB, and why does a
-- 5,000-row DELETE time out?
--
-- Two things on the maintenance dashboard do not fit the advice I gave on
-- 2026-09-05 ("wait for the nightly to drop to ~100k rows, then VACUUM FULL"):
--
--   * bloat on repricer_price_actions reads 0.0%, so there are no dead tuples
--     to reclaim and VACUUM FULL would free almost nothing.
--   * the nightly DELETE batches only 5,000 rows and still hits the statement
--     timeout, which a 5k delete has no business doing unless the planner is
--     scanning rather than seeking, or each row drags a large TOAST payload.
--
-- So: measure the real size split, check whether created_at is actually
-- indexed, and see how the rows distribute by age before recommending
-- anything.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== size split: main vs indexes vs TOAST ========';
  FOR r IN
    SELECT c.relname AS tbl,
           pg_size_pretty(pg_total_relation_size(c.oid))                       AS total,
           pg_size_pretty(pg_table_size(c.oid) - COALESCE(pg_relation_size(t.oid),0)
                          - COALESCE(pg_relation_size(ti.oid),0))              AS main_heap,
           pg_size_pretty(pg_indexes_size(c.oid))                              AS indexes,
           pg_size_pretty(COALESCE(pg_relation_size(t.oid),0)
                        + COALESCE(pg_relation_size(ti.oid),0))                AS toast
    FROM pg_class c
    LEFT JOIN pg_class t  ON t.oid  = c.reltoastrelid
    LEFT JOIN pg_index it ON it.indrelid = c.reltoastrelid
    LEFT JOIN pg_class ti ON ti.oid = it.indexrelid
    WHERE c.relname IN ('repricer_price_actions','repricer_ai_decisions',
                        'repricer_competitor_snapshots','repricer_dispatch_metrics')
      AND c.relnamespace = 'public'::regnamespace
    ORDER BY pg_total_relation_size(c.oid) DESC
  LOOP
    RAISE NOTICE '   %-32s total % | heap % | indexes % | TOAST %',
      r.tbl, r.total, r.main_heap, r.indexes, r.toast;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is created_at indexed on repricer_price_actions? ========';
  FOR r IN
    SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS sz, indexdef
    FROM pg_indexes WHERE schemaname='public' AND tablename='repricer_price_actions'
    ORDER BY pg_relation_size(indexname::regclass) DESC
  LOOP
    RAISE NOTICE '   % (%) : %', r.indexname, r.sz, left(r.indexdef, 110);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== rows by age -- how much would shorter retention remove? ========';
  FOR r IN
    SELECT bucket, cnt,
           round(100.0 * cnt / NULLIF(sum(cnt) OVER (), 0), 1) AS pct
    FROM (
      SELECT CASE
               WHEN created_at >= now() - interval '1 day'  THEN 'a. last 24h'
               WHEN created_at >= now() - interval '3 days' THEN 'b. 1-3 days'
               WHEN created_at >= now() - interval '7 days' THEN 'c. 3-7 days'
               WHEN created_at >= now() - interval '14 days' THEN 'd. 7-14 days'
               ELSE 'e. older than 14 days (should be gone)'
             END AS bucket,
             count(*) AS cnt
      FROM public.repricer_price_actions
      GROUP BY 1
    ) q ORDER BY bucket
  LOOP
    RAISE NOTICE '   %-40s : % rows (%%%)', r.bucket, r.cnt, r.pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== which columns carry the weight? ========';
  FOR r IN
    SELECT attname, avg_width,
           round(avg_width * (SELECT reltuples FROM pg_class
                               WHERE relname='repricer_price_actions'
                                 AND relnamespace='public'::regnamespace) / 1024/1024) AS est_mb
    FROM pg_stats
    WHERE schemaname='public' AND tablename='repricer_price_actions'
    ORDER BY avg_width DESC LIMIT 8
  LOOP
    RAISE NOTICE '   %-30s avg % bytes  (~% MB across the table)', r.attname, r.avg_width, r.est_mb;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== daily write rate (last 7 days) ========';
  FOR r IN
    SELECT created_at::date AS d, count(*) AS rows_written
    FROM public.repricer_price_actions
    WHERE created_at >= now() - interval '7 days'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % : % rows', r.d, r.rows_written;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== statement_timeout in force here ========';
  FOR r IN SELECT current_setting('statement_timeout', true) AS st
  LOOP RAISE NOTICE '   this session: %', r.st; END LOOP;
  FOR r IN
    SELECT rolname, rolconfig FROM pg_roles
    WHERE rolconfig IS NOT NULL AND rolname IN ('postgres','authenticator','service_role','anon','authenticated')
  LOOP RAISE NOTICE '   role % : %', r.rolname, r.rolconfig; END LOOP;
END
$probe$;
