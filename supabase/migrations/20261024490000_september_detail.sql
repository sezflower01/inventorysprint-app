-- SEPTEMBER detail: per-column attribution and multiset pairings. READ-ONLY.
DO $p$
DECLARE
  v_uid uuid; v_body jsonb; v_col text;
  v_api numeric; v_stored numeric; v_claw numeric; v_resid numeric;
  v_sum_api numeric; v_sum_stored numeric; v_check numeric := 0;
  v_cols text[] := ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                         'free_replacement_refund_items','compensated_clawback',
                         'reimbursements','fbm_shipping_label_fee'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_body := public.repull_find_report('2026-09-01'::date, false, NULL, true);

  v_api    := (v_body->>'api_signed_total')::numeric;
  v_stored := (v_body->>'stored_signed_total')::numeric;
  v_claw   := (v_body->>'api_clawback_total')::numeric;
  v_resid  := round((v_api - v_stored) - v_claw, 2);

  RAISE NOTICE '################ 2026-09 ################';
  RAISE NOTICE '   % api items -> % after dedupe | % stored rows | % pages | % rate-limit hits | % ms',
    v_body->>'api_items', v_body->>'api_rows_after_dedupe', v_body->>'stored_rows',
    v_body->>'pages', v_body->>'rate_limit_hits', v_body->>'elapsed_ms';
  RAISE NOTICE '   routed to nothing % | skipped liquidation % | wrote %',
    v_body->>'api_items_routed_to_nothing', v_body->>'api_items_skipped_liquidation',
    v_body->>'wrote';
  RAISE NOTICE '   VIA CATCH-ALL: %   types: %',
    v_body->>'api_items_via_catchall', v_body->'api_catchall_types';
  RAISE NOTICE '   stored % -> api % | net % | clawbacks % | RESIDUAL %',
    v_stored, v_api, round(v_api-v_stored,2), v_claw, v_resid;

  RAISE NOTICE '';
  RAISE NOTICE '   per-column net change:';
  FOREACH v_col IN ARRAY v_cols LOOP
    EXECUTE format($q$
      SELECT
        (SELECT COALESCE(sum(x::numeric),0)
           FROM jsonb_array_elements_text(COALESCE(%L::jsonb,'[]'::jsonb)) AS t(x)),
        (SELECT COALESCE(sum(%I),0) FROM public.financial_events_cache
          WHERE user_id = %L AND event_type='adjustment'
            AND event_date >= '2026-09-01' AND event_date < '2026-10-01')
    $q$, v_body->'api_amount_multiset'->v_col, v_col, v_uid)
    INTO v_sum_api, v_sum_stored;

    IF round(v_sum_api,2) = 0 AND round(v_sum_stored,2) = 0 THEN CONTINUE; END IF;
    RAISE NOTICE '      % | stored % -> api % | delta %',
      rpad(v_col,32), lpad(round(v_sum_stored,2)::text,10),
      lpad(round(v_sum_api,2)::text,10), lpad(round(v_sum_api-v_sum_stored,2)::text,9);
    IF v_col <> 'compensated_clawback' THEN
      v_check := v_check + round(v_sum_api - v_sum_stored, 2);
    END IF;
  END LOOP;
  RAISE NOTICE '      non-clawback columns sum to % | header says % | %',
    round(v_check,2), v_resid,
    CASE WHEN round(v_check,2) = v_resid THEN 'AGREES' ELSE '!! DISAGREES' END;

  RAISE NOTICE '';
  PERFORM public.repull_residual_explain(v_uid,'2026-09-01');
END
$p$;
