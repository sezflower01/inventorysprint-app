-- HOW MUCH OF 2026 IS UNRECONCILED? READ ONLY.
--
-- Clarifying a distinction my own report blurred. "January is missing" was
-- about the SETTLEMENT side only, and that needed saying more carefully,
-- because January SALES are present and large.
--
-- Two different sources:
--   * the P&L reads financial_events_cache -- Amazon's Financial Events, which
--     covers January fully. Sales, fees, refunds: all there.
--   * the reconciliation's other side reads settlement_reports -- the cash
--     Amazon actually deposited. THAT is what has no January period.
--
-- So nothing is wrong with January's P&L. What is true is narrower: January and
-- February cannot yet be TIED TO CASH, so the 1.55% agreement covers eight of
-- ten posted months and not the whole year. This sizes the untied part.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_tot numeric := 0; v_rec numeric := 0; v_unrec numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE '######## US P&L BY MONTH, AND WHETHER CASH CAN BE TIED ########';
  RAISE NOTICE '   month |        sales | implied payout | USD deposits | tied?';
  FOR r IN
    WITH pl AS (
      SELECT month_num AS m, sales,
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
      FROM public.get_monthly_pl_breakdown(2026, 'US')),
    dep AS (
      SELECT extract(month from COALESCE(deposit_date, settlement_end_date))::int AS m,
             sum(COALESCE(total_amount,0)) AS amt
      FROM public.settlement_reports
      WHERE user_id = v_uid AND status='parsed' AND upper(COALESCE(currency,''))='USD'
        AND COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
        AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01'
      GROUP BY 1)
    SELECT pl.m, round(pl.sales,2) AS sales, round(pl.payout,2) AS payout,
           round(COALESCE(dep.amt,0),2) AS amt
    FROM pl LEFT JOIN dep ON dep.m = pl.m
    ORDER BY pl.m
  LOOP
    IF r.sales <> 0 OR r.amt <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | %', lpad(r.m::text,5),
        lpad(r.sales::text,12), lpad(r.payout::text,14),
        lpad(r.amt::text,12),
        CASE WHEN r.amt > 0 THEN 'yes' ELSE '>>> NO CASH ON FILE' END;
      v_tot := v_tot + r.payout;
      IF r.amt > 0 THEN v_rec := v_rec + r.payout;
                   ELSE v_unrec := v_unrec + r.payout; END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   total US implied payout, 2026        : %', round(v_tot,2);
  RAISE NOTICE '   of which TIED to deposits (Mar-Oct)  : % (% pct)',
    round(v_rec,2), round(100.0*v_rec/NULLIF(v_tot,0),1);
  RAISE NOTICE '   of which UNTIED (Jan, Feb, Nov)      : % (% pct)',
    round(v_unrec,2), round(100.0*v_unrec/NULLIF(v_tot,0),1);
  RAISE NOTICE '';
  RAISE NOTICE '   To be clear about what "missing" meant: the P&L for January';
  RAISE NOTICE '   and February is COMPLETE -- Financial Events covers them and';
  RAISE NOTICE '   the sales above are real. What is absent is the settlement';
  RAISE NOTICE '   report, i.e. the cash side, so those months cannot yet be';
  RAISE NOTICE '   cross-checked against a deposit. November is untied simply';
  RAISE NOTICE '   because it has barely started.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## SANITY: DOES JANUARY LOOK NORMAL? ########';
  RAISE NOTICE '   a month with no cash record is worth checking for internal';
  RAISE NOTICE '   consistency instead -- fees as a share of sales should sit in';
  RAISE NOTICE '   the same band as every other month.';
  RAISE NOTICE '   month |        sales |     fees | fees as pct of sales';
  FOR r IN
    SELECT month_num AS m, round(sales,2) AS sales,
           round(referral_fees + fba_fees + variable_closing_fees
                 + fixed_closing_fees + fba_inbound_fees + fba_storage_fees
                 + fba_removal_fees + fba_disposal_fees
                 + fba_long_term_storage_fees + fba_customer_return_fees
                 + digital_services_fee + fba_inbound_convenience_fee
                 + other_fees,2) AS fees
    FROM public.get_monthly_pl_breakdown(2026, 'US')
    WHERE sales > 0 ORDER BY month_num
  LOOP
    RAISE NOTICE '   %  | % | % | % pct', lpad(r.m::text,5),
      lpad(r.sales::text,12), lpad(r.fees::text,8),
      lpad(round(100.0*r.fees/NULLIF(r.sales,0),1)::text,6);
  END LOOP;
  RAISE NOTICE '   a January fee ratio in line with the rest is evidence the';
  RAISE NOTICE '   month ingested properly, independent of any deposit.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
