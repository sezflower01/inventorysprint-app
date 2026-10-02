-- READ-ONLY PROBE. "Test connection" on the admin page now reports
-- "Client authentication failed" after saving the rotated secret. The test
-- writes its verdict and Amazon's own error text into user_spapi_credentials,
-- so read that rather than guessing which of the possible causes it is:
--   a mistyped/truncated secret, the dialog placeholder saved literally, the
--   secret pasted into the wrong field, or a secret belonging to a different
--   app than the stored client id (...15f6).
--
-- Values stay encrypted; only *_last4 and the error text are readable, which is
-- exactly what is needed to tell these apart.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT region, marketplace,
                  lwa_client_id_last4, refresh_token_last4,
                  (lwa_client_secret_enc IS NOT NULL) AS has_secret,
                  last_test_status, last_test_error, last_test_seller_id,
                  last_test_marketplaces, last_test_at, updated_at, created_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE 'client id ends ... % | refresh ends ... % | secret stored %',
      r.lwa_client_id_last4, r.refresh_token_last4, r.has_secret;
    RAISE NOTICE 'row updated % (created %)', r.updated_at, r.created_at;
    RAISE NOTICE 'last test: % at %', r.last_test_status, r.last_test_at;
    RAISE NOTICE 'amazon said: %', COALESCE(r.last_test_error, '(no error text recorded)');
    RAISE NOTICE 'seller id seen: % | marketplaces: %',
      COALESCE(r.last_test_seller_id, '(none)'), COALESCE(r.last_test_marketplaces::text, '(none)');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '(no credential row)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== meanwhile, is the ENV path still working? ==';
  RAISE NOTICE '   (the repricer uses the shared helper, which tries stored creds FIRST)';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 5 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  FOR r IN SELECT count(*) AS n, max(last_applied_at) AS newest
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '10 minutes' LOOP
    RAISE NOTICE '  prices applied in the last 10 min: % (newest %)', r.n, r.newest;
  END LOOP;

  FOR r IN SELECT COALESCE(last_error_type, '(none)') AS et, count(*) AS n,
                  max(last_failure_at) AS newest, left(min(last_error_message), 200) AS sample
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_failure_at > now() - interval '30 minutes'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 5 LOOP
    RAISE NOTICE '  failures: % x% | newest % | %', r.et, r.n, r.newest, r.sample;
  END LOOP;
END
$p$;
