-- Read the current state, and fire a fresh env-path SP-API call in the same
-- pass so its verdict is ready on the next read.
--
-- What each signal means:
--   repricer apply counts  -> the DB path (stored credentials first), which is
--                             what actually matters commercially;
--   SP-API gate claims     -> any call at all reaching Amazon;
--   user_spapi_credentials -> whether a NEW save has happened since the failed
--                             one at 01:41:51, and what Amazon said about it.

DO $p$
DECLARE v_uid uuid; r record; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== repricer: prices applied per minute (last 20 min) ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '20 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 20 LOOP
    RAISE NOTICE '  % : %', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  nothing applied in 20 minutes — still down'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== SP-API gate ==';
  FOR r IN SELECT operation, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 4 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== stored credential row ==';
  FOR r IN SELECT lwa_client_id_last4, last_test_status, last_test_error,
                  last_test_seller_id, last_test_at, updated_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  client ...% | test % | %', r.lwa_client_id_last4, r.last_test_status, COALESCE(r.last_test_error, '');
    RAISE NOTICE '  seller seen % | tested % | saved %',
      COALESCE(r.last_test_seller_id, '(none)'), r.last_test_at, r.updated_at;
  END LOOP;

  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object('user_id', v_uid, 'mode', 'revive_ghosts',
                               'dry_run', true, 'limit', 5, 'deep_limit', 0),
    timeout_milliseconds := 180000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE 'env-path test fired as net request % (read it next)', v_req;
END
$p$;
