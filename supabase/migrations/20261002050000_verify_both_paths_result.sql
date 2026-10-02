-- READ-ONLY PROBE. Verdict on both credential paths, from actual results.
--
--   ENV path (~73 functions): the reply to net request 179747. bulk-live-verify
--   reports live_skus_seen, which it can only know by exchanging an LWA token
--   and calling Amazon. A non-zero count is proof; an error body names the
--   failure.
--
--   DB path (17 functions): repricer-sp-api-pricing resolves credentials
--   through the shared helper, stored-credentials-first, and runs every minute.
--   Apply counts resuming after 01:09 is proof that path works -- stronger than
--   the admin page's own test, which is the same code answering about itself.

DO $p$
DECLARE v_uid uuid; r record; v_body jsonb; v_status int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '=== ENV PATH: bulk-live-verify (reads LWA_CLIENT_SECRET) ===';
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 179747;
  IF v_status IS NULL THEN
    RAISE NOTICE '  no reply yet';
  ELSE
    RAISE NOTICE '  http %', v_status;
    RAISE NOTICE '  live SKUs seen from Amazon: %', COALESCE(v_body->>'live_skus_seen', '(none)');
    IF v_body ? 'error' THEN RAISE NOTICE '  ERROR: %', left(v_body->>'error', 300); END IF;
    IF COALESCE((v_body->>'live_skus_seen')::int, 0) > 0 THEN
      RAISE NOTICE '  VERDICT: env secret WORKS';
    ELSE
      RAISE NOTICE '  VERDICT: env path did NOT return live data';
    END IF;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '=== DB PATH: the repricer (stored credentials first) ===';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '20 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 20 LOOP
    RAISE NOTICE '  % : % applied', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NOTHING applied in 20 minutes — still down'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== SP-API gate (any call at all reaching Amazon) ==';
  FOR r IN SELECT operation, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 4 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the admin page test, for completeness ==';
  FOR r IN SELECT lwa_client_id_last4, last_test_status, last_test_error,
                  last_test_seller_id, last_test_at, updated_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  client ...% | % | % | seller % | tested % | saved %',
      r.lwa_client_id_last4, r.last_test_status, COALESCE(r.last_test_error, ''),
      COALESCE(r.last_test_seller_id, '(none)'), r.last_test_at, r.updated_at;
  END LOOP;
END
$p$;
