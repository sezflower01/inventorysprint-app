-- Sweep batch 2.
--
-- Batch 1 took the shortlist 436 -> 354. Note that is NOT a count of repairs:
-- the shortlist is self-referential, because the per-ASIN median per-unit fee
-- is computed from the same rows being corrected. Repairing one row shifts its
-- ASIN's median, which can drop sibling rows off the list without touching
-- them. Real repair counts come from the function's own response.

DO $run$
DECLARE v_uid uuid; v_secret text; v_req_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid, 'dry_run', false, 'limit', 60, 'offset', 0),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'sweep batch 2 dispatched, request id %', v_req_id;
END
$run$;
