-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: B0CKJNCZLY sold 6 units on 114-0628939-5256223 ($97.20) and 1 unit
-- on 111-6724559-6861005 ($16.20), and the app shows $15.90 of fees against
-- $113.40. A $16.20 item carries roughly $2.43 referral plus an FBA fee, so
-- seven units should cost far more than $15.90 -- the shape of fees charged
-- per ORDER instead of per UNIT.
-- Check these two rows, then how widespread multi-unit orders are.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the two orders ==';
  FOR r IN SELECT order_id, quantity, sold_price, item_price, total_sale_amount,
                  referral_fee, fba_fee, closing_fee, total_fees, fees_source,
                  unit_cost, unit_cost_at_sale, roi, to_char(order_date, 'YYYY-MM-DD') AS d
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id IN ('114-0628939-5256223', '111-6724559-6861005') LOOP
    RAISE NOTICE '  % (%) | qty % | sold % | item % | total sale %',
      r.order_id, r.d, r.quantity, r.sold_price, r.item_price, r.total_sale_amount;
    RAISE NOTICE '      referral % | fba % | closing % | TOTAL FEES % | source % | cost %/% | roi %',
      r.referral_fee, r.fba_fee, r.closing_fee, r.total_fees, r.fees_source,
      r.unit_cost, r.unit_cost_at_sale, r.roi;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== per-unit implied fee vs quantity, this ASIN (2026) ==';
  FOR r IN SELECT quantity, count(*) AS orders,
                  round(avg(COALESCE(total_fees,0))::numeric, 2) AS avg_total_fees,
                  round(avg(COALESCE(total_fees,0) / NULLIF(quantity,0))::numeric, 2) AS avg_fee_per_unit,
                  round(avg(COALESCE(sold_price,0))::numeric, 2) AS avg_sold_price
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
             AND COALESCE(is_cancelled,false) = false
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  qty % : % orders | avg total fees % | avg per unit % | avg sold price %',
      r.quantity, r.orders, r.avg_total_fees, r.avg_fee_per_unit, r.avg_sold_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== account-wide: does the fee per unit fall as quantity rises? ==';
  FOR r IN SELECT CASE WHEN quantity = 1 THEN 'a 1 unit' WHEN quantity = 2 THEN 'b 2 units'
                       WHEN quantity BETWEEN 3 AND 5 THEN 'c 3-5 units' ELSE 'd 6+ units' END AS bucket,
                  count(*) AS orders,
                  round(avg(COALESCE(total_fees,0))::numeric, 2) AS avg_fees,
                  round(avg(COALESCE(total_fees,0) / NULLIF(quantity,0))::numeric, 2) AS avg_fee_per_unit,
                  round(avg(COALESCE(sold_price,0))::numeric, 2) AS avg_unit_price,
                  round(avg(100.0 * COALESCE(total_fees,0) / NULLIF(COALESCE(total_sale_amount, sold_price * quantity),0))::numeric, 1) AS fees_pct_of_sale
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false
             AND COALESCE(total_fees,0) > 0
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : % orders | avg fees % | per unit % | unit price % | fees are % pct of the sale',
      r.bucket, r.orders, r.avg_fees, r.avg_fee_per_unit, r.avg_unit_price, r.fees_pct_of_sale;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how much money is in multi-unit orders? ==';
  FOR r IN SELECT count(*) AS multi_orders, sum(quantity) AS units,
                  round(sum(COALESCE(total_sale_amount, sold_price * quantity, 0))::numeric, 2) AS revenue,
                  round(sum(COALESCE(total_fees,0))::numeric, 2) AS fees_booked
           FROM public.sales_orders
           WHERE user_id = v_uid AND quantity > 1 AND order_date >= '2026-01-01'
             AND COALESCE(is_cancelled,false) = false LOOP
    RAISE NOTICE '  % orders, % units, revenue %, fees booked %', r.multi_orders, r.units, r.revenue, r.fees_booked;
  END LOOP;
END
$p$;
