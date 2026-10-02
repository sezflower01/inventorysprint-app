-- READ-ONLY PROBE (corrected: cron_run_history has no error_message column).
--
-- The stored admin-page secret is REJECTED by Amazon ("Client authentication
-- failed", 01:10:53), and the env secret in the Supabase dashboard was edited a
-- few minutes earlier. Saving an edge-function secret restarts every function
-- isolate, so a bad value takes effect immediately across the fleet.
--
-- Judge it by work actually completing: a dead secret shows up as silence, not
-- as error rows, because the failure happens inside the token exchange before
-- any assignment-level error is recorded.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== SP-API gate: when was a slot last claimed? ==';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 6 LOOP
    RAISE NOTICE '  % | % | % ago', r.operation, r.last_called_at, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== prices applied, minute by minute (last 30 min) ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '30 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 30 LOOP
    RAISE NOTICE '  % : %', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NOTHING APPLIED IN 30 MIN'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== cron runs in the last 30 minutes (shape only) ==';
  FOR r IN SELECT job_name, status, started_at, finished_at
           FROM public.cron_run_history
           WHERE started_at > now() - interval '30 minutes'
           ORDER BY started_at DESC LIMIT 12 LOOP
    RAISE NOTICE '  % | % | % -> %', r.job_name, r.status, r.started_at, r.finished_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the stored credential row, for the record ==';
  FOR r IN SELECT lwa_client_id_last4, last_test_status, last_test_error, last_test_at, updated_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  client id ...% | test % | % | tested % | saved %',
      r.lwa_client_id_last4, r.last_test_status, COALESCE(r.last_test_error, ''), r.last_test_at, r.updated_at;
  END LOOP;
END
$p$;
