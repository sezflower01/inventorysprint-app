-- MARCH, second dry run: read it and compare the two runs field by field.
--
-- Polls rather than guessing at the timing. The June re-fire took 57 s and the
-- first read landed on an empty result, which cost a migration and nearly cost
-- a wrong conclusion. repull_find_fresh_report refuses any report not captured
-- after the fire, so a stale one cannot be mistaken for this run's.
--
-- No gate here: March is NOT being applied. The question is only whether the
-- figures move between runs, which is the whole basis for treating rate-limit
-- hits as cosmetic.
DO $p$
DECLARE r record; v_fired timestamptz := '2026-10-30 14:50:35.054957+00';
        v_rep jsonb; v_i int := 0; v_keys text[]; v_k text;
        v_a jsonb; v_b jsonb; v_diff int := 0;
BEGIN
  WHILE v_i < 10 LOOP
    v_rep := public.repull_find_fresh_report('2026-03-01'::date, v_fired);
    EXIT WHEN v_rep IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_rep IS NULL THEN
    RAISE NOTICE '== NO FRESH MARCH REPORT after % s ==', v_i * 15;
    RAISE NOTICE '   NULL means stop, never "nothing to check". Request 35263 was';
    RAISE NOTICE '   fired at %; re-read before drawing any conclusion.', v_fired;
    FOR r IN
      SELECT id, to_char(created,'MM-DD HH24:MI:SS') AS t, status_code,
             left(COALESCE(content,'')::text,160) AS body
      FROM net._http_response WHERE created > v_fired - interval '5 minutes'
      ORDER BY created DESC LIMIT 5
    LOOP RAISE NOTICE '   pg_net % % % %', r.id, r.t, r.status_code,
           replace(r.body,'%','%%'); END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== MARCH run 2 landed after ~% s ==', v_i * 15;
  RAISE NOTICE '   hits % | catch-all % | pages % | items % | clawbacks % | signed %',
    COALESCE(v_rep->>'rate_limit_hits','-'),
    COALESCE(v_rep->>'api_items_via_catchall','-'),
    COALESCE(v_rep->>'pages','-'),
    COALESCE(v_rep->>'api_items','-'),
    COALESCE(v_rep->>'api_clawback_total','-'),
    COALESCE(v_rep->>'api_signed_total','-');

  RAISE NOTICE '';
  RAISE NOTICE '== both stored March runs ==';
  RAISE NOTICE '   captured           applied  hits  pages  items   clawbacks     signed';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_items'          AS items,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-03' AND rr.report ? 'api_signed_total'
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   %  %  % % %  % %', r.t, rpad(r.applied::text,5),
      lpad(COALESCE(r.hits,'-'),4), lpad(COALESCE(r.pages,'-'),6),
      lpad(COALESCE(r.items,'-'),6), lpad(COALESCE(r.claw,'-'),11),
      lpad(COALESCE(r.signed,'-'),10);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== field by field: run 1 vs run 2, every key in either ==';
  SELECT rr.report INTO v_a FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-03' AND rr.report ? 'api_signed_total'
   ORDER BY rr.captured_at LIMIT 1;
  v_b := v_rep;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys
  FROM (SELECT jsonb_object_keys(v_a) AS k
        UNION SELECT jsonb_object_keys(v_b)) u;

  FOREACH v_k IN ARRAY v_keys LOOP
    IF COALESCE(v_a->>v_k,'~') <> COALESCE(v_b->>v_k,'~') THEN
      v_diff := v_diff + 1;
      RAISE NOTICE '   % | run1 % | run2 % <-- DIFFERS', rpad(v_k,26),
        lpad(left(COALESCE(v_a->>v_k,'(absent)'),22),22),
        lpad(left(COALESCE(v_b->>v_k,'(absent)'),22),22);
    END IF;
  END LOOP;
  RAISE NOTICE '   keys compared % | keys that differ %', array_length(v_keys,1), v_diff;
  RAISE NOTICE '';
  RAISE NOTICE '   (elapsed_ms, rate_limit_hits and any timestamp SHOULD differ --';
  RAISE NOTICE '    they describe the run. Anything describing the DATA must not.)';
END
$p$;
