-- PROBE (read-only): size the remaining Realtime cost honestly before calling
-- anything a problem.
--
-- Established so far: the 185-column hot table is fixed (the gated trigger is
-- live), and fnsku_map is published with FULL replica identity having taken
-- 94,113 updates while nothing in src/ subscribes to it -- every reference is a
-- plain select.
--
-- But "wasteful" and "expensive" are different claims. fnsku_map is 9 narrow
-- columns, so the waste could be a few megabytes of WAL over the table's whole
-- life, which would not justify a config change. Measure before advising.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== replication slots and their lag ========';
  BEGIN
    FOR r IN
      SELECT slot_name, plugin, active,
             pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
      FROM pg_replication_slots
    LOOP
      RAISE NOTICE '   %  plugin=%  active=%  retained WAL=%',
        rpad(r.slot_name,28), r.plugin, r.active, r.retained_wal;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== how big is the realtime.messages backlog? ========';
  BEGIN
    FOR r IN
      SELECT count(*) AS n,
             pg_size_pretty(pg_total_relation_size('realtime.messages')) AS size,
             min(inserted_at) AS oldest, max(inserted_at) AS newest
      FROM realtime.messages
    LOOP
      RAISE NOTICE '   % rows, %  (% .. %)', r.n, r.size, r.oldest, r.newest;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (realtime.messages unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== fnsku_map: how much data per update? ========';
  FOR r IN
    SELECT pg_size_pretty(pg_total_relation_size('public.fnsku_map')) AS total,
           n_live_tup AS rows,
           n_tup_upd AS updates,
           CASE WHEN n_live_tup > 0
                THEN pg_size_pretty((pg_relation_size('public.fnsku_map') / n_live_tup)::bigint)
                ELSE 'n/a' END AS avg_row
    FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = 'fnsku_map'
  LOOP
    RAISE NOTICE '   table %  | % live rows | % updates | ~% per row',
      r.total, r.rows, r.updates, r.avg_row;
    RAISE NOTICE '   FULL replica identity ships old + new, so roughly 2x that';
    RAISE NOTICE '   per update, decoded and discarded with no subscriber.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is fnsku_map still being written? ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE updated_at > now() - interval '24 hours') AS d1,
           count(*) FILTER (WHERE updated_at > now() - interval '7 days') AS d7,
           max(updated_at) AS newest
    FROM public.fnsku_map
  LOOP
    RAISE NOTICE '   % rows | % touched in 24h | % in 7d | newest %',
      r.total, r.d1, r.d7, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== overall database work, for proportion ========';
  FOR r IN
    SELECT sum(n_tup_ins + n_tup_upd + n_tup_del) AS all_writes,
           sum(n_tup_ins + n_tup_upd + n_tup_del) FILTER (
             WHERE relname IN (SELECT tablename FROM pg_publication_tables
                               WHERE pubname = 'supabase_realtime')) AS published_writes
    FROM pg_stat_user_tables WHERE schemaname = 'public'
  LOOP
    RAISE NOTICE '   % writes across public | % of them on published tables (%%%)',
      r.all_writes, r.published_writes,
      round(COALESCE(r.published_writes,0)::numeric / NULLIF(r.all_writes,0) * 100, 2);
  END LOOP;
END
$probe$;
