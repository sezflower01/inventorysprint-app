-- STEP 3 OF THE APPROVED PLAN: backfill DRY RUN, batch 1 of 6.
--
-- repair-collapsed-orders validates every candidate against GetOrderItems and
-- defaults to dry_run. dry_run is NOT passed here, so the default stands --
-- `body.dry_run !== false` means only an explicit false can write, and a
-- missing key cannot.
--
-- PACING. PER_CALL_DELAY_MS is 2100 and TIME_BUDGET_MS is 110_000, so one
-- invocation covers at most ~52 orders. limit 50 fits inside the budget with
-- room for the function to finish cleanly rather than being cut off
-- mid-sweep. 285 candidates therefore need 6 invocations at offsets 0, 50,
-- 100, 150, 200, 250.
--
-- WHY OFFSET PAGING IS SAFE HERE. Dry runs record nothing in
-- collapsed_order_checks, so the candidate list does not shrink between
-- invocations, and its ordering is deterministic (gap DESC, then id). Offset
-- therefore walks the list exactly once with no repeats and no gaps.
--
-- STRICTLY ONE AT A TIME, as instructed: each batch is fired only after the
-- previous batch's response has landed and been read. Nothing else in this
-- session calls Amazon while these run.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_n
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '== candidates to walk: % (6 batches of 50) ==', v_n;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN
    RAISE NOTICE '>>> no INTERNAL_SYNC_SECRET in Vault. Not firing.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
                               'marketplace', NULL,
                               'limit', 50,
                               'offset', 0),
    timeout_milliseconds := 118000
  ) INTO v_req;

  RAISE NOTICE '   batch 1 (offset 0, limit 50) fired at % -- request %',
    clock_timestamp(), v_req;
  RAISE NOTICE '   DRY RUN: dry_run was not passed, so the function default';
  RAISE NOTICE '   (true) applies and no sales_orders row can be written.';
END
$p$;
