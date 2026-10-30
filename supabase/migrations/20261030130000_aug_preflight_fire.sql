-- AUGUST, stage 2: pre-flight + fresh dry run. apply := false.
--
-- Same sequence as May, June and July. Two things are new, both because of what
-- July's verification turned up once the baseline could actually record
-- something:
--
--   1. A PRE-AUGUST P&L snapshot. pl_baseline_20261030 was captured at 14:51,
--      BEFORE July's apply, so comparing live against it now would report
--      July's four moved cells alongside August's and the two would be
--      indistinguishable. The baseline stays as the cumulative anchor for the
--      whole re-pull; this snapshot isolates August's own movement. Same table
--      shape, a label instead of a date, because before and after are
--      necessarily separate transactions.
--
--   2. The gate constant -132.08 is printed from every stored August report.
--      August has only ONE stored run, so there is no cross-run agreement to
--      lean on the way July had three -- the single run is the whole provenance
--      of that number, and this run will be the second.
--
-- The impersonation is repeated inline rather than wrapped in a function: a
-- callable pl_live_as_user(uid, year) would be an RLS bypass for every table
-- scoped by auth.uid().
CREATE TABLE IF NOT EXISTS public.pl_snapshot (
  snap_label text    NOT NULL,
  month_num  integer NOT NULL,
  pl         jsonb   NOT NULL,
  taken_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snap_label, month_num)
);
ALTER TABLE public.pl_snapshot ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pl_snapshot IS
  'Labelled P&L snapshots taken through an auth context inside migrations, for isolating one month''s re-pull movement. pl_baseline_20261030 remains the cumulative anchor. Rows are written only by migrations; nothing callable sets request.jwt.claims, which would be an RLS bypass.';

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
  RAISE NOTICE '== 4. the recorded August figure, from stored reports ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items_via_catchall' AS catchall,
           rr.report->>'api_items'          AS items,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-08'
    ORDER BY rr.captured_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | applied % | claw % | hits % | catch-all % | items % | pages % | signed %',
      r.t, r.applied, lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.hits,'-'),3),
      lpad(COALESCE(r.catchall,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),4), lpad(COALESCE(r.signed,'-'),9);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO stored August report -- the -132.08 gate value is UNSOURCED';
    v_blockers := v_blockers + 1;
  END IF;

  SELECT count(*) INTO v_n FROM public.repull_reports rr
  WHERE left(rr.month,7)='2026-08' AND rr.report ? 'api_signed_total';
  RAISE NOTICE '   stored August runs: % -- this fire makes % (one run has nothing to agree with)',
    v_n, v_n + 1;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. August as it stands ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-08-01' AND event_date < '2026-09-01';
  RAISE NOTICE '   live rows (all types): %', v_n;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-08-01' AND event_date < '2026-09-01';
  RAISE NOTICE '   of which adjustments: %', v_n;
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-08-01';
  RAISE NOTICE '   existing backup rows: %  (0 = still to be taken)', v_n;

  v_types := public.fec_snapshot_fingerprints(v_uid, '2026-08-01'::date, 'before');
  RAISE NOTICE '   fingerprints BEFORE, % non-adjustment types captured:', v_types;
  FOR r IN
    SELECT event_type, rows, fingerprint FROM public.fec_fingerprint_snapshot
    WHERE snap_month='2026-08-01' AND phase='before' ORDER BY event_type
  LOOP
    RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. pre-August P&L snapshot, through an auth context ==';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the snapshot would be zeros, like pl_baseline_20261022';
  END IF;

  DELETE FROM public.pl_snapshot WHERE snap_label = 'pre-2026-08';
  INSERT INTO public.pl_snapshot (snap_label, month_num, pl)
  SELECT 'pre-2026-08', (to_jsonb(l) ->> 'month_num')::integer, to_jsonb(l) - 'month_num'
  FROM public.get_monthly_pl_breakdown(2026) l;

  SELECT COALESCE(sum((pl->>'sales')::numeric),0) INTO v_sales
    FROM public.pl_snapshot WHERE snap_label='pre-2026-08';
  SELECT count(*) INTO v_n FROM public.pl_snapshot WHERE snap_label='pre-2026-08';
  RAISE NOTICE '   snapshot: % months | 2026 sales %', v_n, round(v_sales,2);
  IF v_n <> 12 OR v_sales <= 0 THEN
    RAISE EXCEPTION 'pre-August snapshot is % months / % sales -- useless, not firing', v_n, v_sales;
  END IF;
  RAISE NOTICE '   August now reads: clawback % | warehouse_damage % | reversal %',
    (SELECT round((pl->>'compensated_clawback')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-08' AND month_num=8),
    (SELECT round((pl->>'warehouse_damage')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-08' AND month_num=8),
    (SELECT round((pl->>'reversal_reimbursement')::numeric,2) FROM public.pl_snapshot
      WHERE snap_label='pre-2026-08' AND month_num=8);

  IF v_blockers > 0 THEN
    RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers;
  END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-08-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired AUGUST DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
