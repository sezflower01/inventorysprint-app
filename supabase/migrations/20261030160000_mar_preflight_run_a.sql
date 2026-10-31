-- MARCH, stage 2 under the COMPLETENESS GATE: pre-flight + dry run A.
--
-- March already has two dry runs on file (10-24 and the one fired on 10-30 at
-- 20261030110000, which agreed on every data field across 14 hits vs 0). Those
-- are NOT used as half the gated pair, for the same reason February's weren't:
-- they prove the data is stable over a week, which is the ARGUMENT for the gate,
-- but the gate has to test the run that is about to be committed. Two fresh runs
-- fired back to back, immediately before the apply.
--
-- Recorded clawback figure to beat: -182.54. It is printed for comparison and
-- reported if it differs, but it is no longer a stop condition on its own -- the
-- stop condition is the two fresh runs disagreeing, or catch-all not 0.
--
-- Three migrations follow, split because pg_net cannot deliver a request fired
-- in an uncommitted transaction -- run A's report cannot be read in the
-- migration that fires it.
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
  IF v_blockers = 0 THEN RAISE NOTICE '   CLEAR'; END IF;

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
  RAISE NOTICE '== 4. the existing March runs (context, NOT the gate) ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t,
           rr.report->>'rate_limit_hits' AS hits, rr.report->>'pages' AS pages,
           rr.report->>'api_items' AS items,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total' AS signed,
           rr.report->>'api_items_via_catchall' AS catchall
    FROM public.repull_reports rr
    WHERE left(rr.month,7)='2026-03' AND rr.report ? 'api_signed_total'
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   % | hits % | pages % | items % | claw % | signed % | catch-all %',
      r.t, lpad(COALESCE(r.hits,'-'),3), lpad(COALESCE(r.pages,'-'),3),
      lpad(COALESCE(r.items,'-'),4), lpad(COALESCE(r.claw,'-'),9),
      lpad(COALESCE(r.signed,'-'),9), lpad(COALESCE(r.catchall,'-'),3);
  END LOOP;
  RAISE NOTICE '   the gate itself uses two FRESH runs, not these.';

  RAISE NOTICE '';
  RAISE NOTICE '== 5. March as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-03-01' AND event_date < '2026-04-01';
  RAISE NOTICE '   live rows (all types): %  <-- the backup must match this', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-03-01' AND event_date < '2026-04-01';
  RAISE NOTICE '   of which adjustments: %', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment' AND COALESCE(asin,'') = ''
    AND event_date >= '2026-03-01' AND event_date < '2026-04-01';
  RAISE NOTICE '   adjustments with NO asin: % -- can pair arbitrarily in the diff', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND COALESCE(compensated_clawback,0) <> 0
    AND event_date >= '2026-03-01' AND event_date < '2026-04-01';
  RAISE NOTICE '   adjustments already carrying a clawback: % (0 = nothing booked yet)', v_n;
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-03-01';
  RAISE NOTICE '   existing backup rows: %  (0 = still to be taken)', v_n;

  v_types := public.fec_snapshot_fingerprints(v_uid, '2026-03-01'::date, 'before');
  RAISE NOTICE '   fingerprints BEFORE, % non-adjustment types captured:', v_types;
  FOR r IN
    SELECT event_type, rows, fingerprint FROM public.fec_fingerprint_snapshot
    WHERE snap_month='2026-03-01' AND phase='before' ORDER BY event_type
  LOOP
    RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. pre-March P&L snapshot, through an auth context ==';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the snapshot would be zeros';
  END IF;

  DELETE FROM public.pl_snapshot WHERE snap_label = 'pre-2026-03';
  INSERT INTO public.pl_snapshot (snap_label, month_num, pl)
  SELECT 'pre-2026-03', (to_jsonb(l) ->> 'month_num')::integer, to_jsonb(l) - 'month_num'
  FROM public.get_monthly_pl_breakdown(2026) l;

  SELECT count(*), COALESCE(sum((pl->>'sales')::numeric),0) INTO v_n, v_sales
    FROM public.pl_snapshot WHERE snap_label='pre-2026-03';
  RAISE NOTICE '   snapshot: % months | 2026 sales %', v_n, round(v_sales,2);
  IF v_n <> 12 OR v_sales <= 0 THEN
    RAISE EXCEPTION 'pre-March snapshot is % months / % sales -- not firing', v_n, v_sales;
  END IF;
  RAISE NOTICE '   March now reads: clawback % | reimbursements % | warehouse_lost %',
    (SELECT round((pl->>'compensated_clawback')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-03' AND month_num=3),
    (SELECT round((pl->>'reimbursements')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-03' AND month_num=3),
    (SELECT round((pl->>'warehouse_lost')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-03' AND month_num=3);
  RAISE NOTICE '   February reads clawback % -- the applied month, for contrast',
    (SELECT round((pl->>'compensated_clawback')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-03' AND month_num=2);

  IF v_blockers > 0 THEN RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers; END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-03-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired MARCH DRY RUN A (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
  RAISE NOTICE '   hits on this run are RECORDED, not a stop condition';
END
$p$;
