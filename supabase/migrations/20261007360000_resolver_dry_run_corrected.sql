-- Second dry run, after fixing the refund filter and the items-call pacing.
-- Still apply:false. Writes nothing.
DO $p$
DECLARE v_secret text; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 20),
    timeout_milliseconds := 280000
  ) INTO v_req;
  RAISE NOTICE 'corrected dry run dispatched, request %', v_req;
END
$p$;
