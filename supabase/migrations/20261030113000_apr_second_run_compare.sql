-- APRIL, second dry run: read it and compare the two runs field by field.
-- Same shape as the March comparison in 20261030111000. No gate: April is NOT
-- being applied.
DO $p$
DECLARE r record; v_fired timestamptz := '2026-10-30 14:52:10.942895+00';
        v_rep jsonb; v_i int := 0; v_keys text[]; v_k text;
        v_a jsonb; v_b jsonb; v_diff int := 0;
BEGIN
  WHILE v_i < 10 LOOP
    v_rep := public.repull_find_fresh_report('2026-04-01'::date, v_fired);
    EXIT WHEN v_rep IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_rep IS NULL THEN
    RAISE NOTICE '== NO FRESH APRIL REPORT after % s -- STOP, do not conclude ==', v_i*15;
    FOR r IN
      SELECT id, to_char(created,'MM-DD HH24:MI:SS') AS t, status_code,
             left(COALESCE(content,'')::text,160) AS body
      FROM net._http_response WHERE created > v_fired - interval '5 minutes'
      ORDER BY created DESC LIMIT 5
    LOOP RAISE NOTICE '   pg_net % % % %', r.id, r.t, r.status_code,
           replace(r.body,'%','%%'); END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== APRIL run 2 landed after ~% s ==', v_i*15;
  RAISE NOTICE '   hits % | catch-all % | pages % | items % | clawbacks % | signed %',
    COALESCE(v_rep->>'rate_limit_hits','-'),
    COALESCE(v_rep->>'api_items_via_catchall','-'),
    COALESCE(v_rep->>'pages','-'),
    COALESCE(v_rep->>'api_items','-'),
    COALESCE(v_rep->>'api_clawback_total','-'),
    COALESCE(v_rep->>'api_signed_total','-');

  RAISE NOTICE '';
  RAISE NOTICE '== both stored April runs ==';
  RAISE NOTICE '   captured           applied  hits  pages  items   clawbacks     signed';
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

  RAISE NOTICE '';
  RAISE NOTICE '== field by field: run 1 vs run 2 ==';
  SELECT rr.report INTO v_a FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-04' AND rr.report ? 'api_signed_total'
   ORDER BY rr.captured_at LIMIT 1;
  v_b := v_rep;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys
  FROM (SELECT jsonb_object_keys(v_a) AS k UNION SELECT jsonb_object_keys(v_b)) u;

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
  RAISE NOTICE '== THE WHOLE INVARIANCE QUESTION, ALL MONTHS, ALL STORED RUNS ==';
  FOR r IN
    SELECT left(rr.month,7) AS mon, count(*) AS runs,
           min((rr.report->>'rate_limit_hits')::int) AS min_hits,
           max((rr.report->>'rate_limit_hits')::int) AS max_hits,
           count(DISTINCT rr.report->>'api_items')          AS d_items,
           count(DISTINCT rr.report->>'pages')              AS d_pages,
           count(DISTINCT rr.report->>'api_clawback_total') AS d_claw,
           count(DISTINCT rr.report->>'api_signed_total')   AS d_signed
    FROM public.repull_reports rr
    WHERE rr.applied = false AND rr.report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % runs | hits %..% | distinct values: items % pages % claw % signed % | %',
      r.mon, lpad(r.runs::text,2), lpad(r.min_hits::text,3), lpad(r.max_hits::text,3),
      r.d_items, r.d_pages, r.d_claw, r.d_signed,
      CASE WHEN r.runs < 2 THEN 'ONE RUN -- proves nothing'
           WHEN r.d_items=1 AND r.d_pages=1 AND r.d_claw=1 AND r.d_signed=1
             THEN 'INVARIANT across runs'
           ELSE 'THE DATA MOVED -- hits are NOT cosmetic' END;
  END LOOP;
END
$p$;
