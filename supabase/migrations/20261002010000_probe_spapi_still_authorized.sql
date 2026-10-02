-- READ-ONLY PROBE (corrected columns; the first version named lwa_client_id,
-- but the table stores lwa_client_id_enc / lwa_client_secret_enc with only
-- *_last4 in clear, which is the whole point of the pgsodium design).
--
-- The seller rotated the LWA client secret just now. Amazon's own doc says
-- "Your old credentials expire seven days after you generate new credentials",
-- so the stored secret should still be accepted today. Confirm SP-API is still
-- working, and confirm the admin page really has a stored credential row --
-- because if it does not, the 17 DB-first functions are silently on the env
-- secret too, and updating the page alone would change nothing at all.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== SP-API gate activity (proof calls are still being made) ==';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 10 LOOP
    RAISE NOTICE '  % | % (% ago)', r.operation, r.last_called_at, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== stored credential row (shape and last4 only — never values) ==';
  FOR r IN SELECT region, marketplace,
                  (lwa_client_id_enc IS NOT NULL) AS has_client_id,
                  (lwa_client_secret_enc IS NOT NULL) AS has_secret,
                  (refresh_token_enc IS NOT NULL) AS has_refresh,
                  lwa_client_id_last4, refresh_token_last4,
                  last_test_status, last_test_at, updated_at
           FROM public.user_spapi_credentials WHERE user_id = v_uid LOOP
    RAISE NOTICE '  % / % | client_id % (…%) | secret % | refresh % (…%)',
      r.region, r.marketplace, r.has_client_id, r.lwa_client_id_last4,
      r.has_secret, r.has_refresh, r.refresh_token_last4;
    RAISE NOTICE '      last test % at % | row updated %', r.last_test_status, r.last_test_at, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '  (NO row — the admin page has nothing stored, so even the 17 DB-first';
    RAISE NOTICE '   functions are falling back to the env secret)';
  END IF;
END
$p$;
