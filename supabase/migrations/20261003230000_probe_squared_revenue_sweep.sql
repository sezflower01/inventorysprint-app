-- READ-ONLY PROBE. How many orders have squared revenue?
--
-- The shape, from the live case 114-1602840-1879415 (5 x $19.50 on Amazon):
--   sold_price         $97.50   <- the LINE total, in a per-unit field
--   total_sale_amount $487.50   <- that line total multiplied by quantity again
--
-- Detected by comparison, not by guesswork: for each ASIN, take the median unit
-- price from its SINGLE-unit orders -- which cannot carry this fault, because at
-- quantity 1 a line total and a unit price are the same number -- and flag
-- multi-unit rows whose sold_price sits near that median TIMES quantity.
--
-- Writers already eliminated, each of which divides correctly:
--   enrich-pending-orders        unitPrice = itemPrice / qty
--   reconcile-pending-prices     perUnit
--   fetch-live-orders (both)     itemPriceUSD / quantity
-- The arithmetic that reproduces 487.50 exactly is repair-pending-prices:
--   unitPrice = inventory price OR order.estimated_price;  lineTotal = unitPrice * qty
-- which is correct only if estimated_price is per-unit. If a line total ever
-- reaches estimated_price, this is the result.

DO $p$
DECLARE v_uid uuid; r record; n int; v_total numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _unit ON COMMIT DROP AS
  SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY sold_price) AS median_unit
  FROM public.sales_orders
  WHERE user_id = v_uid AND quantity = 1 AND COALESCE(sold_price, 0) > 0
    AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    AND order_date >= '2025-01-01'
  GROUP BY asin;

  CREATE TEMP TABLE _sq ON COMMIT DROP AS
  SELECT s.order_id, s.order_date, s.asin, s.quantity, s.sold_price,
         s.total_sale_amount, s.price_source, s.fulfillment_channel,
         u.median_unit,
         round((s.sold_price / NULLIF(u.median_unit, 0))::numeric, 2) AS ratio_to_unit,
         round((s.total_sale_amount - u.median_unit * s.quantity)::numeric, 2) AS overstated_by
  FROM public.sales_orders s
  JOIN _unit u ON u.asin = s.asin
  WHERE s.user_id = v_uid AND s.quantity > 1
    AND COALESCE(s.is_cancelled, false) = false AND s.order_id NOT LIKE '%-REFUND'
    AND COALESCE(s.sold_price, 0) > 0 AND u.median_unit > 0
    -- sold_price near the unit price TIMES quantity, i.e. a line total in a unit field
    AND s.sold_price BETWEEN u.median_unit * s.quantity * 0.85 AND u.median_unit * s.quantity * 1.15
    AND s.quantity >= 2;

  SELECT count(*), COALESCE(sum(overstated_by), 0) INTO n, v_total FROM _sq;
  RAISE NOTICE 'orders with squared revenue: % | revenue overstated by $%', n, round(v_total, 2);

  RAISE NOTICE '';
  RAISE NOTICE '== by month ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  count(*) AS orders, round(sum(overstated_by)::numeric, 2) AS overstated
           FROM _sq GROUP BY 1 ORDER BY 1 DESC LIMIT 14 LOOP
    RAISE NOTICE '  % | % order(s) | $% overstated', r.mon, r.orders, r.overstated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== by price_source: who wrote them ==';
  FOR r IN SELECT COALESCE(price_source, '(none)') AS src, count(*) AS orders,
                  round(sum(overstated_by)::numeric, 2) AS overstated
           FROM _sq GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % | % order(s) | $%', r.src, r.orders, r.overstated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the worst, with what the row SHOULD say ==';
  FOR r IN SELECT order_id, order_date, asin, quantity, sold_price, total_sale_amount,
                  median_unit, overstated_by, price_source, fulfillment_channel
           FROM _sq ORDER BY overstated_by DESC LIMIT 15 LOOP
    RAISE NOTICE '  % | % | % | qty % | stored $%/unit, total $% | should be $%/unit, total $% | over by $% | % | %',
      r.order_id, r.order_date, r.asin, r.quantity, r.sold_price, r.total_sale_amount,
      r.median_unit, round((r.median_unit * r.quantity)::numeric, 2), r.overstated_by,
      COALESCE(r.price_source, ''), COALESCE(r.fulfillment_channel, '');
  END LOOP;
END
$p$;
