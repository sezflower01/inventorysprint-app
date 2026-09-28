-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- To show "profit after returns" honestly we need what a return COSTS, not
-- just how many came back. Check what sales_orders records on refunded rows:
-- refund_amount, and whether fees were given back.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT count(*) AS refunded_rows,
                  count(*) FILTER (WHERE COALESCE(refund_amount,0) <> 0) AS with_amount,
                  round(avg(NULLIF(refund_amount,0))::numeric, 2) AS avg_refund_amount,
                  round(avg(NULLIF(sold_price,0))::numeric, 2) AS avg_sold_price,
                  round(avg(NULLIF(total_fees,0))::numeric, 2) AS avg_fees
           FROM public.sales_orders
           WHERE user_id = v_uid AND COALESCE(refund_quantity,0) > 0 AND order_date >= '2026-01-01' LOOP
    RAISE NOTICE 'refunded rows 2026: % | with a refund amount % | avg refund % | avg sold price % | avg fees %',
      r.refunded_rows, r.with_amount, r.avg_refund_amount, r.avg_sold_price, r.avg_fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sign and size of refund_amount (is it a credit or a cost?) ==';
  FOR r IN SELECT CASE WHEN refund_amount > 0 THEN 'positive' WHEN refund_amount < 0 THEN 'negative' ELSE 'zero' END AS sign,
                  count(*) AS rows, round(avg(refund_amount)::numeric,2) AS avg_val,
                  round(min(refund_amount)::numeric,2) AS min_val, round(max(refund_amount)::numeric,2) AS max_val
           FROM public.sales_orders
           WHERE user_id = v_uid AND COALESCE(refund_quantity,0) > 0 AND order_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % : % rows | avg % | range % .. %', r.sign, r.rows, r.avg_val, r.min_val, r.max_val;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== per-ASIN example: what a return costs against what a sale earns ==';
  FOR r IN
    WITH per AS (
      SELECT asin,
             sum(quantity) AS units,
             sum(COALESCE(refund_quantity,0)) AS returned,
             sum(COALESCE(total_sale_amount, sold_price * quantity, 0)) AS revenue,
             sum(COALESCE(total_fees,0)) AS fees,
             sum(COALESCE(refund_amount,0)) AS refunds,
             sum(COALESCE(unit_cost_at_sale, unit_cost, 0) * quantity) AS cogs
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(is_cancelled,false) = false AND order_date >= '2026-01-01'
      GROUP BY asin)
    SELECT asin, units, returned, round(revenue::numeric,2) AS revenue, round(fees::numeric,2) AS fees,
           round(refunds::numeric,2) AS refunds, round(cogs::numeric,2) AS cogs,
           round(((revenue - fees - refunds - cogs) / NULLIF(units,0))::numeric, 2) AS net_per_unit,
           round((100.0 * returned / NULLIF(units,0))::numeric, 1) AS return_pct
    FROM per WHERE returned > 0 AND units >= 20 ORDER BY returned DESC LIMIT 8 LOOP
    RAISE NOTICE '  % | % units, % returned (% pct) | revenue % fees % refunds % cogs % | net/unit %',
      r.asin, r.units, r.returned, r.return_pct, r.revenue, r.fees, r.refunds, r.cogs, r.net_per_unit;
  END LOOP;
END
$p$;
