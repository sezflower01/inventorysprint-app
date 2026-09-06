-- PROBE (read-only): why does the nightly run die at exactly two minutes?
--
-- run_nightly_maintenance() declares SET statement_timeout TO '30min' and
-- budgets 3 minutes per table. Yet job 128 started 2026-09-05 22:30:01 and was
-- cancelled at 22:32:01 -- two minutes, to the second. Two minutes is also what
-- this pooled session reports. If the cron session's ceiling is really 2min
-- then the function's 30min never takes effect and the 3-minute per-table
-- budget can NEVER fire, because the outer statement dies first.
--
-- That would also explain the shape of the failures exactly: the four tables
-- before repricer_price_actions in table_key order finish in seconds, price
-- actions eats the remaining time and is cancelled, and the two tables after
-- it record 'completed' with 0 rows -- which is what you see when a
-- statement_timeout fires once, is caught by the EXCEPTION block's
-- subtransaction, and the loop carries on.
--
-- And it explains why the manual button works: 2026-09-04 21:13:25 succeeded
-- with 461,022 rows, from a session with a longer ceiling, while every 22:30
-- cron run failed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== the cron job definition ========';
  FOR r IN
    SELECT jobid, schedule, active, username, database, left(command, 200) AS cmd
    FROM cron.job WHERE jobid = 128 OR command ILIKE '%run_nightly_maintenance%'
  LOOP
    RAISE NOTICE '   job % | % | active=% | as % | %', r.jobid, r.schedule, r.active, r.username, r.cmd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== recent runs of job 128, with durations ========';
  FOR r IN
    SELECT start_time, end_time,
           round(EXTRACT(EPOCH FROM (end_time - start_time))::numeric, 1) AS secs,
           status, left(COALESCE(return_message,''), 60) AS msg
    FROM cron.job_run_details WHERE jobid = 128
    ORDER BY start_time DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % -> % (% s) % | %', r.start_time, r.end_time, r.secs, r.status, r.msg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== statement_timeout defaults that could cap the cron session ========';
  FOR r IN
    SELECT 'database: ' || datname AS scope, setconfig::text AS cfg
    FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
    WHERE s.setrole = 0
    UNION ALL
    SELECT 'role: ' || rolname, rolconfig::text FROM pg_roles WHERE rolconfig IS NOT NULL
  LOOP
    RAISE NOTICE '   % -> %', r.scope, r.cfg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what the function itself declares ========';
  FOR r IN
    SELECT proname, proconfig
    FROM pg_proc WHERE proname IN ('run_nightly_maintenance','cleanup_repricer_price_actions')
  LOOP
    RAISE NOTICE '   % : %', r.proname, r.proconfig;
  END LOOP;
END
$probe$;
