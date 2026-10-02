-- READ-ONLY PROBE. Final recovery check after the switch back to app 15f6.
-- The question is only whether prices are being APPLIED again; credentials were
-- already verified accepted on all five slots.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== applies per minute (last 15 min) ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '15 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % : % applied', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  none yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== evaluations per minute (last 15 min) ==';
  FOR r IN SELECT date_trunc('minute', last_evaluated_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_evaluated_at > now() - interval '15 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % : % evaluated', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  none yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== SP-API gate and snapshots ==';
  FOR r IN SELECT operation, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 4 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  FOR r IN SELECT count(*) AS n, max(created_at) AS newest
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND created_at > now() - interval '15 minutes' LOOP
    RAISE NOTICE '  competitor snapshots in 15 min: % (newest %)', r.n, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== failures since the switch ==';
  FOR r IN SELECT COALESCE(last_error_type, '(none)') AS et, count(*) AS n,
                  max(last_failure_at) AS newest, left(min(last_error_message), 160) AS sample
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_failure_at > now() - interval '30 minutes'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 5 LOOP
    RAISE NOTICE '  % x% | % | %', r.et, r.n, r.newest, r.sample;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;
END
$p$;
