-- READ-ONLY PROBE. The audit verdict plus the live indicators, together.
--
-- "Connected" on the admin page is the stored pair answering about itself. The
-- audit says which app EVERY credential slot is on and which pairings Amazon
-- accepts, and the apply counts say whether the repricer is actually working
-- again. All three, so the answer does not rest on the green tick that already
-- misled us once tonight.

DO $p$
DECLARE v_uid uuid; r record; v_body jsonb; v_status int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 180379;

  RAISE NOTICE '';
  RAISE NOTICE '=== CREDENTIAL AUDIT (http %) ===', COALESCE(v_status::text, 'pending');
  IF v_body IS NOT NULL THEN
    RAISE NOTICE '-- env slots --';
    FOR r IN SELECT key, value FROM jsonb_each(COALESCE(v_body->'slots', '{}'::jsonb)) ORDER BY key LOOP
      RAISE NOTICE '  % : %', r.key, r.value;
    END LOOP;

    RAISE NOTICE '-- stored admin row --';
    RAISE NOTICE '  %', COALESCE(v_body->'stored', 'null'::jsonb);

    RAISE NOTICE '-- which pairings does Amazon accept? --';
    FOR r IN SELECT e->>'pair' AS pair, e->>'result' AS result
             FROM jsonb_array_elements(COALESCE(v_body->'pairs', '[]'::jsonb)) e LOOP
      RAISE NOTICE '  % -> %', r.pair, r.result;
    END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '=== LIVE: repricer applies per minute (last 15 min) ===';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '15 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % : %', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  nothing applied in 15 minutes'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '=== LIVE: SP-API gate ===';
  FOR r IN SELECT operation, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 4 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== the admin page verdict, for completeness ===';
  FOR r IN SELECT lwa_client_id_last4, refresh_token_last4, last_test_status,
                  COALESCE(last_test_error, '') AS err, last_test_seller_id, last_test_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  client ...% | refresh ...% | % | seller % | %',
      r.lwa_client_id_last4, r.refresh_token_last4, r.last_test_status,
      COALESCE(r.last_test_seller_id, '(none)'), r.last_test_at;
    IF r.err <> '' THEN RAISE NOTICE '  error: %', left(r.err, 200); END IF;
  END LOOP;
END
$p$;
