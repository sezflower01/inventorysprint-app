-- Re-enrich the 2026-09-08 Pending orders through the fixed Orders API path.
--
-- mergeOrderItemsByAsin now sums repeated ASIN lines before they are written,
-- so order 111-8310672-6833058 should come back as 3 units at 23.67 rather
-- than 1 unit at 7.89.
--
-- Scoped to a single date on purpose: this is a verification run, not a
-- backfill. The wider repair is a separate decision once the scope is measured.
--
-- Calls one edge function; writes only through it.

DO $run$
DECLARE
  v_uid uuid;
  v_secret text;
  v_req_id bigint;
  v_anon text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT decrypted_secret INTO v_anon FROM vault.decrypted_secrets
  WHERE name IN ('SERVICE_ROLE_KEY','SUPABASE_SERVICE_ROLE_KEY') LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'INTERNAL_SYNC_SECRET unavailable -- cannot invoke.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret,
      'Authorization', 'Bearer ' || COALESCE(v_anon, v_secret)
    ),
    body := jsonb_build_object(
      'user_id', v_uid,
      'refresh_pending', true,
      'target_date', '2026-09-08'
    ),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RAISE NOTICE 'refresh_pending dispatched for 2026-09-08, request id %', v_req_id;
END
$run$;
