-- Batch 2. newestFirst keeps the cancelled-heavy end first: a cancelled order
-- skips the getOrderItems call entirely, so those batches cost 250ms per order
-- instead of 2.35s and clear the bulk of the cohort quickly.
DO $p$
DECLARE v_secret text; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 60, 'apply', true, 'newestFirst', true),
    timeout_milliseconds := 280000
  ) INTO v_req;
  RAISE NOTICE 'batch 6 dispatched, request %', v_req;
END
$p$;
