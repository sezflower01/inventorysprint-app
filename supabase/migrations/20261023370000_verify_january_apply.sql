-- ITEM 2 + 3 verification for the January apply.
DO $p$
DECLARE
  v_uid uuid; r record; v_raw text; v_body jsonb; v_status int;
  v_col text; v_b numeric; v_a numeric; v_drift int := 0; v_sum_delta numeric := 0;
  v_cols text[] := ARRAY['sales','refunds','shipping_credits','shipping_credit_refunds',
    'gift_wrap_credits','gift_wrap_credit_refunds','promotional_rebates','promotional_rebate_refunds',
    'other_income','reimbursements','liquidations','referral_fees','fba_fees','variable_closing_fees',
    'fixed_closing_fees','fba_inbound_fees','fba_storage_fees','fba_removal_fees','fba_disposal_fees',
    'fba_long_term_storage_fees','other_fees','sales_tax_collected','marketplace_facilitator_tax',
    'sales_tax_refunds','marketplace_facilitator_tax_refunds','fba_customer_return_fees',
    'compensated_clawback','hrr_non_apparel','digital_services_fee','warehouse_lost','warehouse_damage',
    'reversal_reimbursement','free_replacement_refund_items','fba_inbound_convenience_fee',
    'liquidations_brokerage_fee','re_commerce_grading_charge','shipping_chargeback',
    'shipping_chargeback_refund','restocking_fee','fbm_shipping_label_fee'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT status_code, left(COALESCE(content,''),1600) INTO v_status, v_raw
  FROM net._http_response WHERE id = 37975;
  IF v_raw IS NULL THEN
    RAISE NOTICE '== 37975: pending | queue depth % ==',
      (SELECT count(*) FROM net.http_request_queue);
    RETURN;
  END IF;
  v_body := v_raw::jsonb;
  RAISE NOTICE '== HTTP % | wrote % ==', v_status, v_body->>'wrote';
  IF v_body ? 'error'   THEN RAISE NOTICE '   ERROR: %', v_body->>'error'; END IF;
  IF v_body ? 'aborted' THEN RAISE NOTICE '   ABORTED: %', v_body->>'aborted'; END IF;
  IF v_body ? 'applied' THEN RAISE NOTICE '   applied: %', v_body->'applied'; END IF;
  RAISE NOTICE '   API items % -> % rows | clawback $% | signed $%',
    v_body->>'api_items', v_body->>'api_rows_after_dedupe',
    v_body->>'api_clawback_total', v_body->>'api_signed_total';

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 2a: NON-ADJUSTMENT FINGERPRINT ==';
  RAISE NOTICE '   BEFORE  liquidation    62 528904dce9de0c69331ed80ef0592324';
  RAISE NOTICE '           refund        255 f84e7517eda6055b1554a8768e223267';
  RAISE NOTICE '           service_fee   398 2a2f6b5f59085f1c6ac61a6f9ae92b9a';
  RAISE NOTICE '           shipment     4703 7c0c12a05683a0c4fdab3e84bcb24d97';
  RAISE NOTICE '   AFTER';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-01-01') ORDER BY event_type
  LOOP
    RAISE NOTICE '           % % %', rpad(r.event_type,13), lpad(r.rows::text,5), r.fingerprint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 2b: DIFF BY KEY ==';
  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-01-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.rows; END LOOP;

  FOR r IN
    SELECT verdict, event_type, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-01-01')
    WHERE verdict IN ('REMOVED','new','CHANGED') GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % | % | % rows', rpad(r.verdict,8), rpad(r.event_type,12), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 2c: clawbacks stored vs API (API said -230.38) ==';
  FOR r IN
    SELECT count(*) FILTER (WHERE adjustment_type='COMPENSATED_CLAWBACK') AS n,
           round(sum(COALESCE(compensated_clawback,0)),2) AS total,
           count(*) AS adj_rows, count(adjustment_type) AS prov
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date>='2026-01-01' AND event_date<'2026-02-01'
  LOOP
    RAISE NOTICE '   % adjustment rows | provenance on % | % clawbacks | stored $%',
      r.adj_rows, r.prov, r.n, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 2d: P&L CHANGE BY LINE, all 40 columns ==';
  FOREACH v_col IN ARRAY v_cols LOOP
    BEGIN
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_repull_backup
                        WHERE user_id=%L AND backup_month='2026-01-01'$q$, v_col, v_uid) INTO v_b;
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
                        WHERE user_id=%L AND event_date>='2026-01-01' AND event_date<'2026-02-01'$q$,
                     v_col, v_uid) INTO v_a;
      IF COALESCE(v_b,0) <> COALESCE(v_a,0) THEN
        v_drift := v_drift + 1;
        v_sum_delta := v_sum_delta + (v_a - v_b);
        RAISE NOTICE '   % : % -> %  (delta %)', rpad(v_col,34), v_b, v_a, round(v_a-v_b,2);
      END IF;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END LOOP;
  IF v_drift = 0 THEN RAISE NOTICE '   NOTHING moved'; END IF;
  RAISE NOTICE '   % of 40 columns moved | net money delta %', v_drift, round(v_sum_delta,2);

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 3: where the extra -1.20 sits ==';
  RAISE NOTICE '   signed-total change -231.58 minus clawback -230.38 = -1.20.';
  RAISE NOTICE '   The old catch-all tested amount > 0, so unrecognised NEGATIVES';
  RAISE NOTICE '   were dropped. They now land in reimbursements:';
  FOR r IN
    SELECT COALESCE(adjustment_type,'(none)') AS atype, count(*) AS n,
           round(sum(COALESCE(reimbursements,0)),2) AS reimb
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date>='2026-01-01' AND event_date<'2026-02-01'
      AND COALESCE(reimbursements,0) <> 0
    GROUP BY 1 ORDER BY 3
  LOOP RAISE NOTICE '      % | % rows | reimbursements %', rpad(r.atype,32), r.n, r.reimb; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      no non-zero reimbursements rows'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 3b: do the new rows carry the same money as the old, ex-clawback? ==';
  FOR r IN
    SELECT
      (SELECT round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                       +COALESCE(reversal_reimbursement,0)+COALESCE(free_replacement_refund_items,0)
                       +COALESCE(fbm_shipping_label_fee,0)),2)
       FROM public.fec_repull_backup
       WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment') AS before_ex,
      (SELECT round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                       +COALESCE(reversal_reimbursement,0)+COALESCE(free_replacement_refund_items,0)
                       +COALESCE(fbm_shipping_label_fee,0)),2)
       FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment'
         AND event_date>='2026-01-01' AND event_date<'2026-02-01') AS after_ex
  LOOP
    RAISE NOTICE '   excluding clawback and reimbursements: % -> % (delta %)',
      r.before_ex, r.after_ex, round(r.after_ex - r.before_ex, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== OTHER MONTHS UNCHANGED? (outside Jan and Oct) ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(COALESCE(compensated_clawback,0)),2) AS claw,
           count(adjustment_type) AS prov
    FROM public.financial_events_cache
    WHERE user_id=v_uid
      AND NOT (event_date>='2026-01-01' AND event_date<'2026-02-01')
      AND NOT (event_date>='2026-10-01' AND event_date<'2026-11-01')
  LOOP
    RAISE NOTICE '   % rows | clawback % | provenance on %', r.rows, r.claw, r.prov;
  END LOOP;
END
$p$;
