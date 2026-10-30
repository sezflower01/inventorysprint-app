-- JULY, stage 2: pre-flight + fresh dry run. apply := false.
--
-- Same sequence as May and June. The gate constant -246.44 is carried in prose
-- by the instruction, so every stored July report is printed here: a gate value
-- that cannot be traced to a stored report is not evidence, and on February a
-- clean run was stopped on a hit count read off a STALE report.
--
-- The 'before' fingerprints are captured now, through
-- fec_snapshot_fingerprints, which snapshots whichever non-adjustment types
-- exist rather than a fixed list. July may well have a different type set from
-- June's three -- that is precisely what the set comparison is for.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0;
        v_fired timestamptz; v_types int;
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
  RAISE NOTICE '== 4. the recorded July figure, from stored reports ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items_via_catchall' AS catchall,
           rr.report->>'api_items'          AS items,
           rr.report->>'pages'              AS pages
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-07'
    ORDER BY rr.captured_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | applied % | claw % | hits % | catch-all % | items % | pages %',
      r.t, r.applied, lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.hits,'-'),3),
      lpad(COALESCE(r.catchall,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),4);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO stored July report -- the -246.44 gate value is UNSOURCED';
    v_blockers := v_blockers + 1;
  END IF;

  SELECT count(DISTINCT rr.report->>'api_clawback_total') INTO v_n
  FROM public.repull_reports rr
  WHERE left(rr.month,7)='2026-07' AND rr.report ? 'api_signed_total';
  RAISE NOTICE '   distinct clawback totals across all stored July runs: % (1 = stable)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. July as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-07-01' AND event_date < '2026-08-01';
  RAISE NOTICE '   live rows (all types): %', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-07-01' AND event_date < '2026-08-01';
  RAISE NOTICE '   of which adjustments: %', v_n;
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-07-01';
  RAISE NOTICE '   existing backup rows: %  (0 = still to be taken)', v_n;

  v_types := public.fec_snapshot_fingerprints(v_uid, '2026-07-01'::date, 'before');
  RAISE NOTICE '   fingerprints BEFORE, % non-adjustment types captured:', v_types;
  FOR r IN
    SELECT event_type, rows, fingerprint FROM public.fec_fingerprint_snapshot
    WHERE snap_month='2026-07-01' AND phase='before' ORDER BY event_type
  LOOP
    RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint;
  END LOOP;

  IF v_blockers > 0 THEN
    RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers;
  END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-07-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired JULY DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
