DO $p$
DECLARE v_uid uuid; v_s text; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_s := public.repull_report2(55095);
  IF v_s <> 'done' THEN RAISE NOTICE '   July %', v_s; RETURN; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== CATCH-ALL GATE, newest report per month ==';
  FOR r IN
    SELECT DISTINCT ON (left(month,7)) left(month,7) AS m,
           COALESCE(report->>'api_items_via_catchall','(absent)') AS cnt,
           COALESCE(report->>'api_catchall_types','-') AS types
    FROM public.repull_reports WHERE report ? 'api_signed_total' AND applied=false
    ORDER BY left(month,7), captured_at DESC
  LOOP RAISE NOTICE '   % | via catch-all % | %', r.m, r.cnt, left(r.types,40); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '============ JUNE ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-06-01');
  RAISE NOTICE '';
  RAISE NOTICE '============ JULY (+10.48) ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-07-01');
END
$p$;
