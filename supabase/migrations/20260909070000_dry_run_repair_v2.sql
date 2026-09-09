-- DRY RUN, second pass -- with the currency gate in place.
--
-- The first pass proposed writing raw BRL into a USD revenue column on four
-- Brazilian orders (ratios 5.17, 5.19, 5.17, 5.18 -- the BRL/USD rate, with no
-- quantity change on any of them). Those should now report as
-- revenue_skipped_non_usd rather than as repairs, while their quantity
-- corrections still apply.
--
-- Writes nothing.

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
      'user_id', v_uid, 'marketplace', 'US', 'dry_run', true, 'limit', 12
    ),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'dry run v2 dispatched, request id %', v_req_id;
END
$run$;
