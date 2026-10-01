-- APPLY, one ASIN. Amazon's listings API reports B09PJPB34P live under the SKU
-- we already hold (FSG-IM9-UBG1), status DISCOVERABLE/BUYABLE, so the stored
-- NOT_IN_CATALOG + ghost stamp from 2026-05-20 is simply stale -- and it is
-- what hides the listing from the repricer (AssignmentsTable drops
-- NOT_IN_CATALOG rows outright).
--
-- dry_run = false here, scoped to this one ASIN. The quantity is left alone:
-- fulfillmentAvailability reported 0, which for an FBA listing means the
-- endpoint has nothing to say rather than that the stock is gone.

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

  RAISE NOTICE 'apply requested as net request %', v_req;
END
$p$;
