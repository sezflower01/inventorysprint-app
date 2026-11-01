-- PHASE 2 step 2: drain the queue through the worker. One invocation.
--
-- batch_size 30 is the worker's own default and its pacing is internal. Each
-- queue row becomes one rescue-inventory-asin call, which reads Amazon's FBA
-- Inventory Summaries and writes only what that response contains.
--
-- Nothing else in this session calls Amazon while this runs.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_pending int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_pending FROM public.inventory_refresh_queue
   WHERE user_id = v_uid AND status = 'pending' AND priority <= 1;
  RAISE NOTICE '== target rows still pending: % ==', v_pending;
  IF v_pending = 0 THEN
    RAISE NOTICE '   nothing left. Not firing.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/inventory-refresh-worker',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('batch_size', 30),
    timeout_milliseconds := 118000
  ) INTO v_req;
  RAISE NOTICE '   worker fired at % -- request %', clock_timestamp(), v_req;
END
$p$;
