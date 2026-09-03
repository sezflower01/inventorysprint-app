-- One real, tiny invocation of backfill-catalog-brands before scheduling it.
--
-- A cron that has never been proven by hand is how this repo has been burned
-- before: pg_cron records SUCCESS for any completed HTTP POST regardless of
-- what the function returned, so a worker that fails every run looks healthy.
-- 60 ASINs is 3 batched calls -- enough to prove auth, the claim RPC, the
-- SP-API call and the upsert, cheap enough to throw away.

DO $$
DECLARE v_req bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-catalog-brands',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object(
      'maxAsins', 60, 'sellers', 6, 'perSeller', 10, 'maxSeconds', 40,
      'triggered_by', 'smoke-test'
    ),
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE 'smoke test request_id = % -- read net._http_response for the body', v_req;
END $$;
