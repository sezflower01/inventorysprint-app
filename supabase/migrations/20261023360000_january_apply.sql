-- January, apply:true. Pre-flight passed: pg_net queue depth 0, no
-- pl_sync_progress running, backup verified 5510 = 5510.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_q bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT count(*) INTO v_q FROM net.http_request_queue;
  IF v_q > 3 THEN
    RAISE EXCEPTION 'ABORT: pg_net queue depth % -- not firing into a busy queue', v_q;
  END IF;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'month','2026-01-01', 'apply', true),
    timeout_milliseconds := 115000
  ) INTO v_req;
  RAISE NOTICE '== January APPLY fired (queue was %) -> request % ==', v_q, v_req;
END
$p$;
