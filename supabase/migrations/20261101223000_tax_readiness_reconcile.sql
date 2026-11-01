-- THE LIKE-FOR-LIKE RECONCILIATION. READ ONLY.
--
-- Only now are both sides on the same basis:
--   deposits : USD only, parsed only, March-October (what is actually on file)
--   P&L      : marketplace 'US', months 3-10 only
--
-- Both are still cash-vs-accrual, so they will not match exactly and are not
-- meant to. The question an accountant asks is whether the gap is EXPLAINABLE
-- and STABLE month to month, not whether it is zero.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_dep numeric; v_inc numeric; v_fee numeric; v_payout numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  SELECT round(sum(COALESCE(total_amount,0)),2) INTO v_dep
  FROM public.settlement_reports
  WHERE user_id = v_uid AND status = 'parsed' AND upper(COALESCE(currency,'')) = 'USD'
    AND COALESCE(deposit_date, settlement_end_date) >= '2026-03-01'
    AND COALESCE(deposit_date, settlement_end_date) <  '2026-11-01';

  SELECT
    round(sum(sales + reimbursements + shipping_credits + gift_wrap_credits
              + promotional_rebate_refunds + restocking_fee + other_income
              + liquidations + warehouse_lost + warehouse_damage
              + shipping_chargeback_refund),2),
    round(sum(referral_fees + fba_fees + variable_closing_fees
              + fixed_closing_fees + fba_inbound_fees + fba_storage_fees
              + fba_removal_fees + fba_disposal_fees
              + fba_long_term_storage_fees + fba_customer_return_fees
              + digital_services_fee + fba_inbound_convenience_fee
              + other_fees + liquidations_brokerage_fee
              + re_commerce_grading_charge + compensated_clawback
              + hrr_non_apparel + shipping_chargeback + refunds
              + shipping_credit_refunds + gift_wrap_credit_refunds
              + promotional_rebates),2)
    INTO v_inc, v_fee
  FROM public.get_monthly_pl_breakdown(2026, 'US')
  WHERE month_num BETWEEN 3 AND 10;
  v_payout := COALESCE(v_inc,0) - COALESCE(v_fee,0);

  RAISE NOTICE '######## MARCH-OCTOBER 2026, US / USD ONLY ########';
  RAISE NOTICE '   P&L income (ex sales tax)  : %', v_inc;
  RAISE NOTICE '   P&L Amazon fees + refunds  : %', v_fee;
  RAISE NOTICE '   implied Amazon payout      : %', round(v_payout,2);
  RAISE NOTICE '   USD deposits on file       : %', COALESCE(v_dep,0);
  RAISE NOTICE '   ------------------------------------------';
  RAISE NOTICE '   gap                        : %', round(COALESCE(v_dep,0) - v_payout,2);
  IF v_payout <> 0 THEN
    RAISE NOTICE '   gap as pct of payout       : % pct',
      round(100.0 * (COALESCE(v_dep,0) - v_payout) / v_payout, 2);
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   month | implied payout | USD deposits | gap      | gap pct';
  FOR r IN
    WITH pl AS (
      SELECT month_num AS m,
        (sales + reimbursements + shipping_credits + gift_wrap_credits
         + promotional_rebate_refunds + restocking_fee + other_income
         + liquidations + warehouse_lost + warehouse_damage
         + shipping_chargeback_refund)
        - (referral_fees + fba_fees + variable_closing_fees + fixed_closing_fees
           + fba_inbound_fees + fba_storage_fees + fba_removal_fees
           + fba_disposal_fees + fba_long_term_storage_fees
           + fba_customer_return_fees + digital_services_fee
           + fba_inbound_convenience_fee + other_fees
           + liquidations_brokerage_fee + re_commerce_grading_charge
           + compensated_clawback + hrr_non_apparel + shipping_chargeback
           + refunds + shipping_credit_refunds + gift_wrap_credit_refunds
           + promotional_rebates) AS payout
      FROM public.get_monthly_pl_breakdown(2026, 'US')
    ),
    dep AS (
      SELECT extract(month from COALESCE(deposit_date, settlement_end_date))::int AS m,
             sum(COALESCE(total_amount,0)) AS amt
      FROM public.settlement_reports
      WHERE user_id = v_uid AND status='parsed' AND upper(COALESCE(currency,''))='USD'
        AND COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
        AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01'
      GROUP BY 1
    )
    SELECT pl.m, round(pl.payout,2) AS payout, round(COALESCE(dep.amt,0),2) AS amt
    FROM pl LEFT JOIN dep ON dep.m = pl.m
    WHERE pl.m BETWEEN 3 AND 10 ORDER BY pl.m
  LOOP
    RAISE NOTICE '   %  | % | % | % | % pct', lpad(r.m::text,5),
      lpad(r.payout::text,14), lpad(r.amt::text,12),
      lpad(round(r.amt - r.payout,2)::text,9),
      lpad(CASE WHEN r.payout <> 0
                THEN round(100.0*(r.amt-r.payout)/r.payout,1)::text ELSE '-' END,6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READING IT: a NEGATIVE gap means less cash arrived than the';
  RAISE NOTICE '   P&L implies. Expected contributors, none of them errors:';
  RAISE NOTICE '     * timing -- a settlement period straddles month ends, and';
  RAISE NOTICE '       the last October period had not been deposited yet;';
  RAISE NOTICE '     * marketplace facilitator tax, which settlements carry and';
  RAISE NOTICE '       Financial Events does not;';
  RAISE NOTICE '     * Amazon reserve withholding;';
  RAISE NOTICE '     * the 29 throttled reports, whose cash is in no month.';
  RAISE NOTICE '   A gap that is STABLE as a percentage month to month is';
  RAISE NOTICE '   timing. One that jumps in a single month is worth chasing.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
