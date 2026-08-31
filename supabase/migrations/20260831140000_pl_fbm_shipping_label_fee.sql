-- Surface fbm_shipping_label_fee in the P&L. It has been collected all along
-- and never shown.
--
-- ── HOW IT WAS FOUND ──────────────────────────────────────────────────────
--
-- Reconciling 2026 against InventoryLab on 2026-08-31, restricted to US-only
-- and Amazon-only so both tools measured the same thing. Net from Amazon came
-- out $449,288.50 (this app) against $448,406.42 (InventoryLab) -- 0.20% apart,
-- and FBA Fulfillment, the largest single line at $171,536.92, agreed within
-- 0.17%. Both parsers are sound.
--
-- The one line with no counterpart here was InventoryLab's "MFN Shipping Label
-- Cost", $1,148.26 for 2026 plus $29.27 on returns. Not a parsing failure:
-- fetch-profit-loss writes fbm_shipping_label_fee in three places
-- (ShippingCharge with a negative amount, the service-fee branch, and postage
-- billing adjustments), and financial_events_cache has carried the column
-- since 20260526151411. It simply never appeared in either RPC's RETURNS
-- TABLE, so it died in the cache.
--
-- This is exactly the failure plModel.ts warns about in its own header:
--
--   "Adding a category to the source data is NOT enough to get it into the
--    P&L. It must be added to INCOME_ROWS or EXPENSE_ROWS below, or it is
--    silently dropped from both reports."
--
-- The warning was written after the Web/Excel drift of 2026-08-19, and then
-- the same class of bug happened again on a column the warning did not cover:
-- the row list was only half the path. A category must reach the RPC too.
--
-- Effect: a real cost the seller pays was never subtracted, so Net Profit has
-- been overstated by whatever this totals -- roughly $1,178 across 2026 if it
-- tracks InventoryLab.
--
-- ── WHY DROP AND NOT CREATE OR REPLACE ────────────────────────────────────
--
-- CREATE OR REPLACE FUNCTION cannot change a function's return type (42P13),
-- and adding a column to RETURNS TABLE is exactly that. Same family as the
-- 42P16 restriction on views that bit this session already. Both functions are
-- therefore dropped and recreated whole.
--
-- ── NO REPARSE NEEDED ─────────────────────────────────────────────────────
--
-- The data is already in financial_events_cache for every month. This is a
-- read-path change only: the figures appear as soon as the P&L is reloaded.
-- All three writers store a positive magnitude (each applies Math.abs before
-- accumulating), so SUM(ABS(...)) matches the other fee columns and cannot
-- flip sign on a credit.

DROP FUNCTION IF EXISTS public.get_pl_live_summary(text, text, text);

CREATE FUNCTION public.get_pl_live_summary(
  start_ts text,
  end_ts text,
  p_marketplace text
)
RETURNS TABLE(sales numeric, refunds numeric, reimbursements numeric, shipping_credits numeric, shipping_credit_refunds numeric, gift_wrap_credits numeric, gift_wrap_credit_refunds numeric, promotional_rebates numeric, promotional_rebate_refunds numeric, other_income numeric, liquidations numeric, referral_fees numeric, fba_fees numeric, variable_closing_fees numeric, fixed_closing_fees numeric, fba_inbound_fees numeric, fba_inbound_convenience_fee numeric, fba_storage_fees numeric, fba_removal_fees numeric, fba_disposal_fees numeric, fba_long_term_storage_fees numeric, fba_customer_return_fees numeric, digital_services_fee numeric, other_fees numeric, liquidations_brokerage_fee numeric, re_commerce_grading_charge numeric, compensated_clawback numeric, hrr_non_apparel numeric, warehouse_lost numeric, warehouse_damage numeric, reversal_reimbursement numeric, free_replacement_refund_items numeric, sales_tax_collected numeric, marketplace_facilitator_tax numeric, sales_tax_refunds numeric, marketplace_facilitator_tax_refunds numeric, total_income numeric, total_expenses numeric, fbm_shipping_label_fee numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d,
           NULLIF(UPPER(COALESCE(p_marketplace,'')),'') AS mp
  ),
  base AS (
    SELECT
      f.event_type,
      f.sales,
      f.refunds,
      f.reimbursements,
      f.reversal_reimbursement,
      f.free_replacement_refund_items,
      f.shipping_credits,
      f.shipping_credit_refunds,
      f.gift_wrap_credits,
      f.gift_wrap_credit_refunds,
      f.promotional_rebates,
      f.promotional_rebate_refunds,
      f.other_income,
      f.liquidations,
      f.referral_fees,
      f.fba_fees,
      f.variable_closing_fees,
      f.fixed_closing_fees,
      f.fba_inbound_fees,
      f.fba_inbound_convenience_fee,
      f.fba_storage_fees,
      f.fba_removal_fees,
      f.fba_disposal_fees,
      f.fba_long_term_storage_fees,
      f.fba_customer_return_fees,
      f.digital_services_fee,
      f.other_fees,
      f.liquidations_brokerage_fee,
      f.re_commerce_grading_charge,
      f.compensated_clawback,
      f.hrr_non_apparel,
      f.warehouse_lost,
      f.warehouse_damage,
      f.sales_tax_collected,
      f.marketplace_facilitator_tax,
      f.sales_tax_refunds,
      f.marketplace_facilitator_tax_refunds,
      f.fbm_shipping_label_fee
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= b.start_d
      AND f.event_date::date <= b.end_d
      AND (
        b.mp IS NULL OR b.mp = 'ALL'
        OR (b.mp = 'US' AND (f.marketplace IS NULL OR UPPER(f.marketplace) = 'US' OR UPPER(f.marketplace) = 'UNKNOWN'))
        OR (b.mp <> 'US' AND UPPER(COALESCE(f.marketplace,'')) = b.mp)
      )
  ),
  agg AS (
    SELECT
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.sales,0)) ELSE 0 END),0) AS sales,
      COALESCE(SUM(CASE WHEN event_type='refund'   THEN ABS(COALESCE(b.refunds,0)) ELSE 0 END),0) AS refunds,
      COALESCE(SUM(
        COALESCE(b.reimbursements,0)
        + ABS(COALESCE(b.reversal_reimbursement,0))
        + ABS(COALESCE(b.free_replacement_refund_items,0))
      ),0) AS reimbursements,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.shipping_credits,0)) ELSE 0 END),0) AS shipping_credits,
      COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds,0))),0) AS shipping_credit_refunds,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.gift_wrap_credits,0)) ELSE 0 END),0) AS gift_wrap_credits,
      COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds,0))),0) AS gift_wrap_credit_refunds,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.promotional_rebates,0)) ELSE 0 END),0) AS promotional_rebates,
      COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds,0))),0) AS promotional_rebate_refunds,
      COALESCE(SUM(COALESCE(b.other_income,0)),0) AS other_income,
      COALESCE(SUM(ABS(COALESCE(b.liquidations,0))),0) AS liquidations,
      ABS(COALESCE(SUM(COALESCE(b.referral_fees,0)),0)) AS referral_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_fees,0))),0) AS fba_fees,
      COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees,0))),0) AS variable_closing_fees,
      COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees,0))),0) AS fixed_closing_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees,0))),0) AS fba_inbound_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee,0))),0) AS fba_inbound_convenience_fee,
      COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees,0))),0) AS fba_storage_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees,0))),0) AS fba_removal_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees,0))),0) AS fba_disposal_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees,0))),0) AS fba_long_term_storage_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees,0))),0) AS fba_customer_return_fees,
      COALESCE(SUM(ABS(COALESCE(b.digital_services_fee,0))),0) AS digital_services_fee,
      COALESCE(SUM(COALESCE(b.other_fees,0)),0) AS other_fees,
      COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee,0))),0) AS liquidations_brokerage_fee,
      COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge,0))),0) AS re_commerce_grading_charge,
      COALESCE(SUM(ABS(COALESCE(b.compensated_clawback,0))),0) AS compensated_clawback,
      COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel,0))),0) AS hrr_non_apparel,
      COALESCE(SUM(ABS(COALESCE(b.warehouse_lost,0))),0) AS warehouse_lost,
      COALESCE(SUM(ABS(COALESCE(b.warehouse_damage,0))),0) AS warehouse_damage,
      COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement,0))),0) AS reversal_reimbursement,
      COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items,0))),0) AS free_replacement_refund_items,
      COALESCE(SUM(ABS(COALESCE(b.sales_tax_collected,0))),0) AS sales_tax_collected,
      COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax,0))),0) AS marketplace_facilitator_tax,
      COALESCE(SUM(ABS(COALESCE(b.sales_tax_refunds,0))),0) AS sales_tax_refunds,
      COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds,0))),0) AS marketplace_facilitator_tax_refunds,
      COALESCE(SUM(ABS(COALESCE(b.fbm_shipping_label_fee,0))),0) AS fbm_shipping_label_fee
    FROM base b
  )
  SELECT
    a.sales, a.refunds, a.reimbursements,
    a.shipping_credits, a.shipping_credit_refunds,
    a.gift_wrap_credits, a.gift_wrap_credit_refunds,
    a.promotional_rebates, a.promotional_rebate_refunds,
    a.other_income, a.liquidations,
    a.referral_fees, a.fba_fees,
    a.variable_closing_fees, a.fixed_closing_fees,
    a.fba_inbound_fees, a.fba_inbound_convenience_fee,
    a.fba_storage_fees, a.fba_removal_fees, a.fba_disposal_fees,
    a.fba_long_term_storage_fees, a.fba_customer_return_fees,
    a.digital_services_fee, a.other_fees,
    a.liquidations_brokerage_fee, a.re_commerce_grading_charge,
    a.compensated_clawback, a.hrr_non_apparel,
    a.warehouse_lost, a.warehouse_damage,
    a.reversal_reimbursement, a.free_replacement_refund_items,
    a.sales_tax_collected, a.marketplace_facilitator_tax,
    a.sales_tax_refunds, a.marketplace_facilitator_tax_refunds,
    (a.sales + a.reimbursements + a.shipping_credits + a.gift_wrap_credits
     + a.other_income + a.liquidations) AS total_income,
    -- fbm_shipping_label_fee joins the expense total. It is a real cost Amazon
    -- bills the seller; leaving it out of the sum was the whole bug.
    (a.referral_fees + a.fba_fees
     + a.variable_closing_fees + a.fixed_closing_fees
     + a.fba_inbound_fees + a.fba_inbound_convenience_fee
     + a.fba_storage_fees + a.fba_removal_fees + a.fba_disposal_fees
     + a.fba_long_term_storage_fees + a.fba_customer_return_fees
     + a.digital_services_fee + a.other_fees
     + a.liquidations_brokerage_fee + a.re_commerce_grading_charge
     + a.compensated_clawback + a.hrr_non_apparel
     + a.fbm_shipping_label_fee) AS total_expenses,
    a.fbm_shipping_label_fee
  FROM agg a;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pl_live_summary(text, text, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_monthly_pl_breakdown(integer, text);

CREATE FUNCTION public.get_monthly_pl_breakdown(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, sales numeric, refunds numeric, reimbursements numeric, shipping_credits numeric, shipping_credit_refunds numeric, gift_wrap_credits numeric, gift_wrap_credit_refunds numeric, promotional_rebates numeric, promotional_rebate_refunds numeric, other_income numeric, liquidations numeric, intl_markets numeric, referral_fees numeric, fba_fees numeric, variable_closing_fees numeric, fixed_closing_fees numeric, fba_inbound_fees numeric, fba_storage_fees numeric, fba_removal_fees numeric, fba_disposal_fees numeric, fba_long_term_storage_fees numeric, fba_customer_return_fees numeric, digital_services_fee numeric, fba_inbound_convenience_fee numeric, other_fees numeric, liquidations_brokerage_fee numeric, re_commerce_grading_charge numeric, compensated_clawback numeric, hrr_non_apparel numeric, warehouse_lost numeric, warehouse_damage numeric, reversal_reimbursement numeric, free_replacement_refund_items numeric, sales_tax_collected numeric, marketplace_facilitator_tax numeric, sales_tax_refunds numeric, marketplace_facilitator_tax_refunds numeric, shipping_chargeback numeric, shipping_chargeback_refund numeric, restocking_fee numeric, fbm_shipping_label_fee numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mp AS (
    SELECT NULLIF(UPPER(COALESCE(p_marketplace,'')),'') AS m
  ),
  base AS (
    SELECT
      f.event_type,
      f.marketplace,
      EXTRACT(MONTH FROM f.event_date::date)::int AS event_month,
      f.sales,
      f.refunds,
      f.reimbursements,
      f.reversal_reimbursement,
      f.free_replacement_refund_items,
      f.shipping_credits,
      f.shipping_credit_refunds,
      f.gift_wrap_credits,
      f.gift_wrap_credit_refunds,
      f.promotional_rebates,
      f.promotional_rebate_refunds,
      f.other_income,
      f.liquidations,
      f.referral_fees,
      f.fba_fees,
      f.variable_closing_fees,
      f.fixed_closing_fees,
      f.fba_inbound_fees,
      f.fba_storage_fees,
      f.fba_removal_fees,
      f.fba_disposal_fees,
      f.fba_long_term_storage_fees,
      f.fba_customer_return_fees,
      f.digital_services_fee,
      f.fba_inbound_convenience_fee,
      f.other_fees,
      f.liquidations_brokerage_fee,
      f.re_commerce_grading_charge,
      f.compensated_clawback,
      f.hrr_non_apparel,
      f.warehouse_lost,
      f.warehouse_damage,
      f.sales_tax_collected,
      f.marketplace_facilitator_tax,
      f.sales_tax_refunds,
      f.marketplace_facilitator_tax_refunds,
      f.shipping_chargeback,
      f.shipping_chargeback_refund,
      f.restocking_fee,
      f.fbm_shipping_label_fee
    FROM public.financial_events_cache f
    CROSS JOIN mp
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= make_date(p_year, 1, 1)
      AND f.event_date::date <  make_date(p_year + 1, 1, 1)
      AND (
        mp.m IS NULL OR mp.m = 'ALL'
        OR (mp.m = 'US' AND (f.marketplace IS NULL OR UPPER(f.marketplace) = 'US' OR UPPER(f.marketplace) = 'UNKNOWN'))
        OR (mp.m <> 'US' AND UPPER(COALESCE(f.marketplace,'')) = mp.m)
      )
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS sales,
    COALESCE(SUM(CASE WHEN b.event_type = 'refund' THEN ABS(COALESCE(b.refunds, 0)) ELSE 0 END), 0) AS refunds,
    COALESCE(SUM(
      COALESCE(b.reimbursements, 0)
      + ABS(COALESCE(b.reversal_reimbursement, 0))
      + ABS(COALESCE(b.free_replacement_refund_items, 0))
    ), 0) AS reimbursements,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits,
    COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds, 0))), 0) AS shipping_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits,
    COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds, 0))), 0) AS gift_wrap_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates,
    COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds, 0))), 0) AS promotional_rebate_refunds,
    COALESCE(SUM(COALESCE(b.other_income, 0)), 0) AS other_income,
    COALESCE(SUM(ABS(COALESCE(b.liquidations, 0))), 0) AS liquidations,
    -- intl_markets: informational only (see MonthlyPLBreakdown.tsx
    -- `informational: true`), never added to totals.
    COALESCE(SUM(CASE WHEN NOT (COALESCE(UPPER(b.marketplace),'US') IN ('US','UNKNOWN')) AND b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS intl_markets,
    -- referral_fees: net the signed value first, then take the absolute
    -- value of the total (see 20260814100000 migration).
    ABS(COALESCE(SUM(COALESCE(b.referral_fees, 0)), 0)) AS referral_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_fees, 0))), 0) AS fba_fees,
    COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees, 0))), 0) AS variable_closing_fees,
    COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees, 0))), 0) AS fixed_closing_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees, 0))), 0) AS fba_inbound_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees, 0))), 0) AS fba_storage_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees, 0))), 0) AS fba_removal_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees, 0))), 0) AS fba_disposal_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees, 0))), 0) AS fba_long_term_storage_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees, 0))), 0) AS fba_customer_return_fees,
    COALESCE(SUM(ABS(COALESCE(b.digital_services_fee, 0))), 0) AS digital_services_fee,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee, 0))), 0) AS fba_inbound_convenience_fee,
    COALESCE(SUM(COALESCE(b.other_fees, 0)), 0) AS other_fees,
    COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee, 0))), 0) AS liquidations_brokerage_fee,
    COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge, 0))), 0) AS re_commerce_grading_charge,
    COALESCE(SUM(ABS(COALESCE(b.compensated_clawback, 0))), 0) AS compensated_clawback,
    COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel, 0))), 0) AS hrr_non_apparel,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_lost, 0))), 0) AS warehouse_lost,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_damage, 0))), 0) AS warehouse_damage,
    COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement, 0))), 0) AS reversal_reimbursement,
    COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items, 0))), 0) AS free_replacement_refund_items,
    COALESCE(SUM(ABS(COALESCE(b.sales_tax_collected, 0))), 0) AS sales_tax_collected,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax, 0))), 0) AS marketplace_facilitator_tax,
    COALESCE(SUM(ABS(COALESCE(b.sales_tax_refunds, 0))), 0) AS sales_tax_refunds,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds, 0))), 0) AS marketplace_facilitator_tax_refunds,
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback, 0))), 0) AS shipping_chargeback,
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback_refund, 0))), 0) AS shipping_chargeback_refund,
    COALESCE(SUM(ABS(COALESCE(b.restocking_fee, 0))), 0) AS restocking_fee,
    COALESCE(SUM(ABS(COALESCE(b.fbm_shipping_label_fee, 0))), 0) AS fbm_shipping_label_fee
  FROM months
  LEFT JOIN base b ON b.event_month = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_pl_breakdown(integer, text) TO authenticated, service_role;

DO $$
DECLARE v_total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(ABS(COALESCE(fbm_shipping_label_fee, 0))), 0)
    INTO v_total
    FROM public.financial_events_cache
   WHERE event_date::date >= make_date(EXTRACT(YEAR FROM now())::int, 1, 1);
  RAISE NOTICE 'fbm_shipping_label_fee now reaches the P&L. % held in the cache for the current year, previously invisible.', to_char(v_total, 'FM999,999,990.00');
  RAISE NOTICE 'Read-path change only -- no reparse needed. Reload the P&L to see it.';
END $$;
