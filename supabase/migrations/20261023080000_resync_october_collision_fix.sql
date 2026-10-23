-- ITEM 2: Clear Cache & Resync October with the _adjEvtIdx fix deployed.
--
-- Backup already taken this session (3,286 rows under backup_month 2026-10-01)
-- and fec_backup_month refuses to overwrite it, so the pristine copy stands.
--
-- The DELETE covers the whole month unconditionally. That matters: the NORMAL
-- sync deletes with .lt(monthEnd), which leaves the last day behind, and with
-- the key generation now changed those surviving rows would sit alongside
-- new-key rows as duplicates. Clear Cache is the only safe path for a key
-- change.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_backup bigint; v_live bigint; v_end text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_backup FROM public.fec_repull_backup
  WHERE user_id = v_uid AND backup_month = '2026-10-01';
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date < '2026-11-01';

  RAISE NOTICE '== backup % rows | live % rows ==', v_backup, v_live;
  IF v_backup = 0 OR v_backup <> v_live THEN
    RAISE EXCEPTION 'ABORT: backup % vs live % -- refusing to delete', v_backup, v_live;
  END IF;

  DELETE FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date < '2026-11-01';
  RAISE NOTICE '   October cleared';

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  v_end := to_char((now() AT TIME ZONE 'UTC') - interval '5 minutes', 'YYYY-MM-DD');

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'startDate','2026-10-01',
                               'endDate', v_end, 'forceRefresh', true),
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE '== resync 2026-10-01 .. % triggered, request % ==', v_end, v_req;
END
$p$;
