-- STEP 4 verification: trigger the worker once and prove cron_run_history fills.
-- Job 170 has run hourly since creation with ZERO rows in cron_run_history,
-- so "is it working" could only be inferred. withCronLock gives it a record.
DO $p$
DECLARE v_secret text; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-order-status-updates',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('lookbackHours', 26),
    timeout_milliseconds := 280000
  ) INTO v_req;
  RAISE NOTICE 'triggered sync-order-status-updates, request %', v_req;
END
$p$;
