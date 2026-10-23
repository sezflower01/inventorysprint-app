-- ITEM 4: DRY RUN on January. apply is omitted, so the function defaults to
-- reporting only and writes nothing.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'month','2026-01-01'),
    timeout_milliseconds := 115000
  ) INTO v_req;
  RAISE NOTICE '== January DRY RUN -> request % ==', v_req;
END
$p$;
