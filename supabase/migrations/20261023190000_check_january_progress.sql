DO $p$
DECLARE v_uid uuid; r record; v_live bigint; v_status int; v_body text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01';
  SELECT status_code, left(COALESCE(content,''),250) INTO v_status, v_body
  FROM net._http_response WHERE id = 37601;
  RAISE NOTICE '== request 37601: HTTP % | % ==', COALESCE(v_status::text,'pending'), COALESCE(v_body,'-');
  RAISE NOTICE '== January live rows: % (backup 5510) ==', v_live;
  RAISE NOTICE '';
  FOR r IN
    SELECT status, COALESCE(message,'-') AS msg, updated_at
    FROM public.pl_sync_progress WHERE user_id=v_uid ORDER BY updated_at DESC LIMIT 3
  LOOP RAISE NOTICE '   % | % | %', rpad(r.status,10), left(r.msg,60), r.updated_at; END LOOP;
END
$p$;
