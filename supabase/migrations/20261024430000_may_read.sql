-- Read the MAY dry run. READ-ONLY.
DO $p$
DECLARE r record; v_uid uuid; v_api numeric; v_st numeric; v_claw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT (report->>'api_signed_total')::numeric,
         (report->>'stored_signed_total')::numeric,
         (report->>'api_clawback_total')::numeric
    INTO v_api, v_st, v_claw
  FROM public.repull_reports WHERE left(month,7)='2026-05'
  ORDER BY captured_at DESC LIMIT 1;

  IF v_api IS NULL THEN
    RAISE NOTICE 'MAY: no report yet -- the run has not finished. Re-read with:';
    RAISE NOTICE '  SELECT report FROM repull_reports WHERE left(month,7)=''2026-05'' ORDER BY captured_at DESC LIMIT 1;';
    RETURN;
  END IF;

  FOR r IN
    SELECT report->>'api_items' AS items, report->>'stored_rows' AS stored,
           report->>'pages' AS pages, report->>'rate_limit_hits' AS rl,
           report->>'api_items_via_catchall' AS ca,
           COALESCE(report->>'api_catchall_types','-') AS ctypes,
           report->>'elapsed_ms' AS ms
    FROM public.repull_reports WHERE left(month,7)='2026-05'
    ORDER BY captured_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '== MAY ==';
    RAISE NOTICE '   % api items | % stored rows | % pages | % rate-limit hits | % ms',
      r.items, r.stored, r.pages, r.rl, r.ms;
    RAISE NOTICE '   VIA CATCH-ALL: %   types: %', r.ca, r.ctypes;
  END LOOP;

  RAISE NOTICE '   stored % -> api % | net % | clawbacks % | residual %',
    v_st, v_api, round(v_api-v_st,2), v_claw, round((v_api-v_st)-v_claw,2);

  RAISE NOTICE '';
  RAISE NOTICE '== MAY multiset pairings ==';
  BEGIN
    PERFORM public.repull_residual_explain(v_uid,'2026-05-01');
  EXCEPTION WHEN others THEN RAISE NOTICE '   explain failed: %', SQLERRM;
  END;
END
$p$;
