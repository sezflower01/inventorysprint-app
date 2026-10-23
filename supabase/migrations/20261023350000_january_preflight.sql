-- ITEM 1 pre-flight. Do NOT fire the apply if the pg_net queue is busy or a
-- sync is mid-flight: a contended queue is what left January blank for minutes
-- last time, and a concurrent fetch-profit-loss run could upsert adjustment
-- rows underneath the re-pull's transaction.
DO $p$
DECLARE v_uid uuid; r record; v_q bigint; v_running bigint; v_backup bigint; v_live bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_q FROM net.http_request_queue;
  RAISE NOTICE '== pg_net queue depth: % ==', v_q;
  IF v_q > 0 THEN
    FOR r IN SELECT id, left(url,66) AS url FROM net.http_request_queue ORDER BY id LIMIT 8
    LOOP RAISE NOTICE '   waiting: % | %', r.id, r.url; END LOOP;
  END IF;

  SELECT count(*) INTO v_running FROM public.pl_sync_progress
  WHERE user_id = v_uid AND status IN ('running','continue');
  RAISE NOTICE '== pl_sync_progress rows running/continue: % ==', v_running;
  FOR r IN
    SELECT status, COALESCE(message,'-') AS msg, updated_at FROM public.pl_sync_progress
    WHERE user_id=v_uid ORDER BY updated_at DESC LIMIT 2
  LOOP RAISE NOTICE '   % | % | %', rpad(r.status,10), left(r.msg,50), r.updated_at; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cron jobs due in the next 2 minutes ==';
  FOR r IN
    SELECT jobname, schedule FROM cron.job
    WHERE active AND (schedule LIKE '%* * * *%' OR schedule LIKE '*/1 %' OR schedule LIKE '*/2 %')
    ORDER BY jobname LIMIT 8
  LOOP RAISE NOTICE '   % | %', rpad(r.jobname,42), r.schedule; END LOOP;

  RAISE NOTICE '';
  v_backup := public.fec_backup_month(v_uid, '2026-01-01');
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01';
  RAISE NOTICE '== January backup % rows | live % rows ==', v_backup, v_live;
  IF v_backup <> v_live THEN
    RAISE NOTICE '   >>> MISMATCH -- do not apply';
  ELSE
    RAISE NOTICE '   backup verified';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE fingerprint of non-adjustment rows ==';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-01-01') ORDER BY event_type
  LOOP RAISE NOTICE '   % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: January adjustment money, all non-zero columns ==';
  FOR r IN
    SELECT 'reimbursements' AS c, round(sum(COALESCE(reimbursements,0)),2) AS v FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'warehouse_lost', round(sum(COALESCE(warehouse_lost,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'warehouse_damage', round(sum(COALESCE(warehouse_damage,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'reversal_reimbursement', round(sum(COALESCE(reversal_reimbursement,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'free_replacement', round(sum(COALESCE(free_replacement_refund_items,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'compensated_clawback', round(sum(COALESCE(compensated_clawback,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    UNION ALL SELECT 'fbm_shipping_label_fee', round(sum(COALESCE(fbm_shipping_label_fee,0)),2) FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01'
  LOOP RAISE NOTICE '   % | %', rpad(r.c,26), r.v; END LOOP;
END
$p$;
