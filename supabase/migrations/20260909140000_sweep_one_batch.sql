-- SWEEP, one batch per migration.
--
-- The previous attempt queued seven net.http_post calls inside a single DO
-- block. All seven consumed request ids (61367-61373) and none produced a
-- response row -- the sequence jumped straight to 61374 -- so pg_net never
-- processed them. Every SINGLE dispatch in this session worked (60562, 60595,
-- 60611, 61333), so the loop is the variable, not the mechanism.
--
-- One post per migration from here. Slower, and it actually runs.
--
-- limit 60 is bounded by the worker's wall clock, not by a statement timeout:
-- roughly 400ms per candidate against a 110s internal budget, and the function
-- stops cleanly when it reaches that rather than dying mid-write.

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
      'user_id', v_uid, 'dry_run', false, 'limit', 60, 'offset', 0
    ),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'sweep batch offset=0 dispatched, request id %', v_req_id;
END
$run$;
