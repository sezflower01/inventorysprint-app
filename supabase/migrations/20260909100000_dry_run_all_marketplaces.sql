-- DRY RUN across all four marketplaces, with per-row signing.
--
-- Shortlist by marketplace: US 312, MX 84, CA 28, BR 12 = 436.
-- Previously every call was signed for US, so BR and MX rows returned
-- unverifiable. This pass should verify them.
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
    -- No marketplace key at all: null means every marketplace.
    body := jsonb_build_object('user_id', v_uid, 'dry_run', true, 'limit', 20),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'all-marketplace dry run dispatched, request id %', v_req_id;
END
$run$;
