-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- How many multi-unit orders carry single-unit fees?
--
-- Detector: referral alone is ~15% of the LINE total on Amazon, and the FBA
-- fulfilment fee sits on top, so a correct row lands near 35-40% (measured:
-- 40.6% on 6+ unit orders). Anything under 15% of its own line total cannot be
-- a real total -- that is a per-unit figure left unmultiplied.
-- Conservative on purpose: it will miss some bad rows rather than misclassify
-- a genuinely cheap one.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(sum(COALESCE(total_sale_amount, sold_price * quantity, 0))::numeric, 2) AS revenue,
           round(sum(COALESCE(total_fees,0))::numeric, 2) AS fees_booked,
           round(sum(COALESCE(total_fees,0) * (quantity - 1))::numeric, 2) AS fees_missing_est,
           min(order_date) AS first, max(order_date) AS last
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND quantity > 1
      AND COALESCE(is_cancelled, false) = false
      AND COALESCE(total_fees, 0) > 0
      AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
      AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price * quantity)
  LOOP
    RAISE NOTICE 'under-billed multi-unit orders: % (% units) | revenue % | fees booked % | fees missing approx % | % .. %',
      r.orders, r.units, r.revenue, r.fees_booked, r.fees_missing_est, r.first, r.last;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== by fee source ==';
  FOR r IN
    SELECT COALESCE(fees_source, '(none)') AS src, count(*) AS orders, sum(quantity) AS units,
           round(sum(COALESCE(total_fees,0) * (quantity - 1))::numeric, 2) AS fees_missing_est
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity > 1 AND COALESCE(is_cancelled,false) = false
      AND COALESCE(total_fees,0) > 0
      AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
      AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price * quantity)
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % : % orders, % units, approx % of fees missing', r.src, r.orders, r.units, r.fees_missing_est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the worst ones ==';
  FOR r IN
    SELECT order_id, asin, quantity, sold_price,
           round(COALESCE(total_sale_amount, sold_price * quantity)::numeric,2) AS line_total,
           total_fees, fees_source, roi, to_char(order_date,'MM-DD') AS d
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity > 1 AND COALESCE(is_cancelled,false) = false
      AND COALESCE(total_fees,0) > 0
      AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
      AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price * quantity)
    ORDER BY quantity DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % x% @ % | line % | fees % (%) | roi % | %',
      r.order_id, r.asin, r.quantity, r.sold_price, r.line_total, r.total_fees, r.fees_source, r.roi, r.d;
  END LOOP;
END
$p$;
