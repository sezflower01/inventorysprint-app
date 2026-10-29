-- MAY: pre-flight + fresh dry run. apply := false. fired_at recorded so the
-- gate can refuse anything older.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0; v_fired timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== 1. cron failure clusters, last 24h ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS t, count(*) AS n,
           left(COALESCE(max(d.return_message),'-'),44) AS msg
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 3
  LOOP RAISE NOTICE '   CLUSTER % | % jobs | %', r.t, r.n, r.msg; v_blockers := v_blockers + 1; END LOOP;
  IF v_blockers = 0 THEN RAISE NOTICE '   CLEAR'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. pg_net ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  RAISE NOTICE '   repull calls queued: %', v_n;
  IF v_n > 0 THEN RAISE EXCEPTION 'a repull is already in flight'; END IF;
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   total queue depth: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. sync in progress? ==';
  SELECT count(*) INTO v_n FROM public.pl_sync_progress
  WHERE lower(COALESCE(status,'')) NOT IN ('completed','error','failed')
    AND created_at > now() - interval '2 hours';
  RAISE NOTICE '   in-flight P&L syncs: %', v_n;
  IF v_n > 0 THEN v_blockers := v_blockers + 1; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. May as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-05-01' AND event_date < '2026-06-01';
  RAISE NOTICE '   live rows (all types): %', v_n;
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-05-01';
  RAISE NOTICE '   existing backup rows: %', v_n;
  RAISE NOTICE '   fingerprints BEFORE:';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-05-01') ORDER BY event_type
  LOOP RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  IF v_blockers > 0 THEN
    RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers;
  END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-05-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
  RAISE NOTICE '   gate with: repull_find_fresh_report(''2026-05-01'', ''%'')', v_fired;
END
$p$;
