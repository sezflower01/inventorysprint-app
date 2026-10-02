-- READ-ONLY PROBE. Final confirmation: are prices being APPLIED again, not just
-- fetched? Competitor fetches resumed at 02:40:58; an apply only follows when a
-- change is actually warranted, so this needs a minute or two of evaluations.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  FOR r IN SELECT max(last_applied_at) AS last_apply,
                  max(last_evaluated_at) AS last_eval,
                  max(last_sp_api_check_at) AS last_check,
                  max(last_dispatch_at) AS last_dispatch
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US' LOOP
    RAISE NOTICE 'apply % | eval % | sp-api check % | dispatch %',
      r.last_apply, r.last_eval, r.last_check, r.last_dispatch;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== evaluations per minute (last 10 min) ==';
  FOR r IN SELECT date_trunc('minute', last_evaluated_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_evaluated_at > now() - interval '10 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % evaluated', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  no evaluations yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== applies per minute (last 10 min) ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '10 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % applied', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  no applies yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== any new failures since the fix? ==';
  FOR r IN SELECT COALESCE(last_error_type, '(none)') AS et, count(*) AS n,
                  max(last_failure_at) AS newest, left(min(last_error_message), 160) AS sample
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_failure_at > now() - interval '20 minutes'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 5 LOOP
    RAISE NOTICE '  % x% | % | %', r.et, r.n, r.newest, r.sample;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;
END
$p$;
