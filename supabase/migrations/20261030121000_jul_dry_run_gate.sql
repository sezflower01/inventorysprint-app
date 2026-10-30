-- JULY: the three gates, read off THIS run's report only.
--
--   1. rate_limit_hits        must be 0  (not waived -- June was re-fired)
--   2. api_items_via_catchall must be 0
--   3. api_clawback_total     must be -246.44, the value three stored July
--                             reports agree on (10-24 12:13, 13:08, 14:37)
--
-- Reports, never raises: a failed migration blocks the queue and has to be
-- rewritten in place, and a stop here is a legitimate outcome rather than an
-- error. Nothing is applied by this file either way.
DO $p$
DECLARE r record; v_fired timestamptz := '2026-10-30 14:54:58.560202+00';
        v_rep jsonb; v_i int := 0;
        v_hits int; v_catch int; v_claw numeric; v_pass boolean := true;
BEGIN
  WHILE v_i < 10 LOOP
    v_rep := public.repull_find_fresh_report('2026-07-01'::date, v_fired);
    EXIT WHEN v_rep IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_rep IS NULL THEN
    RAISE NOTICE '== NO FRESH JULY REPORT after % s ==', v_i*15;
    RAISE NOTICE '   NULL means STOP, never "nothing to check". Request 35309 was';
    RAISE NOTICE '   fired at %. Check pg_net below, then re-read -- the response', v_fired;
    RAISE NOTICE '   row may simply have been pruned while the report landed.';
    FOR r IN
      SELECT id, to_char(created,'MM-DD HH24:MI:SS') AS t, status_code,
             left(COALESCE(content,'')::text,200) AS body
      FROM net._http_response WHERE created > v_fired - interval '5 minutes'
      ORDER BY created DESC LIMIT 5
    LOOP RAISE NOTICE '   pg_net % % % %', r.id, r.t, r.status_code,
           replace(r.body,'%','%%'); END LOOP;
    RETURN;
  END IF;

  v_hits  := (v_rep->>'rate_limit_hits')::int;
  v_catch := COALESCE((v_rep->>'api_items_via_catchall')::int, -1);
  v_claw  := round((v_rep->>'api_clawback_total')::numeric, 2);

  RAISE NOTICE '== JULY dry run, landed after ~% s ==', v_i*15;
  RAISE NOTICE '   items % | pages % | elapsed % ms | signed total %',
    v_rep->>'api_items', v_rep->>'pages', v_rep->>'elapsed_ms',
    v_rep->>'api_signed_total';

  RAISE NOTICE '';
  RAISE NOTICE '== THE GATES ==';
  RAISE NOTICE '   GATE 1  rate-limit hits  %  %', lpad(v_hits::text,8),
    CASE WHEN v_hits = 0 THEN 'pass' ELSE 'FAILED -- re-fire, do not waive' END;
  IF v_hits <> 0 THEN v_pass := false; END IF;

  RAISE NOTICE '   GATE 2  catch-all items  %  %', lpad(v_catch::text,8),
    CASE WHEN v_catch = 0 THEN 'pass'
         WHEN v_catch < 0 THEN 'FAILED -- key absent from the report'
         ELSE 'FAILED' END;
  IF v_catch <> 0 THEN v_pass := false; END IF;

  RAISE NOTICE '   GATE 3  clawbacks        %  %', lpad(v_claw::text,8),
    CASE WHEN v_claw = -246.44 THEN 'pass' ELSE 'FAILED -- differs from -246.44' END;
  IF v_claw <> -246.44 THEN v_pass := false; END IF;

  RAISE NOTICE '';
  IF v_pass THEN
    RAISE NOTICE '   ALL THREE GATES PASS -- clear to back up, diff and apply';
  ELSE
    RAISE NOTICE '   >>> GATE FAILED. Nothing applied. Report and stop.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== every stored July run, for context ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t,
           rr.report->>'rate_limit_hits' AS hits,
           rr.report->>'api_items' AS items, rr.report->>'pages' AS pages,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total' AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7)='2026-07' AND rr.report ? 'api_signed_total'
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   % | hits % | items % | pages % | claw % | signed %',
      r.t, lpad(COALESCE(r.hits,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),3), lpad(COALESCE(r.claw,'-'),9),
      lpad(COALESCE(r.signed,'-'),9);
  END LOOP;
END
$p$;
