-- AUGUST: the three gates, read off THIS run's report only.
--
--   1. rate_limit_hits        must be 0  (not waived)
--   2. api_items_via_catchall must be 0
--   3. api_clawback_total     must be -132.08
--
-- August had exactly ONE stored run before this one (10-24 19:41, 0 hits), so
-- -132.08 rested on a single observation. This fire is the second, and the
-- field-by-field comparison below is what turns the gate constant from an
-- assertion into agreement between two runs.
--
-- Reports, never raises: a failed migration blocks the queue and has to be
-- rewritten in place, and a stop here is a legitimate outcome, not an error.
DO $p$
DECLARE r record; v_fired timestamptz := '2026-10-30 15:14:04.800796+00';
        v_rep jsonb; v_i int := 0; v_a jsonb; v_keys text[]; v_k text; v_diff int := 0;
        v_hits int; v_catch int; v_claw numeric; v_pass boolean := true;
BEGIN
  WHILE v_i < 10 LOOP
    v_rep := public.repull_find_fresh_report('2026-08-01'::date, v_fired);
    EXIT WHEN v_rep IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_rep IS NULL THEN
    RAISE NOTICE '== NO FRESH AUGUST REPORT after % s ==', v_i*15;
    RAISE NOTICE '   NULL means STOP, never "nothing to check". Request 35550 was';
    RAISE NOTICE '   fired at %. The pg_net response row may simply have been', v_fired;
    RAISE NOTICE '   pruned while the report landed -- re-read before concluding.';
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

  RAISE NOTICE '== AUGUST dry run, landed after ~% s ==', v_i*15;
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
         WHEN v_catch < 0 THEN 'FAILED -- key absent from the report' ELSE 'FAILED' END;
  IF v_catch <> 0 THEN v_pass := false; END IF;

  RAISE NOTICE '   GATE 3  clawbacks        %  %', lpad(v_claw::text,8),
    CASE WHEN v_claw = -132.08 THEN 'pass' ELSE 'FAILED -- differs from -132.08' END;
  IF v_claw <> -132.08 THEN v_pass := false; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== run 1 vs run 2, every key in either ==';
  SELECT rr.report INTO v_a FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-08' AND rr.report ? 'api_signed_total'
     AND rr.captured_at < v_fired
   ORDER BY rr.captured_at LIMIT 1;

  IF v_a IS NULL THEN
    RAISE NOTICE '   no earlier August run to compare against';
  ELSE
    SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys
    FROM (SELECT jsonb_object_keys(v_a) AS k UNION SELECT jsonb_object_keys(v_rep)) u;
    FOREACH v_k IN ARRAY v_keys LOOP
      IF COALESCE(v_a->>v_k,'~') <> COALESCE(v_rep->>v_k,'~') THEN
        v_diff := v_diff + 1;
        RAISE NOTICE '   % | run1 % | run2 % <-- DIFFERS', rpad(v_k,26),
          lpad(left(COALESCE(v_a->>v_k,'(absent)'),22),22),
          lpad(left(COALESCE(v_rep->>v_k,'(absent)'),22),22);
      END IF;
    END LOOP;
    RAISE NOTICE '   keys compared % | keys that differ %', array_length(v_keys,1), v_diff;
    RAISE NOTICE '   (elapsed_ms and rate_limit_hits describe the RUN; anything';
    RAISE NOTICE '    describing the DATA must not move, or -132.08 is not a fact)';
  END IF;

  RAISE NOTICE '';
  IF v_pass THEN
    RAISE NOTICE '   ALL THREE GATES PASS -- clear to back up, diff and apply';
  ELSE
    RAISE NOTICE '   >>> GATE FAILED. Nothing applied. Report and stop.';
  END IF;
END
$p$;
