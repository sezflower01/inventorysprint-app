-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Add Purchase in the create extension shows "Saving..." then HTTP 522 --
-- Cloudflare timing out waiting on the origin. The button is ONE PostgREST
-- POST into created_listings (extension-create/background.js,
-- ARBIPRO_ADD_PURCHASE), so a single-row insert is taking longer than the
-- gateway will wait. Either it is blocked on a lock, or something runs on the
-- insert (triggers), or the database is saturated.
--
-- Also answers the question that matters before anyone retries: a 522 does not
-- mean the insert failed. It can commit after the browser gives up, and a
-- retry then records the purchase twice.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. did the purchases land? created_listings, last 3h ========';
  BEGIN
    FOR r IN
      SELECT created_at, asin, sku, units, cost, amount, validation_status
      FROM public.created_listings
      WHERE user_id = v_uid AND created_at > now() - interval '3 hours'
      ORDER BY created_at DESC
      LIMIT 20
    LOOP
      RAISE NOTICE '  % | % | % | units=% cost=% unit=% | %',
        r.created_at, r.asin, r.sku, r.units, r.cost, r.amount, r.validation_status;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  could not read: %', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. connections ========';
  FOR r IN
    SELECT COALESCE(state, '?') AS st, count(*) AS n
    FROM pg_stat_activity GROUP BY state ORDER BY n DESC
  LOOP
    RAISE NOTICE '  % %', rpad(r.st, 30), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. anything running > 5s (excluding replication) ========';
  FOR r IN
    SELECT pid, usename, state, wait_event_type, wait_event,
           round(EXTRACT(epoch FROM now() - query_start)) AS secs,
           left(regexp_replace(query, '\s+', ' ', 'g'), 110) AS q
    FROM pg_stat_activity
    WHERE state <> 'idle'
      AND query_start < now() - interval '5 seconds'
      AND backend_type = 'client backend'
      AND query NOT ILIKE 'START_REPLICATION%'
      AND pid <> pg_backend_pid()
    ORDER BY query_start
    LIMIT 15
  LOOP
    RAISE NOTICE '  pid=% %s % wait=%/% | %',
      r.pid, r.secs, rpad(COALESCE(r.usename,'?'), 16),
      COALESCE(r.wait_event_type,'-'), COALESCE(r.wait_event,'-'), r.q;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. lock waiters and who blocks them ========';
  FOR r IN
    SELECT a.pid, pg_blocking_pids(a.pid) AS blockers,
           round(EXTRACT(epoch FROM now() - a.query_start)) AS secs,
           left(regexp_replace(a.query, '\s+', ' ', 'g'), 90) AS q
    FROM pg_stat_activity a
    WHERE cardinality(pg_blocking_pids(a.pid)) > 0
  LOOP
    RAISE NOTICE '  pid=% waiting %s on % | %', r.pid, r.secs, r.blockers, r.q;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. triggers on created_listings ========';
  FOR r IN
    SELECT t.tgname, p.proname,
           CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
           CASE WHEN t.tgtype & 1 = 1 THEN 'ROW' ELSE 'STMT' END AS lvl,
           concat_ws(',',
             CASE WHEN t.tgtype & 4  = 4  THEN 'INSERT' END,
             CASE WHEN t.tgtype & 8  = 8  THEN 'DELETE' END,
             CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE' END) AS evts
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.created_listings'::regclass
      AND NOT t.tgisinternal
    ORDER BY t.tgname
  LOOP
    RAISE NOTICE '  % % % % -> %', rpad(r.tgname, 44), r.timing, r.lvl, rpad(r.evts, 20), r.proname;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 6. timeouts on the API roles ========';
  FOR r IN
    SELECT rolname, COALESCE(array_to_string(rolconfig, ', '), '-') AS cfg
    FROM pg_roles WHERE rolname IN ('authenticator', 'authenticated', 'anon')
  LOOP
    RAISE NOTICE '  % %', rpad(r.rolname, 16), r.cfg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 7. recent slow statements touching created_listings ========';
  BEGIN
    FOR r IN
      SELECT calls, round(mean_exec_time) AS mean_ms, round(max_exec_time) AS max_ms,
             left(regexp_replace(query, '\s+', ' ', 'g'), 100) AS q
      FROM extensions.pg_stat_statements
      WHERE query ILIKE '%created_listings%'
        AND (query ILIKE 'insert%' OR query ILIKE 'with%insert%')
      ORDER BY max_exec_time DESC
      LIMIT 6
    LOOP
      RAISE NOTICE '  calls=% mean=%ms max=%ms | %', r.calls, r.mean_ms, r.max_ms, r.q;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  pg_stat_statements unavailable: %', SQLERRM;
  END;
END
$probe$;
