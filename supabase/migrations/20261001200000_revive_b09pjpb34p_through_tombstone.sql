-- APPLY again on B09PJPB34P, now that the revive lifts the tombstone the way
-- the DB guard requires (source = 'force_relist' on the status write).
--
-- The previous apply looked successful and was not: fn_protect_ghost_tombstone
-- reverted listing_status to NOT_IN_CATALOG in a BEFORE UPDATE while saving the
-- rest of the same statement, so ghosted_at cleared and the status did not.

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
      'dry_run', false,
      'limit', 50,
      'deep_limit', 3,
      'target_asin', 'B09PJPB34P'
    ),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'apply-through-tombstone requested as net request %', v_req;
END
$p$;
