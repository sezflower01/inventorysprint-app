-- Does Amazon still give ItemPrice on the NEWEST orders in the cohort?
-- The oldest (2024-2025) came back with items but no price, which looks like
-- Amazon's data-retention restriction rather than a bug in the call. If the
-- newest ones DO carry a price, the boundary tells us how much of the cohort
-- is recoverable at all. apply:false.
DO $p$
DECLARE v_secret text; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 8, 'newestFirst', true),
    timeout_milliseconds := 280000
  ) INTO v_req;
  RAISE NOTICE 'newest-first probe dispatched, request %', v_req;
END
$p$;
