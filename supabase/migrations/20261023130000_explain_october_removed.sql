-- 161 REMOVED and 130 new. Expected for ADJUSTMENTS -- the key generation
-- changed, so every adjustment row has a new amazon_order_id and the old key
-- necessarily reads as removed. But 161 is more than the 123 adjustment rows
-- that existed, so something else moved too. Explain it before trusting this.
DO $p$
DECLARE v_uid uuid; r record; v_col text; v_b numeric; v_a numeric; v_drift int := 0;
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

  RAISE NOTICE '== REMOVED and new, by event_type ==';
  FOR r IN
    SELECT verdict, event_type, count(*) AS rows,
           min(event_date) AS first_d, max(event_date) AS last_d
    FROM public.fec_diff_month(v_uid,'2026-10-01')
    WHERE verdict IN ('REMOVED','new')
    GROUP BY 1,2 ORDER BY 1, rows DESC
  LOOP
    RAISE NOTICE '   % | % | % rows | % .. %',
      rpad(r.verdict,8), rpad(r.event_type,14), lpad(r.rows::text,4), r.first_d, r.last_d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE DECIDING TEST: money by column, backup vs live ==';
  RAISE NOTICE '   row churn from a key change is cosmetic; a money delta is not';
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
  IF v_drift = 0 THEN RAISE NOTICE '   NO money column moved at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== did the adjustment KEYS change shape? (the fix working) ==';
  FOR r IN
    SELECT 'backup' AS side, min(amazon_order_id) AS lo, max(amazon_order_id) AS hi, count(*) AS n
    FROM public.fec_repull_backup WHERE user_id=v_uid AND backup_month='2026-10-01'
      AND event_type='adjustment' AND event_date='2026-10-07'
    UNION ALL
    SELECT 'live', min(amazon_order_id), max(amazon_order_id), count(*)
    FROM public.financial_events_cache WHERE user_id=v_uid
      AND event_type='adjustment' AND event_date='2026-10-07'
  LOOP
    RAISE NOTICE '   % | % rows | % .. %', rpad(r.side,7), r.n, r.lo, r.hi;
  END LOOP;
END
$p$;
