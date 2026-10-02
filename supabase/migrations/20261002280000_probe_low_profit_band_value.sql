-- READ-ONLY PROBE. Is the $1-4.99-per-unit profit band worth receiving as
-- leads, judged on this seller's own realised 2026 sales rather than on general
-- argument?
--
-- Per-unit profit is computed, not read: sold_price minus the order's fees and
-- shipping label spread over its units, minus the cost locked at sale. Fees and
-- label fees are ORDER-level totals (that was the multi-unit bug fixed on
-- 2026-09-29), so they must be divided by quantity before comparing with a
-- per-unit price. The first section checks that formula against the app's own
-- stored roi on real rows before any conclusion is drawn from it.
--
-- Returns matter more than margin here: a single return on a $2-profit unit
-- erases several good sales, and refund_quantity / refund_amount on
-- sales_orders record them per order.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _o ON COMMIT DROP AS
  SELECT
    order_id, asin, quantity, fulfillment_channel, order_date,
    COALESCE(total_sale_amount, sold_price * quantity) AS revenue,
    COALESCE(total_fees, 0) AS fees,
    COALESCE(shipping_label_fee, 0) AS label_fee,
    COALESCE(unit_cost_at_sale, unit_cost) AS unit_cost,
    COALESCE(refund_quantity, 0) AS refund_qty,
    COALESCE(refund_amount, 0) AS refund_amt,
    roi AS stored_roi,
    (COALESCE(total_sale_amount, sold_price * quantity)
      - COALESCE(total_fees, 0)
      - COALESCE(shipping_label_fee, 0)
      - COALESCE(unit_cost_at_sale, unit_cost, 0) * quantity) AS order_profit
  FROM public.sales_orders
  WHERE user_id = v_uid
    AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false
    AND quantity > 0
    AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
    AND COALESCE(unit_cost_at_sale, unit_cost, 0) > 0
    AND COALESCE(total_fees, 0) > 0;

  RAISE NOTICE '== formula check: computed vs the app''s stored ROI ==';
  FOR r IN SELECT order_id, quantity, revenue, fees, label_fee, unit_cost,
                  round((order_profit / quantity)::numeric, 2) AS unit_profit,
                  round((100 * order_profit / (unit_cost * quantity))::numeric, 1) AS computed_roi,
                  round(stored_roi::numeric, 1) AS stored_roi
           FROM _o WHERE stored_roi IS NOT NULL ORDER BY random() LIMIT 6 LOOP
    RAISE NOTICE '  % | qty % | rev % fees % label % cost % | unit profit % | roi computed % vs stored %',
      r.order_id, r.quantity, r.revenue, r.fees, r.label_fee, r.unit_cost,
      r.unit_profit, r.computed_roi, r.stored_roi;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2026 by per-unit profit band ==';
  FOR r IN
    WITH b AS (
      SELECT CASE
               WHEN order_profit / quantity < 0 THEN 'a. loss'
               WHEN order_profit / quantity < 1 THEN 'b. $0-0.99'
               WHEN order_profit / quantity < 5 THEN 'c. $1-4.99'
               WHEN order_profit / quantity < 10 THEN 'd. $5-9.99'
               ELSE 'e. $10+'
             END AS band,
             quantity, revenue, order_profit, unit_cost, refund_qty, refund_amt, label_fee
      FROM _o)
    SELECT band,
           count(*) AS orders,
           sum(quantity) AS units,
           round(sum(revenue)::numeric, 0) AS revenue,
           round(sum(order_profit)::numeric, 0) AS profit,
           round((100.0 * sum(order_profit) / NULLIF(SUM(sum(order_profit)) OVER (), 0))::numeric, 1) AS pct_of_profit,
           round(avg(100 * order_profit / NULLIF(unit_cost * quantity, 0))::numeric, 0) AS avg_roi_pct,
           round((100.0 * sum(refund_qty) / NULLIF(sum(quantity), 0))::numeric, 1) AS return_rate_pct,
           round(sum(refund_amt)::numeric, 0) AS refunded
    FROM b GROUP BY band ORDER BY band
  LOOP
    RAISE NOTICE '  % | % orders, % units | revenue % | profit % (% pct of all profit) | avg ROI % pct | returns % pct (% refunded)',
      r.band, r.orders, r.units, r.revenue, r.profit, r.pct_of_profit, r.avg_roi_pct, r.return_rate_pct, r.refunded;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the $1-4.99 band, split by channel ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel, '(unknown)') AS ch,
           count(*) AS orders, sum(quantity) AS units,
           round(sum(order_profit)::numeric, 0) AS profit,
           round(avg(label_fee)::numeric, 2) AS avg_label_fee,
           round((100.0 * sum(refund_qty) / NULLIF(sum(quantity), 0))::numeric, 1) AS return_rate_pct
    FROM _o
    WHERE order_profit / quantity >= 1 AND order_profit / quantity < 5
    GROUP BY 1 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '  % | % orders, % units | profit % | avg label fee % | returns % pct',
      r.ch, r.orders, r.units, r.profit, r.avg_label_fee, r.return_rate_pct;
  END LOOP;
END
$p$;
