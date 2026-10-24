DO $p$
DECLARE v_uid uuid; v_b jsonb; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT report INTO v_b FROM public.repull_reports
  WHERE left(month,7)='2026-07' AND report ? 'api_items_via_catchall'
  ORDER BY captured_at DESC LIMIT 1;
  IF v_b IS NULL THEN
    RAISE NOTICE '   July still has no gate-bearing report';
  ELSE
    RAISE NOTICE '== JULY ==';
    RAISE NOTICE '   via catch-all % | types %', v_b->>'api_items_via_catchall',
      COALESCE(v_b->>'api_catchall_types','-');
    RAISE NOTICE '   API % rows | clawback % | predicted %',
      v_b->>'api_rows_after_dedupe', v_b->>'api_clawback_total',
      round((v_b->>'api_signed_total')::numeric - (v_b->>'stored_signed_total')::numeric,2);
    RAISE NOTICE '';
    PERFORM public.repull_residual_explain(v_uid,'2026-07-01');
  END IF;
END
$p$;
