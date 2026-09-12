-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 20260912160000 ran ANALYZE on financial_events_cache and disproved its own
-- premise: an actual count(*) returned 117,574 rows, matching reltuples
-- (116,924). reltuples was right all along. The numbers that are stale are the
-- statistics COUNTERS -- n_live_tup 1,369 and n_dead_tup 5,633 -- which is
-- where the dashboard's "80.4% bloat" comes from.
--
-- The same pattern explains "worst bloat 100%": asin_brand_cache reports
-- live=0 dead=7,211 but holds ~333,000 rows, and seller_catalog_queue reports
-- live=0 dead=13,731. Both are counter artifacts, not bloat.
--
-- Counters were read inside the same transaction as the ANALYZE, and the stats
-- snapshot is fixed per transaction, so that migration could not see whether
-- ANALYZE corrected them. This reads them from a fresh transaction to find out
-- -- which decides whether ANALYZE is the fix for the score's last 15 bloat
-- points, or whether those counters only reset on VACUUM.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN
    SELECT s.relname AS tbl, c.reltuples::bigint AS reltuples,
           s.n_live_tup, s.n_dead_tup,
           s.last_analyze, s.last_autoanalyze, s.last_vacuum, s.last_autovacuum
    FROM pg_stat_user_tables s
    JOIN pg_class c ON c.oid = s.relid
    WHERE s.relname IN ('financial_events_cache', 'asin_brand_cache', 'seller_catalog_queue')
    ORDER BY s.relname
  LOOP
    RAISE NOTICE '  % reltuples=% live=% dead=% analyze=% vacuum=%',
      rpad(r.tbl, 24), r.reltuples, r.n_live_tup, r.n_dead_tup,
      COALESCE(r.last_analyze::text, r.last_autoanalyze::text, 'never'),
      COALESCE(r.last_vacuum::text, r.last_autovacuum::text, 'never');
  END LOOP;
END
$probe$;
