-- PROBE (read-only): the 6-hourly cleanup is scheduled and active. What did its
-- last few runs actually do? cron_run_history has no "details" column -- find
-- the real shape first, then read it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_cols text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'cron_run_history';
  RAISE NOTICE 'cron_run_history columns: %', v_cols;

  RAISE NOTICE '';
  RAISE NOTICE '======== last runs of the dead-assignment cleanup ========';
  FOR r IN
    SELECT job_name, status, started_at, finished_at, to_jsonb(t) AS full_row
    FROM public.cron_run_history t
    WHERE job_name ILIKE '%dead%'
    ORDER BY started_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '   % | % | % -> %', r.job_name, r.status, r.started_at, r.finished_at;
    RAISE NOTICE '        %', left(r.full_row::text, 400);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== every cron job that ran in the last 12h ========';
  FOR r IN
    SELECT job_name, count(*) AS runs, max(started_at) AS latest,
           count(*) FILTER (WHERE status <> 'success') AS not_success
    FROM public.cron_run_history
    WHERE started_at > now() - interval '12 hours'
    GROUP BY 1 ORDER BY latest DESC LIMIT 15
  LOOP
    RAISE NOTICE '   %  runs=% latest=% failures=%',
      rpad(left(r.job_name,32),32), r.runs, r.latest, r.not_success;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== did inventory rows actually disappear tonight? ========';
  FOR r IN
    SELECT count(*) AS assignments_updated_0300
    FROM public.repricer_assignments
    WHERE user_id = v_uid
      AND updated_at >= '2026-09-08 03:00:00+00'
      AND updated_at <  '2026-09-08 04:00:00+00'
  LOOP
    RAISE NOTICE '   % assignments were updated in the 03:00 UTC hour', r.assignments_updated_0300;
  END LOOP;
END
$probe$;
