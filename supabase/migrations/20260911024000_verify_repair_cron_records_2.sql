-- VERIFY, second read. The first read (20260911023000) ran at 12:59 UTC, before
-- the first tick of the rescheduled job at 13:07, and correctly reported that
-- the new function had not run yet. Migrations apply once, so a fresh file is
-- needed to read again.
--
-- Success: a response carrying checks_recorded > 0, rows in
-- collapsed_order_checks, and a shortlist below 290.
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
  RAISE NOTICE '======== responses from the NEW function ========';
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
    RAISE NOTICE '   still no run of the new function';
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
  RAISE NOTICE '======== shortlist (290 at reschedule) ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP
    RAISE NOTICE '   % remain', r.n;
  END LOOP;
END
$probe$;
