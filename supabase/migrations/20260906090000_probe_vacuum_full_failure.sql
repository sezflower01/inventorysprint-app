-- PROBE (read-only): why did the one-click VACUUM FULL fail?
--
-- admin-vacuum-full records failures into database_maintenance_jobs with
-- status 'failed' and the message in error_message. Read it rather than
-- guessing at the cause.
--
-- Also checks whether the vacuum did any work before dying: if the table size
-- moved, it got partway; if it is unchanged, it never started.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== recent vacuum jobs ========';
  n := 0;
  FOR r IN
    SELECT action, status, started_at, finished_at,
           round(COALESCE(duration_ms,0)/1000.0, 1) AS secs,
           pg_size_pretty(before_total_bytes) AS before_sz,
           pg_size_pretty(after_total_bytes)  AS after_sz,
           COALESCE(error_message, '(none)') AS err,
           triggered_by_email
    FROM public.database_maintenance_jobs
    WHERE action ILIKE '%vacuum%'
    ORDER BY started_at DESC LIMIT 8
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % | % s | % -> % | by %', r.action, r.status, r.secs, r.before_sz, r.after_sz, r.triggered_by_email;
    RAISE NOTICE '      started % finished %', r.started_at, r.finished_at;
    RAISE NOTICE '      ERROR: %', r.err;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no vacuum jobs recorded at all -- the failure was before the job row was written)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== any failed maintenance job in the last hour ========';
  n := 0;
  FOR r IN
    SELECT action, status, started_at, COALESCE(error_message,'(none)') AS err
    FROM public.database_maintenance_jobs
    WHERE started_at > now() - interval '1 hour'
    ORDER BY started_at DESC LIMIT 12
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % | % | %', r.started_at, r.action, r.status, left(r.err, 140);
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (nothing in the last hour)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== did the table move at all? ========';
  FOR r IN
    SELECT pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'::regclass)) AS total,
           pg_size_pretty(pg_relation_size('public.repricer_price_actions'::regclass))       AS heap,
           pg_size_pretty(pg_indexes_size('public.repricer_price_actions'::regclass))        AS idx,
           pg_size_pretty(pg_database_size(current_database()))                              AS db
  LOOP
    RAISE NOTICE '   table % (heap %, indexes %) | database %', r.total, r.heap, r.idx, r.db;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is anything holding a lock on it right now? ========';
  n := 0;
  FOR r IN
    SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
           round(EXTRACT(EPOCH FROM (now() - a.query_start))::numeric,0) AS secs,
           left(a.query, 90) AS q
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.relation = 'public.repricer_price_actions'::regclass
      AND a.pid <> pg_backend_pid()
  LOOP
    n := n + 1;
    RAISE NOTICE '   pid % | % | wait %/% | % s | %', r.pid, r.state, r.wait_event_type, r.wait_event, r.secs, r.q;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no other session holds a lock on it)'; END IF;
END
$probe$;
