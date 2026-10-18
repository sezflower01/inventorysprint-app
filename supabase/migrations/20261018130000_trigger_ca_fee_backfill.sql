-- (2) Trigger the CA fee fetch for B07KY25WY7.
--
-- backfill-fee-cache is the TRUSTED fee writer: its own header says it "sends
-- NATIVE currency, converts response back to USD before returning", which is
-- the contract the two broken writers skipped on 2026-10-14. It selects its
-- own targets from sales_orders where fees_missing = true OR fees_source is
-- null/unavailable, and this order carries fees_source = 'unavailable' and
-- fees_missing = true, so it qualifies without being named explicitly.
--
-- Invoked through net.http_post reading INTERNAL_SYNC_SECRET straight from the
-- vault, exactly as pg_cron does it. That keeps the secret inside the database
-- -- it is never read out, printed, or passed through a shell. The function is
-- verify_jwt = false, so x-internal-secret alone is the right credential and
-- no Authorization bearer is needed (the opposite case -- a target that keeps
-- verify_jwt = true -- would need BOTH).
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE '== INTERNAL_SYNC_SECRET not found in vault -- cannot invoke ==';
    RETURN;
  END IF;
  RAISE NOTICE '== secret found in vault (value not printed) ==';

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-fee-cache',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid::text,
      'max_asins', 5
    ),
    timeout_milliseconds := 55000
  ) INTO v_req;

  RAISE NOTICE '== backfill-fee-cache invoked, pg_net request id % ==', v_req;
  RAISE NOTICE '   The response lands in net._http_response asynchronously;';
  RAISE NOTICE '   a follow-up probe reads it rather than guessing.';
END
$p$;
