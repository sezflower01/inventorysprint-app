-- JUNE, stage 2: pre-flight + fresh dry run. apply := false.
--
-- Same sequence as May (20261029140000). Two additions, both because of what
-- May cost:
--
--   1. Every stored June report is printed with its clawback figure. The gate
--      value -209.69 has been carried in prose, and on February I stopped a
--      clean run on a rate-limit count read off a STALE report. A gate constant
--      that cannot be traced to a stored report is not evidence.
--
--   2. The fired_at timestamp is printed to microseconds, for
--      repull_find_fresh_report -- which exists because the May fire returned a
--      request id, persisted nothing, and the gate then green-lit the previous
--      day's report. NULL from that function means STOP, never "nothing to
--      check".
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0; v_fired timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== 1. cron failure clusters, last 24h ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS t, count(*) AS n,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS held_s,
           left(COALESCE(max(d.return_message),'-'),44) AS msg
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1
  LOOP
    RAISE NOTICE '   CLUSTER % | % jobs | held % s | %', r.t, r.n, r.held_s, r.msg;
    v_blockers := v_blockers + 1;
  END LOOP;
  IF v_blockers = 0 THEN RAISE NOTICE '   CLEAR -- no minute in 24h had 3+ jobs fail together'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. pg_net ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  RAISE NOTICE '   repull calls queued: %', v_n;
  IF v_n > 0 THEN RAISE EXCEPTION 'a repull is already in flight -- one month at a time'; END IF;
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
  RAISE NOTICE '== 4. the recorded June figure, from stored reports ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items_via_catchall' AS catchall,
           rr.report->>'api_items'          AS items
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-06'
    ORDER BY rr.captured_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | applied % | clawbacks % | hits % | catch-all % | items %',
      r.t, r.applied, lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.hits,'-'),3),
      lpad(COALESCE(r.catchall,'-'),3), lpad(COALESCE(r.items,'-'),4);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO stored June report at all -- the -209.69 gate value is unsourced';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. June as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-06-01' AND event_date < '2026-07-01';
  RAISE NOTICE '   live rows (all types): %', v_n;
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-06-01';
  RAISE NOTICE '   existing backup rows: %  (0 = still to be taken)', v_n;
  RAISE NOTICE '   fingerprints BEFORE:';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-06-01') ORDER BY event_type
  LOOP RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  IF v_blockers > 0 THEN
    RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers;
  END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-06-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
