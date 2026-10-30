-- APRIL, second dry run. apply := false. April is NOT to be applied.
--
-- One at a time, as instructed: March's second run landed at 14:51:27 and is
-- compared in 20261030111000 (14 hits vs 0, only elapsed_ms and
-- rate_limit_hits moved out of 20 keys). April is the last month with a single
-- stored run, so this is the last gap in the invariance argument.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint; v_fired timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== pre-flight ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  RAISE NOTICE '   repull calls queued: %', v_n;
  IF v_n > 0 THEN RAISE EXCEPTION 'a repull is already in flight -- one month at a time'; END IF;
  SELECT count(*) INTO v_n FROM public.pl_sync_progress
  WHERE lower(COALESCE(status,'')) NOT IN ('completed','error','failed')
    AND created_at > now() - interval '2 hours';
  RAISE NOTICE '   in-flight P&L syncs: %', v_n;
  IF v_n > 0 THEN RAISE EXCEPTION 'a P&L sync is running -- not firing'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== every stored April report ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_items'          AS items,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-04' AND rr.report ? 'api_signed_total'
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   %  %  % % %  % %', r.t, rpad(r.applied::text,5),
      lpad(COALESCE(r.hits,'-'),4), lpad(COALESCE(r.pages,'-'),6),
      lpad(COALESCE(r.items,'-'),6), lpad(COALESCE(r.claw,'-'),11),
      lpad(COALESCE(r.signed,'-'),10);
  END LOOP;

  v_fired := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-04-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   fired APRIL DRY RUN (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired, v_req;
END
$p$;
