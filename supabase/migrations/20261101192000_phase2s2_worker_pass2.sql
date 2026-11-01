-- PHASE 2 step 2: report the previous worker pass, then fire the next.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_pending int;
        v_status int; v_content text; i int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  FOR i IN 1..45 LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = 1540;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;
  IF v_status IS NULL THEN
    RAISE NOTICE 'prev request has not landed; NOT firing another.';
    RETURN;
  END IF;
  RAISE NOTICE 'prev pass HTTP %: %', v_status, left(COALESCE(v_content,''),420);

  SELECT count(*) INTO v_pending FROM public.inventory_refresh_queue
   WHERE user_id = v_uid AND status = 'pending' AND priority <= 1;
  RAISE NOTICE 'target rows still pending: %', v_pending;
  IF v_pending = 0 THEN
    RAISE NOTICE 'QUEUE DRAINED for the target set.';
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
  RAISE NOTICE 'next worker pass fired -- request %', v_req;
END
$p$;
