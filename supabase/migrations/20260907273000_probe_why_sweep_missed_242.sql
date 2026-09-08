-- PROBE (read-only): were the 242 orphans ever touched by the sweep, and has
-- the fixed cleanup actually run since it was fixed?
--
-- Two candidate explanations and they lead to different fixes:
--   (a) they were never disabled -> the sweep has a gap, fix the query
--   (b) they were disabled and re-enabled -> something is undoing the sweep
-- last_disabled_by decides it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== the 242: have they EVER been disabled? ========';
  FOR r IN
    SELECT COALESCE(a.last_disabled_by, '(never disabled)') AS who,
           count(*) AS n,
           max(a.last_disabled_at) AS most_recent
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %  : % rows (last disabled %)', rpad(r.who,26), r.n, r.most_recent;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== when were the 242 last updated? ========';
  FOR r IN
    SELECT date_trunc('hour', a.updated_at) AS hr, count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    GROUP BY 1 ORDER BY 1 DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % : % rows', r.hr, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== has cleanup-dead-assignments run since it was fixed? ========';
  BEGIN
    FOR r IN
      SELECT job_name, status, started_at, finished_at,
             COALESCE(details::text,'') AS details
      FROM public.cron_run_history
      WHERE job_name ILIKE '%dead-assign%' OR job_name ILIKE '%cleanup-dead%'
      ORDER BY started_at DESC LIMIT 6
    LOOP
      RAISE NOTICE '   % | % | started % | finished %',
        r.job_name, r.status, r.started_at, r.finished_at;
      RAISE NOTICE '        %', left(r.details, 240);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (cron_run_history unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== is the cron job even scheduled? ========';
  BEGIN
    FOR r IN
      SELECT jobname, schedule, active
      FROM cron.job
      WHERE command ILIKE '%dead-assign%'
    LOOP
      RAISE NOTICE '   % | % | active=%', r.jobname, r.schedule, r.active;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (cron.job unreadable: %)', SQLERRM;
  END;
END
$probe$;
