-- ITEM 3: re-pull 2026-01, one month, alone.
--
-- endDate is '2026-02-01', the FIRST OF THE NEXT MONTH. Passing '2026-01-31'
-- would be read as midnight and silently exclude Jan 31 while the DELETE
-- removed it -- the exact mistake that cost 41 October rows an hour ago.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_backup bigint; v_live bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  v_backup := public.fec_backup_month(v_uid, '2026-01-01');
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01';

  RAISE NOTICE '== January backup % rows | live % rows ==', v_backup, v_live;
  IF v_backup = 0 OR v_backup <> v_live THEN
    RAISE EXCEPTION 'ABORT: backup % vs live % -- refusing to delete', v_backup, v_live;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== January BEFORE, by event_type ==';
  FOR r IN
    SELECT event_type, count(*) AS rows FROM public.fec_repull_backup
    WHERE user_id=v_uid AND backup_month='2026-01-01' GROUP BY 1 ORDER BY rows DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.event_type,14), r.rows; END LOOP;

  DELETE FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01';
  RAISE NOTICE '   January cleared';

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'startDate','2026-01-01',
                               'endDate','2026-02-01', 'forceRefresh', true),
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE '== resync 2026-01-01 .. 2026-02-01 triggered, request % ==', v_req;
END
$p$;
