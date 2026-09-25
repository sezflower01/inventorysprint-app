-- READ-ONLY PROBE. What happened to the 5 listings re-queued by
-- recheck_stale_failed_validations(), and what the whole validation picture
-- looks like now.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the re-queued listings ==';
  FOR r IN SELECT cl.asin, cl.sku, cl.validation_status,
                  left(COALESCE(cl.validation_failure_reason, '-'), 60) AS failure,
                  left(COALESCE(cl.validation_warning, '-'), 60) AS warning,
                  to_char(cl.validation_auto_recheck_at, 'HH24:MI:SS') AS requeued_at,
                  q.next_stage, q.attempts, to_char(q.next_run_at, 'HH24:MI:SS') AS next_run,
                  left(COALESCE(q.last_error, '-'), 50) AS last_error
           FROM public.created_listings cl
           LEFT JOIN public.listing_validation_queue q ON q.listing_id = cl.id
           WHERE cl.user_id = v_uid AND cl.validation_auto_recheck_at IS NOT NULL
           ORDER BY cl.asin LOOP
    RAISE NOTICE '  % % | % | queue: % (attempt %, next %) | err % | failure % | warn %',
      r.asin, r.sku, r.validation_status, COALESCE(r.next_stage,'(done)'), r.attempts, COALESCE(r.next_run,'-'),
      r.last_error, r.failure, r.warning;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT validation_status, count(*) AS n
           FROM public.created_listings WHERE user_id = v_uid GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE 'validation_status % : %', r.validation_status, r.n;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'recheck-stale-failed-validations' LOOP
    RAISE NOTICE 'cron #% % (%) active=%', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
END
$p$;
