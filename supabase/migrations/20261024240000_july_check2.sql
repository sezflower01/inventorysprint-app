DO $p$
DECLARE v_uid uuid; v_req bigint; v_b jsonb; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  -- A dropped RESPONSE does not mean the function did not run; the report is
  -- persisted server-side. Look for a July report carrying the gate field.
  SELECT report INTO v_b FROM public.repull_reports
  WHERE left(month,7)='2026-07' AND report ? 'api_items_via_catchall'
  ORDER BY captured_at DESC LIMIT 1;

  IF v_b IS NULL THEN
    RAISE NOTICE '   no July report with the gate field yet -- re-firing';
    BEGIN v_req := public.repull_fire(v_uid,'2026-07-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSE
    RAISE NOTICE '   July report FOUND despite the dropped response';
    RAISE NOTICE '   via catch-all: % | types %',
      v_b->>'api_items_via_catchall', COALESCE(v_b->>'api_catchall_types','-');
    RAISE NOTICE '   clawback % | predicted %', v_b->>'api_clawback_total',
      round((v_b->>'api_signed_total')::numeric - (v_b->>'stored_signed_total')::numeric,2);
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== gate values, newest report per month ==';
  FOR r IN
    SELECT DISTINCT ON (left(month,7)) left(month,7) AS m,
           COALESCE(report->>'api_items_via_catchall','(absent)') AS cnt
    FROM public.repull_reports WHERE report ? 'api_signed_total' AND applied=false
    ORDER BY left(month,7), captured_at DESC
  LOOP RAISE NOTICE '   % | via catch-all %', r.m, r.cnt; END LOOP;
END
$p$;
