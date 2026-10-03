-- get_asin_profit(asin, start, end) — THE definition of per-ASIN profit.
--
-- WHY A FUNCTION AND NOT A QUERY IN THE PAGE. Working out what one ASIN earned
-- took four wrong answers on 2026-10-03, every one of them from a plausible
-- query over the same table:
--
--   -$2,369  counted -REFUND rows as sales (they carry negative sold_price)
--             and $0-price rows as sales that still paid full fees
--     $119   subtracted the GROSS refund from a profit whose fees were already
--             deducted -- charging the fees twice and ignoring both the referral
--             credit and the COGS recovered on a resellable return
--   $1,370   correct
--     4.6%   the $119 figure expressed as ROI, which read as "stop buying this"
--             when the product actually returns 53%
--
-- So the arithmetic lives here, once, and every surface calls it. Same reason
-- plModel.ts and refundMath.ts exist: the bug those files were written for was
-- two reports each carrying their own formula.
--
-- WHY THE SALES REPORT AND NOT THE P&L. The P&L reads financial_events_cache,
-- Amazon's settlement data, whose rows do NOT carry an asin -- verified empty
-- for B0CKJNCZLY across all of 2026. Per-ASIN profit is therefore impossible
-- from the P&L's source and natural from sales_orders, which is what the Sales
-- Report already shows.
--
-- THE REFUND RULE, which is the part everyone gets wrong. A refund does not
-- cost the refunded price. Amazon credits the referral fee back and keeps the
-- FBA fee, retaining min($5, 20% x referral) in administration. So one returned
-- unit costs:  FBA fee + admin retention  (+ the COG, only if the unit cannot
-- be resold). This seller's returns come back sellable almost always -- 2
-- unsellable removals against 94 returns in 2026 -- so the resold case is the
-- default and the written-off case is returned alongside it, never instead.
--
-- RETURNED UNITS LIVE IN TWO PLACES and neither is complete: refund_quantity on
-- the parent order, and separate rows whose order_id ends '-REFUND'. For
-- B0CKJNCZLY 2026 that is 50 and 47, overlapping on 3, so 94 -- while each
-- source alone says 50 or 47, and asin_return_stats says 17.5% because its
-- window is 12 months rather than the range asked for.

CREATE OR REPLACE FUNCTION public.get_asin_profit(
  p_asin text,
  p_start date,
  p_end date
)
RETURNS TABLE (
  asin                text,
  units_sold          integer,
  orders              integer,
  revenue             numeric,
  fees                numeric,
  label_fees          numeric,
  cogs                numeric,
  gross_profit        numeric,
  gross_per_unit      numeric,
  gross_roi_pct       numeric,
  units_returned      integer,
  return_rate_pct     numeric,
  return_cost         numeric,
  net_profit          numeric,
  net_per_unit        numeric,
  net_roi_pct         numeric,
  net_if_written_off  numeric,
  roi_if_written_off  numeric,
  avg_sale_price      numeric,
  avg_unit_cost       numeric,
  excluded_zero_rows  integer,
  excluded_zero_fees  numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_asin text := upper(btrim(p_asin));
  v_ret_parent int;
  v_ret_rows int;
  v_ret_both int;
  v_ret_total int;
  v_fba_unit numeric;
  v_referral_unit numeric;
  v_admin numeric;
  v_cog_record numeric;
BEGIN
  IF v_uid IS NULL OR v_asin = '' THEN RETURN; END IF;

  -- Returned units, from both records, deduplicated.
  SELECT COALESCE(sum(s.refund_quantity), 0) INTO v_ret_parent
  FROM sales_orders s
  WHERE s.user_id = v_uid AND s.asin = v_asin
    AND s.order_date >= p_start AND s.order_date <= p_end
    AND COALESCE(s.is_cancelled, false) = false
    AND s.order_id NOT LIKE '%-REFUND';

  SELECT COALESCE(sum(GREATEST(COALESCE(s.refund_quantity, 0), s.quantity)), 0) INTO v_ret_rows
  FROM sales_orders s
  WHERE s.user_id = v_uid AND s.asin = v_asin
    AND s.order_date >= p_start AND s.order_date <= p_end
    AND COALESCE(s.is_cancelled, false) = false
    AND s.order_id LIKE '%-REFUND';

  SELECT COALESCE(sum(p.refund_quantity), 0) INTO v_ret_both
  FROM sales_orders rr
  JOIN sales_orders p
    ON p.user_id = rr.user_id AND p.order_id = replace(rr.order_id, '-REFUND', '')
  WHERE rr.user_id = v_uid AND rr.asin = v_asin
    AND rr.order_date >= p_start AND rr.order_date <= p_end
    AND rr.order_id LIKE '%-REFUND'
    AND COALESCE(p.refund_quantity, 0) > 0;

  v_ret_total := GREATEST(0, v_ret_parent + v_ret_rows - v_ret_both);

  -- Per-unit fee components, measured on this ASIN's own orders in range. The
  -- referral share is what Amazon credits back on a refund; the FBA share is
  -- what it keeps, and is therefore the cost of the return.
  SELECT COALESCE(avg(s.fba_fee / NULLIF(s.quantity, 0)), 0),
         COALESCE(avg(s.referral_fee / NULLIF(s.quantity, 0)), 0)
    INTO v_fba_unit, v_referral_unit
  FROM sales_orders s
  WHERE s.user_id = v_uid AND s.asin = v_asin
    AND s.order_date >= p_start AND s.order_date <= p_end
    AND COALESCE(s.is_cancelled, false) = false
    AND s.order_id NOT LIKE '%-REFUND'
    AND COALESCE(s.fba_fee, 0) > 0;

  v_admin := LEAST(5.00, 0.20 * v_referral_unit);

  SELECT c.unit_cost INTO v_cog_record
  FROM asin_cog_for_repricer c
  WHERE c.user_id = v_uid AND c.asin = v_asin;

  RETURN QUERY
  WITH clean AS (
    -- Real sales only: a -REFUND row is a refund record, and a row priced at or
    -- below zero is the price-resolver zero-fallback, not a giveaway.
    SELECT s.quantity,
           COALESCE(s.total_sale_amount, s.sold_price * s.quantity) AS rev,
           COALESCE(s.total_fees, 0) AS fee,
           COALESCE(s.shipping_label_fee, 0) AS label,
           COALESCE(s.unit_cost_at_sale, s.unit_cost, v_cog_record, 0) AS cost
    FROM sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND s.order_date >= p_start AND s.order_date <= p_end
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
  ), excluded AS (
    SELECT count(*)::int AS n, COALESCE(sum(COALESCE(s.total_fees, 0)), 0) AS f
    FROM sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND s.order_date >= p_start AND s.order_date <= p_end
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) <= 0
  ), agg AS (
    SELECT COALESCE(sum(c.quantity), 0)::int AS units,
           count(*)::int AS ord,
           COALESCE(sum(c.rev), 0) AS rev,
           COALESCE(sum(c.fee), 0) AS fee,
           COALESCE(sum(c.label), 0) AS label,
           COALESCE(sum(c.cost * c.quantity), 0) AS cogs
    FROM clean c
  )
  SELECT
    v_asin,
    a.units,
    a.ord,
    round(a.rev, 2),
    round(a.fee, 2),
    round(a.label, 2),
    round(a.cogs, 2),
    round(a.rev - a.fee - a.label - a.cogs, 2),
    round((a.rev - a.fee - a.label - a.cogs) / NULLIF(a.units, 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs) / NULLIF(a.cogs, 0), 1),
    v_ret_total,
    round(100.0 * v_ret_total / NULLIF(a.units, 0), 1),
    round(v_ret_total * (v_fba_unit + v_admin), 2),
    round(a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin), 2),
    round((a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)) / NULLIF(a.units, 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)) / NULLIF(a.cogs, 0), 1),
    -- the pessimistic branch: every returned unit written off as well
    round(a.rev - a.fee - a.label - a.cogs
          - v_ret_total * (v_fba_unit + v_admin)
          - v_ret_total * COALESCE(v_cog_record, a.cogs / NULLIF(a.units, 0), 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs
          - v_ret_total * (v_fba_unit + v_admin)
          - v_ret_total * COALESCE(v_cog_record, a.cogs / NULLIF(a.units, 0), 0)) / NULLIF(a.cogs, 0), 1),
    round(a.rev / NULLIF(a.units, 0), 2),
    round(a.cogs / NULLIF(a.units, 0), 2),
    e.n,
    round(e.f, 2)
  FROM agg a CROSS JOIN excluded e;
END
$fn$;

COMMENT ON FUNCTION public.get_asin_profit(text, date, date) IS
  'Per-ASIN profit for a date range, from sales_orders. THE single definition: excludes -REFUND rows and zero-priced rows, counts returned units from both records deduplicated, and costs a return as FBA fee + min($5,20%% referral) rather than the refunded price. Returns both the resold and written-off branches. Do not reimplement this arithmetic in a page.';

GRANT EXECUTE ON FUNCTION public.get_asin_profit(text, date, date) TO authenticated;
