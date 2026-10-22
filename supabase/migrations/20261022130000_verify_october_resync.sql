-- Verification for the October Clear Cache & Resync.
--
-- The claim to test: the ONLY change is compensated_clawback appearing for
-- 2026-10-18..22 (about -16.31). Every other money column must be identical to
-- fec_october_backup_20261022, and the new provenance columns must now be
-- populated.
DO $p$
DECLARE
  v_uid uuid; r record;
  v_cols text[] := ARRAY[
    'sales','refunds','shipping_credits','shipping_credit_refunds','gift_wrap_credits',
    'gift_wrap_credit_refunds','promotional_rebates','promotional_rebate_refunds',
    'other_income','reimbursements','liquidations','referral_fees','fba_fees',
    'variable_closing_fees','fixed_closing_fees','fba_inbound_fees','fba_storage_fees',
    'fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees','other_fees',
    'sales_tax_collected','marketplace_facilitator_tax','sales_tax_refunds',
    'marketplace_facilitator_tax_refunds','fba_customer_return_fees','compensated_clawback',
    'hrr_non_apparel','digital_services_fee','warehouse_lost','warehouse_damage',
    'reversal_reimbursement','free_replacement_refund_items','fba_inbound_convenience_fee',
    'liquidations_brokerage_fee','re_commerce_grading_charge','shipping_chargeback',
    'shipping_chargeback_refund','restocking_fee','fbm_shipping_label_fee'
  ];
  v_col text; v_before numeric; v_after numeric; v_delta numeric;
  v_changed int := 0; v_live bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date <= '2026-10-31';

  RAISE NOTICE '== rows: backup 3086 -> live % ==', v_live;
  IF v_live = 0 THEN
    RAISE NOTICE '   SYNC HAS NOT LANDED YET -- re-run this probe shortly.';
    RAISE NOTICE '   October is currently EMPTY. Restore with:';
    RAISE NOTICE '     INSERT INTO public.financial_events_cache';
    RAISE NOTICE '     SELECT * FROM public.fec_october_backup_20261022;';
    RETURN;
  END IF;

  FOR r IN
    SELECT event_type, count(*) AS rows FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
    GROUP BY 1 ORDER BY rows DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.event_type,16), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. provenance columns now populated? ==';
  FOR r IN
    SELECT count(*) AS adj_rows,
           count(adjustment_type) AS with_type,
           count(seller_sku) AS with_sku,
           count(quantity) AS with_qty,
           count(posted_at) AS with_posted,
           count(raw_event) AS with_raw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
  LOOP
    RAISE NOTICE '   % adjustment rows | type % | sku % | qty % | posted % | raw %',
      r.adj_rows, r.with_type, r.with_sku, r.with_qty, r.with_posted, r.with_raw;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. AdjustmentTypes, first time ever stored ==';
  FOR r IN
    SELECT adjustment_type, count(*) AS rows, sum(COALESCE(quantity,0)) AS units,
           round(sum(COALESCE(compensated_clawback,0)),2) AS clawback
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
      AND adjustment_type IS NOT NULL
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | % units | clawback %',
      rpad(r.adjustment_type,32), lpad(r.rows::text,4), lpad(r.units::text,5), r.clawback;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. P&L BY LINE: every money column, backup vs live ==';
  FOREACH v_col IN ARRAY v_cols LOOP
    BEGIN
      EXECUTE format('SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_october_backup_20261022', v_col)
        INTO v_before;
      EXECUTE format(
        'SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
         WHERE user_id = %L AND event_date >= ''2026-10-01'' AND event_date <= ''2026-10-31''',
        v_col, v_uid) INTO v_after;
      v_delta := COALESCE(v_after,0) - COALESCE(v_before,0);
      IF v_delta <> 0 THEN
        v_changed := v_changed + 1;
        RAISE NOTICE '   CHANGED % : % -> %  (delta %)',
          rpad(v_col,34), v_before, v_after, v_delta;
      END IF;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END LOOP;

  IF v_changed = 0 THEN
    RAISE NOTICE '   nothing changed at all -- including clawback, which should have appeared';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. the clawback rows themselves ==';
  FOR r IN
    SELECT event_date, COALESCE(seller_sku,'-') AS sku, COALESCE(quantity,0) AS qty,
           compensated_clawback AS amt, left(COALESCE(posted_at::text,'-'),19) AS posted
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND COALESCE(compensated_clawback,0) <> 0
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
    ORDER BY posted_at
  LOOP
    RAISE NOTICE '   % | sku % | qty % | % | posted %',
      r.event_date, rpad(r.sku,16), r.qty, lpad(r.amt::text,8), r.posted;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO clawback rows -- expected about -16.31 over Oct 18-22'; END IF;
END
$p$;
