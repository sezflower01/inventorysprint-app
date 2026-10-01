-- DRY RUN, one ASIN. Asks Amazon by ASIN what is live on B09PJPB34P and what
-- the revive sweep WOULD do about it. dry_run = true, so nothing is written;
-- target_asin confines it to a single listings-API request.

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
      'limit', 50,
      'deep_limit', 3,
      'target_asin', 'B09PJPB34P'
    ),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'targeted dry run requested as net request %', v_req;
END
$p$;
