-- Two things, in order:
--
--   A. Every stored dry run for February, March and April, so the question
--      "do rate-limit hits ever change the data" can be answered from the
--      record instead of argued. READ-ONLY.
--
--   B. June re-fire, once. Pre-flight, capture the 'before' fingerprints
--      through the new set-comparison helper, then fire a single dry run.
--
-- The resumable fetcher is deliberately NOT built. Table A is the evidence that
-- decides whether it is needed at all.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0;
        v_fired timestamptz; v_types int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '################ A. ALL STORED DRY RUNS: FEB / MAR / APR ################';
  RAISE NOTICE '   month   captured           applied  hits  pages  items   clawbacks     signed';
  FOR r IN
    SELECT left(rr.month,7) AS mon,
           to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t,
           rr.applied,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_items'          AS items,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) IN ('2026-02','2026-03','2026-04')
      AND rr.report ? 'api_signed_total'
    ORDER BY left(rr.month,7), rr.captured_at
  LOOP
    RAISE NOTICE '   % %  %  % % %  % %',
      r.mon, r.t, rpad(r.applied::text,5),
      lpad(COALESCE(r.hits,'-'),4), lpad(COALESCE(r.pages,'-'),6),
      lpad(COALESCE(r.items,'-'),6), lpad(COALESCE(r.claw,'-'),11),
      lpad(COALESCE(r.signed,'-'),10);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no stored reports for those three months)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   -- per month: do the figures EVER move across runs? --';
  FOR r IN
    SELECT left(rr.month,7) AS mon, count(*) AS runs,
           count(DISTINCT rr.report->>'api_items')          AS distinct_items,
           count(DISTINCT rr.report->>'pages')              AS distinct_pages,
           count(DISTINCT rr.report->>'api_clawback_total') AS distinct_claw,
           count(DISTINCT rr.report->>'api_signed_total')   AS distinct_signed,
           min((rr.report->>'rate_limit_hits')::int)        AS min_hits,
           max((rr.report->>'rate_limit_hits')::int)        AS max_hits
    FROM public.repull_reports rr
    WHERE left(rr.month,7) IN ('2026-02','2026-03','2026-04')
      AND rr.report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % runs | hits %..% | distinct: items % pages % claw % signed % | %',
      r.mon, lpad(r.runs::text,2), lpad(r.min_hits::text,3), lpad(r.max_hits::text,3),
      r.distinct_items, r.distinct_pages, r.distinct_claw, r.distinct_signed,
      CASE WHEN r.distinct_items = 1 AND r.distinct_pages = 1
            AND r.distinct_claw = 1 AND r.distinct_signed = 1
           THEN 'INVARIANT across all runs' ELSE '<-- SOMETHING MOVED' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '################ B. JUNE RE-FIRE ################';

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

  RAISE NOTICE '';
  RAISE NOTICE '== 3. sync in progress? ==';
  SELECT count(*) INTO v_n FROM public.pl_sync_progress
  WHERE lower(COALESCE(status,'')) NOT IN ('completed','error','failed')
    AND created_at > now() - interval '2 hours';
  RAISE NOTICE '   in-flight P&L syncs: %', v_n;
  IF v_n > 0 THEN v_blockers := v_blockers + 1; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. nothing was written by the stopped run ==';
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-06-01';
  RAISE NOTICE '   June backup rows: % (must be 0)', v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'June backup is not empty -- investigate before re-firing'; END IF;

  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-06-01' AND event_date < '2026-07-01';
  RAISE NOTICE '   June live rows: % (was 5682 at the stopped run)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. capture BEFORE fingerprints (set comparison) ==';
  v_types := public.fec_snapshot_fingerprints(v_uid, '2026-06-01'::date, 'before');
  RAISE NOTICE '   captured % non-adjustment type(s):', v_types;
  FOR r IN
    SELECT event_type, rows, fingerprint FROM public.fec_fingerprint_snapshot
    WHERE snap_month='2026-06-01' AND phase='before' ORDER BY event_type
  LOOP RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  IF v_blockers > 0 THEN RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers; END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-06-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   RE-FIRED DRY RUN (apply=false), once';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
