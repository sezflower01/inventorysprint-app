-- MARCH, second dry run. apply := false. March is NOT to be applied.
--
-- Why a second run at all: the argument for ignoring rate-limit hits rests on
-- the data being invariant across runs. That is well evidenced for June (eight
-- runs, 0 to 17 hits, identical items/pages/clawbacks) and for February (14
-- hits vs 0, identical). March and April have exactly ONE stored run each, so
-- "invariant across all runs" is vacuous for them -- one run cannot vary. This
-- gives March a second.
--
-- Also settles a figure that moved overnight: last night's June verification
-- read October clawbacks as -166.28; this morning the same query reads -196.85.
-- October is the live month and fetch-profit-loss re-syncs it on a schedule, so
-- a new clawback posting is the expected explanation -- but "expected" is not
-- "checked", and an unexplained 30.57 in a month nobody touched would be the
-- first sign that something else writes these rows.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_blockers int := 0;
        v_fired timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== 0. the October clawback figure that moved ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0) AS claw_rows,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw,
           to_char(max(created_at),'MM-DD HH24:MI') AS newest_row
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows carry one | total % | newest row written %',
      r.m, lpad(r.claw_rows::text,4), lpad(r.claw::text,10), r.newest_row;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   October clawback rows written in the last 24h:';
  FOR r IN
    SELECT to_char(created_at,'MM-DD HH24:MI') AS t, event_date,
           round(compensated_clawback::numeric,2) AS claw,
           COALESCE(adjustment_type,'-') AS atype
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
      AND COALESCE(compensated_clawback,0) <> 0
      AND created_at > now() - interval '24 hours'
    ORDER BY created_at DESC LIMIT 12
  LOOP
    RAISE NOTICE '      written % | event_date % | % | %',
      r.t, r.event_date, lpad(r.claw::text,8), r.atype;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '      NONE -- so the 30.57 did not arrive as new rows in 24h; look again';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. cron failure clusters, last 24h ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS t, count(*) AS n,
           left(COALESCE(max(d.return_message),'-'),44) AS msg
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1
  LOOP
    RAISE NOTICE '   CLUSTER % | % jobs | %', r.t, r.n, r.msg;
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
  RAISE NOTICE '== 4. every stored March report ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items_via_catchall' AS catchall,
           rr.report->>'api_items'          AS items,
           rr.report->>'api_pages'          AS pages
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-03'
    ORDER BY rr.captured_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | applied % | claw % | hits % | catch-all % | items % | pages %',
      r.t, r.applied, lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.hits,'-'),3),
      lpad(COALESCE(r.catchall,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),3);
  END LOOP;

  IF v_blockers > 0 THEN RAISE EXCEPTION '% blocker(s) -- not firing', v_blockers; END IF;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-03-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   PRE-FLIGHT CLEAR -- fired MARCH DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
