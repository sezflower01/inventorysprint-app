DO $p$
DECLARE v_uid uuid; r record; v_live bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-10-01' AND event_date < '2026-11-01';
  RAISE NOTICE '== October live rows: % ==', v_live;
  RAISE NOTICE '== pl_sync_progress latest 3 ==';
  FOR r IN
    SELECT status, COALESCE(message,'-') AS msg, created_at, updated_at
    FROM public.pl_sync_progress WHERE user_id=v_uid ORDER BY updated_at DESC LIMIT 3
  LOOP RAISE NOTICE '   % | % | upd %', rpad(r.status,10), left(r.msg,64), r.updated_at; END LOOP;
END
$p$;
