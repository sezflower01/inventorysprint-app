-- SWEEP, live. Pages through the 436-row shortlist in batches.
--
-- Every value written is read back from Amazon GetOrderItems for that exact
-- order and marketplace; the shortlist only chooses which orders to ask about.
-- Non-USD orders take the quantity correction and skip the revenue one, because
-- this function has no FX table and the sale needs its own order-date rate.
--
-- Batches are dispatched together rather than one enormous call: the worker has
-- a wall-clock limit regardless of statement timeouts, and a batch that dies
-- mid-sweep leaves an unknown amount done. Each is bounded and reports its own
-- counts.

DO $run$
DECLARE
  v_uid uuid; v_secret text; v_req_id bigint;
  v_offset integer;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  -- Page from the BACK. Repaired rows leave the shortlist, which shifts every
  -- offset after them; sweeping backwards means the shift only ever affects
  -- pages already done.
  FOREACH v_offset IN ARRAY ARRAY[360, 300, 240, 180, 120, 60, 0]
  LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-secret', v_secret
      ),
      body := jsonb_build_object(
        'user_id', v_uid,
        'dry_run', false,
        'limit', 60,
        'offset', v_offset
      ),
      timeout_milliseconds := 150000
    ) INTO v_req_id;
    RAISE NOTICE 'batch offset=%  request id %', v_offset, v_req_id;
  END LOOP;
END
$run$;
