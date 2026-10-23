-- January verification: diff by key, money by line, other months untouched.
DO $p$
DECLARE v_uid uuid; r record; v_live bigint; v_col text; v_b numeric; v_a numeric; v_drift int := 0;
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
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01';

  RAISE NOTICE '== January: 5510 backed up -> % live ==', v_live;
  IF v_live = 0 THEN
    RAISE NOTICE '   NOT LANDED YET -- January is EMPTY. Rollback:';
    RAISE NOTICE '     see fec_repull_backup backup_month=2026-01-01 (5510 rows)';
    RETURN;
  END IF;

  FOR r IN
    SELECT event_type, count(*) AS rows FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    GROUP BY 1 ORDER BY rows DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.event_type,14), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== DIFF BY KEY ==';
  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-01-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== REMOVED / new by event_type (key change is expected for adjustments) ==';
  FOR r IN
    SELECT verdict, event_type, count(*) AS rows, min(event_date) AS lo, max(event_date) AS hi
    FROM public.fec_diff_month(v_uid,'2026-01-01')
    WHERE verdict IN ('REMOVED','new') GROUP BY 1,2 ORDER BY 1, rows DESC
  LOOP
    RAISE NOTICE '   % | % | % rows | % .. %',
      rpad(r.verdict,8), rpad(r.event_type,14), lpad(r.rows::text,5), r.lo, r.hi;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L CHANGE BY LINE ==';
  FOREACH v_col IN ARRAY v_cols LOOP
    BEGIN
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_repull_backup
                        WHERE user_id=%L AND backup_month='2026-01-01'$q$, v_col, v_uid) INTO v_b;
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
                        WHERE user_id=%L AND event_date>='2026-01-01' AND event_date<'2026-02-01'$q$,
                     v_col, v_uid) INTO v_a;
      IF COALESCE(v_b,0) <> COALESCE(v_a,0) THEN
        v_drift := v_drift + 1;
        RAISE NOTICE '   % : % -> %  (delta %)', rpad(v_col,34), v_b, v_a, round(v_a-v_b,2);
      END IF;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END LOOP;
  IF v_drift = 0 THEN RAISE NOTICE '   NOTHING moved'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== January clawbacks and provenance ==';
  FOR r IN
    SELECT count(*) AS adj, count(adjustment_type) AS prov,
           count(*) FILTER (WHERE adjustment_type='COMPENSATED_CLAWBACK') AS claw_n,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date>='2026-01-01' AND event_date<'2026-02-01'
  LOOP
    RAISE NOTICE '   % adjustment rows (was 92) | provenance on % | % clawbacks | $%',
      r.adj, r.prov, r.claw_n, r.claw;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== OTHER MONTHS UNTOUCHED? ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS ym, count(*) AS rows,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND NOT (event_date>='2026-01-01' AND event_date<'2026-02-01')
      AND event_date >= '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % adj rows | clawback %', r.ym, lpad(r.rows::text,4), r.claw; END LOOP;
END
$p$;
