-- PROBE (read-only): is the VACUUM FULL actually running, or only displayed
-- as running?
--
-- The UI has shown "running" for over an hour, which is longer than the 30
-- minute statement_timeout the function now sets. Two very different states
-- produce the same screen:
--
--   a) a real VACUUM FULL still holding ACCESS EXCLUSIVE on the table, in
--      which case every repricer write is blocked and the clock matters;
--   b) the edge function was killed by its own wall-clock limit long ago and
--      never got to write the job row's final status, so the row is stuck at
--      'running' while nothing is happening in the database at all.
--
-- pg_stat_activity settles it. Do not trust the dashboard here.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== is a VACUUM running right now? ========';
  n := 0;
  FOR r IN
    SELECT pid, state, wait_event_type, wait_event,
           round(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 0) AS running_secs,
           left(query, 100) AS q
    FROM pg_stat_activity
    WHERE query ILIKE '%VACUUM%' AND pid <> pg_backend_pid()
  LOOP
    n := n + 1;
    RAISE NOTICE '   pid % | % | wait %/% | running % s | %',
      r.pid, r.state, r.wait_event_type, r.wait_event, r.running_secs, r.q;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   NO VACUUM IS RUNNING -- the dashboard row is stale'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== VACUUM FULL progress (pg_stat_progress_cluster) ========';
  n := 0;
  FOR r IN
    SELECT p.pid, p.command, p.phase, c.relname,
           pg_size_pretty(p.heap_blks_total::bigint * 8192)   AS total,
           pg_size_pretty(p.heap_blks_scanned::bigint * 8192) AS scanned,
           CASE WHEN p.heap_blks_total > 0
                THEN round(100.0 * p.heap_blks_scanned / p.heap_blks_total, 1) ELSE 0 END AS pct
    FROM pg_stat_progress_cluster p
    LEFT JOIN pg_class c ON c.oid = p.relid
  LOOP
    n := n + 1;
    RAISE NOTICE '   pid % | % | % | % | % of % (% %%)',
      r.pid, r.relname, r.command, r.phase, r.scanned, r.total, r.pct;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (nothing in flight)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== who holds or waits on the table? ========';
  n := 0;
  FOR r IN
    SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
           round(EXTRACT(EPOCH FROM (now() - a.query_start))::numeric,0) AS secs,
           l.mode, l.granted, left(a.query, 70) AS q
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.relation = 'public.repricer_price_actions'::regclass
      AND a.pid <> pg_backend_pid()
    ORDER BY l.granted, secs DESC
  LOOP
    n := n + 1;
    RAISE NOTICE '   pid % | % | % granted=% | wait %/% | % s | %',
      r.pid, r.state, r.mode, r.granted, r.wait_event_type, r.wait_event, r.secs, r.q;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (nothing holds or waits on repricer_price_actions)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== the job row, and the table size ========';
  FOR r IN
    SELECT action, status,
           round(EXTRACT(EPOCH FROM (now() - started_at))::numeric,0) AS age_secs,
           started_at, finished_at, COALESCE(error_message,'(none)') AS err
    FROM public.database_maintenance_jobs
    WHERE action ILIKE '%vacuum%' ORDER BY started_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '   % | % | age % s | started % | finished % | %',
      r.action, r.status, r.age_secs, r.started_at, r.finished_at, left(r.err,80);
  END LOOP;

  FOR r IN
    SELECT pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'::regclass)) AS t,
           pg_size_pretty(pg_database_size(current_database())) AS db
  LOOP RAISE NOTICE '   table now % | database %', r.t, r.db; END LOOP;
END
$probe$;
