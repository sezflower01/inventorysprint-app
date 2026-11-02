-- THE NET PROFIT ROW. READ ONLY. Short on purpose.
--
-- The seller is worried the P&L shows a loss because the Compensated Clawbacks
-- line is red. Red there is correct -- it is an expense. The question that
-- matters is the bottom line, so this computes it the way the screen does:
-- INCOME_ROWS - EXPENSE_ROWS - COGS, per plModel.ts. Sales tax is excluded
-- because it sits below Net Profit and was never ours.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_ty numeric := 0; v_tc numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE 'month |      income |    expenses |        COGS |  NET PROFIT';
  FOR r IN
    SELECT p.month_num AS m,
      (p.sales + p.reimbursements + p.shipping_credits + p.gift_wrap_credits
       + p.promotional_rebate_refunds + p.restocking_fee + p.other_income
       + p.liquidations + p.warehouse_lost + p.warehouse_damage
       + p.shipping_chargeback_refund) AS income,
      (p.referral_fees + p.fba_fees + p.variable_closing_fees
       + p.fixed_closing_fees + p.fba_inbound_fees + p.fba_storage_fees
       + p.fba_removal_fees + p.fba_disposal_fees
       + p.fba_long_term_storage_fees + p.fba_customer_return_fees
       + p.digital_services_fee + p.fba_inbound_convenience_fee + p.other_fees
       + p.liquidations_brokerage_fee + p.re_commerce_grading_charge
       + p.compensated_clawback + p.hrr_non_apparel + p.shipping_chargeback
       + p.refunds + p.shipping_credit_refunds + p.gift_wrap_credit_refunds
       + p.promotional_rebates) AS expenses,
      COALESCE(c.cogs,0) AS cogs
    FROM public.get_monthly_pl_breakdown(2026, NULL) p
    LEFT JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = p.month_num
    ORDER BY p.month_num
  LOOP
    IF r.income <> 0 OR r.cogs <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | % %', lpad(r.m::text,2),
        lpad(round(r.income,2)::text,11), lpad(round(r.expenses,2)::text,11),
        lpad(round(r.cogs,2)::text,11),
        lpad(round(r.income - r.expenses - r.cogs,2)::text,12),
        CASE WHEN (r.income - r.expenses - r.cogs) < 0 THEN '  <== NEGATIVE' ELSE '' END;
      v_ty := v_ty + (r.income - r.expenses - r.cogs);
      v_tc := v_tc + r.cogs;
    END IF;
  END LOOP;
  RAISE NOTICE '--------------------------------------------------------------';
  RAISE NOTICE '2026 NET PROFIT (before operating expenses): %', round(v_ty,2);
  RAISE NOTICE '2026 COGS: %', round(v_tc,2);
  RAISE NOTICE '';
  RAISE NOTICE 'NOTE: this is BEFORE your own operating expenses (the P&L screen';
  RAISE NOTICE 'subtracts those too), and November has barely any reconciled';
  RAISE NOTICE 'data yet, so a small or negative November is timing, not a loss.';
  RAISE NOTICE '';
  RAISE NOTICE 'READ ONLY.';
END
$p$;
