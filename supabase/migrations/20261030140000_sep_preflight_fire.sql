-- SEPTEMBER, stage 2: pre-flight + fresh dry run. apply := false.
--
-- Last closed month of the re-pull before the Feb/Mar/Apr decision.
--
-- Same sequence as August. The pre-September snapshot matters more each month:
-- pl_baseline_20261030 now predates BOTH July's and August's applies, so a
-- comparison against it alone would show three months' moved cells at once and
-- none of them would be attributable. The labelled snapshot isolates September;
-- the baseline stays as the cumulative anchor.
--
-- September has one stored run (10-24, 0 hits), so -213.20 rests on a single
-- observation until this fire agrees with it -- the same position August was in.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0;
        v_fired timestamptz; v_types int; v_sales numeric;
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
  RAISE NOTICE '== 4. the recorded September figure, from stored reports ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items_via_catchall' AS catchall,
           rr.report->>'api_items'          AS items,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-09'
    ORDER BY rr.captured_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | applied % | claw % | hits % | catch-all % | items % | pages % | signed %',
      r.t, r.applied, lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.hits,'-'),3),
      lpad(COALESCE(r.catchall,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),4), lpad(COALESCE(r.signed,'-'),9);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO stored September report -- the -213.20 gate value is UNSOURCED';
    v_blockers := v_blockers + 1;
  END IF;

  SELECT count(*) INTO v_n FROM public.repull_reports rr
  WHERE left(rr.month,7)='2026-09' AND rr.report ? 'api_signed_total';
  RAISE NOTICE '   stored September runs: % -- this fire makes %', v_n, v_n + 1;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. September as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-09-01' AND event_date < '2026-10-01';
  RAISE NOTICE '   live rows (all types): %', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-09-01' AND event_date < '2026-10-01';
  RAISE NOTICE '   of which adjustments: %', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment' AND COALESCE(asin,'') = ''
    AND event_date >= '2026-09-01' AND event_date < '2026-10-01';
  RAISE NOTICE '   adjustments with NO asin: % -- these are the rows that can pair', v_n;
  RAISE NOTICE '   arbitrarily in fec_diff_month and show up as CHANGED by key';
  RAISE NOTICE '   collision; the aggregate is what holds for them, not the pairing';
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-09-01';
  RAISE NOTICE '   existing backup rows: %  (0 = still to be taken)', v_n;

  v_types := public.fec_snapshot_fingerprints(v_uid, '2026-09-01'::date, 'before');
  RAISE NOTICE '   fingerprints BEFORE, % non-adjustment types captured:', v_types;
  FOR r IN
    SELECT event_type, rows, fingerprint FROM public.fec_fingerprint_snapshot
    WHERE snap_month='2026-09-01' AND phase='before' ORDER BY event_type
  LOOP
    RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. pre-September P&L snapshot, through an auth context ==';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the snapshot would be zeros, like pl_baseline_20261022';
  END IF;

  DELETE FROM public.pl_snapshot WHERE snap_label = 'pre-2026-09';
  INSERT INTO public.pl_snapshot (snap_label, month_num, pl)
  SELECT 'pre-2026-09', (to_jsonb(l) ->> 'month_num')::integer, to_jsonb(l) - 'month_num'
  FROM public.get_monthly_pl_breakdown(2026) l;

  SELECT count(*), COALESCE(sum((pl->>'sales')::numeric),0) INTO v_n, v_sales
    FROM public.pl_snapshot WHERE snap_label='pre-2026-09';
  RAISE NOTICE '   snapshot: % months | 2026 sales %', v_n, round(v_sales,2);
  IF v_n <> 12 OR v_sales <= 0 THEN
    RAISE EXCEPTION 'pre-September snapshot is % months / % sales -- useless, not firing', v_n, v_sales;
  END IF;
  RAISE NOTICE '   September now reads: clawback % | reimbursements % | warehouse_damage %',
    (SELECT round((pl->>'compensated_clawback')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-09' AND month_num=9),
    (SELECT round((pl->>'reimbursements')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-09' AND month_num=9),
    (SELECT round((pl->>'warehouse_damage')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-09' AND month_num=9);
  RAISE NOTICE '   (August is in this snapshot at 132.08 -- it was applied before it)';

  IF v_blockers > 0 THEN
    RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers;
  END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-09-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired SEPTEMBER DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
