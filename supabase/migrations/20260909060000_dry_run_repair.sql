-- DRY RUN. Checks candidates against Amazon GetOrderItems and reports what it
-- WOULD change. Writes nothing -- dry_run defaults to true in the function and
-- is passed explicitly here so the intent is on the record.
--
-- Includes 111-8310672-6833058 so the known-good case is in the sample: Amazon
-- should report 3 units at 23.67 against the stored 1 at 7.89.

DO $run$
DECLARE v_uid uuid; v_secret text; v_req_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid,
      'marketplace', 'US',
      'dry_run', true,
      'limit', 12
    ),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'dry run dispatched, request id %', v_req_id;
END
$run$;
