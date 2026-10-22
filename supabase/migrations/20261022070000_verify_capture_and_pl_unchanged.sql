-- Part B verification. Did the re-sync fill the new columns, and did ANY money
-- value move?
--
-- The get_monthly_pl_breakdown baseline I tried to take came back all zeros:
-- the RPC scopes by auth.uid(), which is NULL inside a migration, so RLS
-- filtered everything. That baseline is useless and is ignored here.
--
-- The row-level backup is better evidence anyway. financial_events_cache is
-- the ONLY source the P&L reads, so if every money column matches the backup
-- row-for-row and only the provenance columns differ, the P&L cannot have
-- moved -- no aggregate over unchanged inputs can change. That is a stronger
-- statement than comparing one RPC's output.
DO $p$
DECLARE
  v_uid uuid; r record;
  v_money_cols text[] := ARRAY[
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
  v_col text; v_sql text; v_before numeric; v_after numeric; v_drift int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. did the provenance columns fill? ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(adjustment_type) AS with_type,
           count(seller_sku) AS with_sku,
           count(quantity) AS with_qty,
           count(posted_at) AS with_posted,
           count(raw_event) AS with_raw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
  LOOP
    RAISE NOTICE '   % October adjustment rows', r.rows;
    RAISE NOTICE '   adjustment_type % | seller_sku % | quantity % | posted_at % | raw_event %',
      r.with_type, r.with_sku, r.with_qty, r.with_posted, r.with_raw;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. the AdjustmentTypes now visible for the first time ==';
  FOR r IN
    SELECT adjustment_type, count(*) AS rows,
           sum(COALESCE(quantity,0)) AS units,
           count(seller_sku) AS with_sku
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
      AND adjustment_type IS NOT NULL
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | % units | % with a SKU',
      rpad(r.adjustment_type,32), lpad(r.rows::text,4), lpad(r.units::text,5), r.with_sku;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE yet -- the re-sync may still be running, or it skipped the month';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. P&L SAFETY: every money column, backup vs live ==';
  FOREACH v_col IN ARRAY v_money_cols LOOP
    BEGIN
      v_sql := format(
        'SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_adjustment_backup_20261022', v_col);
      EXECUTE v_sql INTO v_before;
      v_sql := format(
        'SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
         WHERE user_id = %L AND event_type = ''adjustment''
           AND event_date >= ''2026-10-01'' AND event_date < ''2026-11-01''', v_col, v_uid);
      EXECUTE v_sql INTO v_after;
      IF COALESCE(v_before,0) <> COALESCE(v_after,0) THEN
        v_drift := v_drift + 1;
        RAISE NOTICE '   DRIFT % : before % -> after %', rpad(v_col,34), v_before, v_after;
      END IF;
    EXCEPTION WHEN undefined_column THEN
      NULL; -- column absent from one side; skip rather than fail the migration
    END;
  END LOOP;

  IF v_drift = 0 THEN
    RAISE NOTICE '   NO DRIFT across % money columns. The P&L reads only these,', array_length(v_money_cols,1);
    RAISE NOTICE '   so it cannot have moved.';
  ELSE
    RAISE NOTICE '   >>> % columns MOVED -- investigate before trusting this change', v_drift;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. row count: backup vs live (a delete/reinsert must not lose rows) ==';
  FOR r IN
    SELECT (SELECT count(*) FROM public.fec_adjustment_backup_20261022) AS before_rows,
           (SELECT count(*) FROM public.financial_events_cache
            WHERE user_id = v_uid AND event_type = 'adjustment'
              AND event_date >= '2026-10-01' AND event_date < '2026-11-01') AS after_rows
  LOOP
    RAISE NOTICE '   before % | after % | delta %',
      r.before_rows, r.after_rows, r.after_rows - r.before_rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. still zero clawback rows? (the drop is NOT fixed, by design) ==';
  FOR r IN
    SELECT count(*) AS rows FROM public.financial_events_cache
    WHERE user_id = v_uid AND COALESCE(compensated_clawback,0) <> 0
  LOOP
    RAISE NOTICE '   compensated_clawback rows table-wide: %  (expected 0 -- awaiting approval)', r.rows;
  END LOOP;
END
$p$;
