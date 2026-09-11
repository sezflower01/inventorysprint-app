-- VERIFY the rescheduled repair job now records verdicts and makes progress.
--
-- Before the fix: 23 runs, 1,149 SP-API calls, 0 repairs, shortlist stuck --
-- the same 50 rows re-checked every run. Success now looks like:
--   * the post-reschedule run's response carries checks_recorded > 0
--   * collapsed_order_checks has rows
--   * the shortlist is below 290
-- If a run has not happened yet, say so rather than read silence as success.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_seen int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== job ========';
  FOR r IN SELECT jobname, schedule, active FROM cron.job
           WHERE jobname = 'repair-collapsed-orders-15min'
  LOOP
    RAISE NOTICE '   % | % | active=%', r.jobname, r.schedule, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== responses from the NEW function (carry checks_recorded) ========';
  FOR r IN
    SELECT created, status_code,
           (content::jsonb ->> 'checks_recorded') AS recorded,
           (content::jsonb ->> 'checked')         AS checked,
           (content::jsonb ->> 'repaired')        AS repaired,
           (content::jsonb ->> 'already_correct') AS ok,
           (content::jsonb ->> 'unverifiable')    AS unver,
           (content::jsonb ->> 'throttled')       AS throttled,
           (content::jsonb ->> 'elapsed_ms')      AS ms
    FROM net._http_response
    WHERE content IS NOT NULL AND content::text LIKE '%"checks_recorded"%'
    ORDER BY created DESC LIMIT 10
  LOOP
    v_seen := v_seen + 1;
    RAISE NOTICE '   % | % | recorded=% checked=% repaired=% ok=% unverif=% throttled=% (%ms)',
      r.created, r.status_code, r.recorded, r.checked, r.repaired, r.ok, r.unver, r.throttled, r.ms;
  END LOOP;
  IF v_seen = 0 THEN
    RAISE NOTICE '   no run of the new function yet -- wait for the next tick and re-run this';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== collapsed_order_checks ========';
  FOR r IN
    SELECT outcome, count(*) AS n, max(checked_at) AS latest
    FROM public.collapsed_order_checks WHERE user_id = v_uid
    GROUP BY outcome ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %  % rows, latest %', rpad(r.outcome,18), r.n, r.latest;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_checks WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   total verdicts: %', r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist (was 290 at reschedule) ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP
    RAISE NOTICE '   % remain', r.n;
  END LOOP;
END
$probe$;
