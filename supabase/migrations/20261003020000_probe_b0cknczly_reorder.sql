-- READ-ONLY PROBE. Should B0CKJNCZLY be reordered? The extension card says
-- 79 units, ROI 48% gross and 29% after a 17.5% return rate.
--
-- Checks worth making before committing cash:
--   * is the 17.5% return rate recent or historical -- a rate that is falling
--     and a rate that is rising argue opposite ways;
--   * does the per-unit economics hold up on 2026 orders, including refunds
--     (yesterday's band analysis excluded refunded orders, because they often
--     carry zeroed fees, which is exactly why its return rates were far too low);
--   * is velocity steady enough to justify 51 days of coverage;
--   * what the cost and price history look like, since 48% ROI assumes both.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== return stats as the extension sees them ==';
  FOR r IN SELECT * FROM public.asin_return_stats
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' LOOP
    RAISE NOTICE '  %', to_jsonb(r);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== returns by month, from sales_orders (is the rate rising or falling?) ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  sum(quantity) AS units_sold,
                  sum(COALESCE(refund_quantity, 0)) AS units_returned,
                  round((100.0 * sum(COALESCE(refund_quantity, 0)) / NULLIF(sum(quantity), 0))::numeric, 1) AS rate_pct
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false
             AND order_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % | % sold | % returned | % pct', r.mon, r.units_sold, r.units_returned, r.rate_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2026 economics, refunds INCLUDED ==';
  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units,
                  round(sum(COALESCE(total_sale_amount, sold_price * quantity))::numeric, 2) AS revenue,
                  round(sum(COALESCE(total_fees, 0))::numeric, 2) AS fees,
                  round(sum(COALESCE(shipping_label_fee, 0))::numeric, 2) AS labels,
                  round(sum(COALESCE(unit_cost_at_sale, unit_cost, 0) * quantity)::numeric, 2) AS cogs,
                  round(sum(COALESCE(refund_amount, 0))::numeric, 2) AS refunded,
                  round(avg(COALESCE(unit_cost_at_sale, unit_cost))::numeric, 2) AS avg_unit_cost,
                  round(avg(sold_price)::numeric, 2) AS avg_price
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false AND order_date >= '2026-01-01' LOOP
    RAISE NOTICE '  % orders, % units | revenue % | fees % | labels % | cogs % | refunded %',
      r.orders, r.units, r.revenue, r.fees, r.labels, r.cogs, r.refunded;
    RAISE NOTICE '  avg price % | avg unit cost %', r.avg_price, r.avg_unit_cost;
    RAISE NOTICE '  NET after fees, labels, cogs and refunds: %',
      round((r.revenue - r.fees - r.labels - r.cogs - r.refunded)::numeric, 2);
    RAISE NOTICE '  per unit: %', round(((r.revenue - r.fees - r.labels - r.cogs - r.refunded) / NULLIF(r.units, 0))::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== velocity by month ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  sum(quantity) AS units, round(avg(sold_price)::numeric, 2) AS avg_price
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false AND order_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % | % units | avg price %', r.mon, r.units, r.avg_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== current state: stock, cost on record, repricer bounds ==';
  FOR r IN SELECT i.sku, i.listing_status, i.available, i.inbound, i.reserved,
                  i.cost, i.my_price, i.min_price, i.max_price
           FROM public.inventory i
           WHERE i.user_id = v_uid AND i.asin = 'B0CKJNCZLY' LOOP
    RAISE NOTICE '  % | % | avail % inbound % reserved % | cost % | price % | bounds %/%',
      r.sku, r.listing_status, r.available, r.inbound, r.reserved, r.cost, r.my_price, r.min_price, r.max_price;
  END LOOP;

  FOR r IN SELECT unit_cost, source, updated_at FROM public.asin_cog_for_repricer
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' LOOP
    RAISE NOTICE '  COG on record: % (% , %)', r.unit_cost, r.source, r.updated_at;
  END LOOP;
END
$p$;
