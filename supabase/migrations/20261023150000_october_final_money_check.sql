-- ITEM 2 final: with the Oct 23 rows restored, is the ONLY money change the
-- clawback?
DO $p$
DECLARE v_uid uuid; v_col text; v_b numeric; v_a numeric; v_drift int := 0; r record;
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

  RAISE NOTICE '== OCTOBER: money by column, pre-resync backup vs live ==';
  FOREACH v_col IN ARRAY v_cols LOOP
    BEGIN
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_repull_backup
                        WHERE user_id=%L AND backup_month='2026-10-01'$q$, v_col, v_uid) INTO v_b;
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
                        WHERE user_id=%L AND event_date>='2026-10-01' AND event_date<'2026-11-01'$q$,
                     v_col, v_uid) INTO v_a;
      IF COALESCE(v_b,0) <> COALESCE(v_a,0) THEN
        v_drift := v_drift + 1;
        RAISE NOTICE '   % : % -> %  (delta %)', rpad(v_col,34), v_b, v_a, round(v_a-v_b,2);
      END IF;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END LOOP;
  IF v_drift = 0 THEN RAISE NOTICE '   NOTHING moved'; END IF;
  RAISE NOTICE '   (% of 40 columns moved)', v_drift;

  RAISE NOTICE '';
  RAISE NOTICE '== the 2 CHANGED rows ==';
  FOR r IN
    SELECT d.event_type, d.event_date, d.amazon_order_id, k.key AS col,
           d.before_money->>k.key AS oldv, d.after_money->>k.key AS newv
    FROM public.fec_diff_month(v_uid,'2026-10-01') d
    CROSS JOIN LATERAL jsonb_object_keys(d.after_money) AS k(key)
    WHERE d.verdict='CHANGED'
      AND COALESCE(d.before_money->>k.key,'') IS DISTINCT FROM COALESCE(d.after_money->>k.key,'')
  LOOP
    RAISE NOTICE '   % % % | % : % -> %', r.event_type, r.event_date,
      left(COALESCE(r.amazon_order_id,'-'),22), r.col, r.oldv, r.newv;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== other months still untouched? ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(COALESCE(compensated_clawback,0)),2) AS claw,
           count(adjustment_type) AS prov
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND NOT (event_date>='2026-10-01' AND event_date<'2026-11-01')
  LOOP
    RAISE NOTICE '   outside October: % rows | clawback % | provenance on %',
      r.rows, r.claw, r.prov;
  END LOOP;
END
$p$;
