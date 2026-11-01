-- PHASE 2b/2c: is the tombstone trigger installed, and do the writers run?
-- READ ONLY. Two facts the plan depends on, printed on their own so they
-- cannot scroll past.
DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '############ 2c: THE TOMBSTONE TRIGGER ############';
  v_n := 0;
  FOR r IN
    SELECT t.tgname, c.relname AS tbl, p.proname AS fn,
           CASE t.tgenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'DISABLED'
                            WHEN 'A' THEN 'always' WHEN 'R' THEN 'replica'
                            ELSE t.tgenabled::text END AS state
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc  p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND (p.proname ILIKE '%tombstone%' OR p.proname ILIKE '%ghost%')
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % on % | fn % | %', r.tgname, r.tbl, r.fn, r.state;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   >>> NO tombstone/ghost trigger on any table.';
    RAISE NOTICE '   >>> If so, force_relist is unnecessary: an ordinary UPDATE';
    RAISE NOTICE '   >>> would clear listing_status, and the two-step write in';
    RAISE NOTICE '   >>> bulk-live-verify is guarding against nothing.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   does the guard function exist at all?';
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname ILIKE '%ghost_tombstone%'
  LOOP RAISE NOTICE '      function %(%)', r.proname, r.args; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      no such function'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2b: ARE THE TOMBSTONE WRITERS SCHEDULED? ############';
  v_n := 0;
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           max(d.start_time) AS last_run,
           count(d.*) FILTER (WHERE d.start_time >= now() - interval '7 days') AS runs7
    FROM cron.job j
    LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.command ILIKE '%ghost%' OR j.command ILIKE '%fba-listing-eligibility%'
       OR j.jobname ILIKE '%ghost%'
    GROUP BY 1,2,3,4 ORDER BY j.jobname
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % | % | % | active % | %/7d | last %',
      r.jobid, rpad(r.jobname,32), rpad(r.schedule,14), r.active,
      lpad(r.runs7::text,3), r.last_run;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   NONE scheduled. All three tombstone writers are invoked';
    RAISE NOTICE '   from the app or by hand.';
    RAISE NOTICE '   Consequence for 2e: a 24-hour "did it re-tombstone" watch';
    RAISE NOTICE '   is vacuous unless one of them is deliberately run during';
    RAISE NOTICE '   it. The right test is to run the writer ON PURPOSE against';
    RAISE NOTICE '   a revived row and confirm its gate holds.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
