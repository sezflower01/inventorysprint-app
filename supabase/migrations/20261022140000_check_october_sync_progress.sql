-- Is the October resync progressing, or did it fail? October is currently
-- empty, so this decides whether to wait or restore from backup.
DO $p$
DECLARE r record; v_status int; v_content text; v_err text; v_live bigint; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, left(COALESCE(content,''),500), left(COALESCE(error_msg,''),300)
    INTO v_status, v_content, v_err
  FROM net._http_response WHERE id = 21108;
  RAISE NOTICE '== resync HTTP % ==', COALESCE(v_status::text,'pending');
  IF COALESCE(v_err,'') <> '' THEN RAISE NOTICE '   error: %', v_err; END IF;
  IF v_content IS NOT NULL THEN RAISE NOTICE '   body: %', v_content; END IF;

  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date <= '2026-10-31';
  RAISE NOTICE '';
  RAISE NOTICE '== October rows now: % (backup holds 3086) ==', v_live;

  RAISE NOTICE '';
  RAISE NOTICE '== pl_sync_progress, latest 3 ==';
  FOR r IN
    SELECT status, COALESCE(message,'-') AS msg, created_at, updated_at
    FROM public.pl_sync_progress WHERE user_id = v_uid
    ORDER BY updated_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '   % | % | created % | updated %',
      rpad(r.status,10), left(r.msg,70), r.created_at, r.updated_at;
  END LOOP;
END
$p$;
