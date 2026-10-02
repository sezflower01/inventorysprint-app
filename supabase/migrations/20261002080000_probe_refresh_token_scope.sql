-- READ-ONLY PROBE (shape only, no token values).
--
-- The error moved from invalid_client to unauthorized_client after the client
-- id was changed to ...f01d in both stores. Those two mean different things:
--   invalid_client      -> the client id + secret PAIR was rejected
--   unauthorized_client -> the client authenticated fine, but THIS refresh
--                          token was not issued to THIS client
--
-- So the pair is now right and the refresh tokens are the mismatch: every one
-- of them was minted under app ...15f6. Count how many places hold one, because
-- that is the true size of a migration to f01d -- it is not one field on one
-- page.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== seller_authorizations (what most functions read) ==';
  FOR r IN SELECT marketplace_id, is_active,
                  (refresh_token IS NOT NULL) AS has_token,
                  right(COALESCE(refresh_token, ''), 4) AS token_tail,
                  COALESCE(seller_id, selling_partner_id) AS seller,
                  updated_at, created_at
           FROM public.seller_authorizations
           WHERE user_id = v_uid ORDER BY marketplace_id LOOP
    RAISE NOTICE '  marketplace % | active % | token % (...%) | seller % | updated %',
      r.marketplace_id, r.is_active, r.has_token, r.token_tail, r.seller, r.updated_at;
  END LOOP;

  SELECT count(*) INTO n FROM public.seller_authorizations WHERE user_id = v_uid;
  RAISE NOTICE '  total rows: %', n;

  RAISE NOTICE '';
  RAISE NOTICE '== do they all share ONE refresh token, or one per marketplace? ==';
  FOR r IN SELECT right(COALESCE(refresh_token, ''), 6) AS tail, count(*) AS n,
                  string_agg(marketplace_id, ', ' ORDER BY marketplace_id) AS markets
           FROM public.seller_authorizations WHERE user_id = v_uid
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  token ending ...% is used by % marketplace(s): %', r.tail, r.n, r.markets;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the admin-page store ==';
  FOR r IN SELECT lwa_client_id_last4, refresh_token_last4, last_test_status,
                  last_test_error, last_test_at, updated_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  client ...% | refresh ...% | test %',
      r.lwa_client_id_last4, r.refresh_token_last4, r.last_test_status;
    RAISE NOTICE '  amazon said: %', left(COALESCE(r.last_test_error, ''), 300);
    RAISE NOTICE '  saved %', r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is anything working yet? ==';
  FOR r IN SELECT count(*) AS n, max(last_applied_at) AS newest
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '15 minutes' LOOP
    RAISE NOTICE '  prices applied in the last 15 min: % (newest %)', r.n, r.newest;
  END LOOP;
END
$p$;
