-- Retry the refresh_pending dispatch.
--
-- The previous attempt sent Authorization: Bearer <vault value> where the vault
-- lookup had returned NULL and fallen back to the internal secret, which is not
-- a JWT. The gateway answered UNAUTHORIZED_INVALID_JWT_FORMAT -- a malformed
-- bearer is worse than none, because it is validated and rejected rather than
-- ignored. x-internal-secret alone is what the working calls use.

DO $run$
DECLARE v_uid uuid; v_secret text; v_req_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid,
      'refresh_pending', true,
      'target_date', '2026-09-08'
    ),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'refresh_pending retry dispatched, request id %', v_req_id;
END
$run$;
