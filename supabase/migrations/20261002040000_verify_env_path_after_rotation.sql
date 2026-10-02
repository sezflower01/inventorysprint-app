-- Fire a real env-path SP-API call, read-only.
--
-- bulk-live-verify is in the ~73 that read LWA_CLIENT_SECRET from the Supabase
-- dashboard, it is internal-callable, and in mode=revive_ghosts with
-- dry_run=true it writes nothing while still doing a full LWA token exchange
-- and an FBA inventory call. So live_skus_seen > 0 in its reply is first-hand
-- proof the env secret works -- not a green tick from the admin page, which
-- only ever exercised the other path.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object(
      'user_id', v_uid,
      'mode', 'revive_ghosts',
      'dry_run', true,
      'limit', 5,
      'deep_limit', 0
    ),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'env-path test fired as net request %', v_req;
END
$p$;
