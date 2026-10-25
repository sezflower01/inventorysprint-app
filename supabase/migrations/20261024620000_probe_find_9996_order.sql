-- READ-ONLY. Find the order behind "5 units, $99.96" where Amazon shows
-- 5 x $24.99 = $124.95.
--
-- 99.96 = 4 x 24.99 exactly -- one unit short, not a halving. The other
-- reading is 5 x 19.992. Both are testable against what is stored, so the
-- order does not need to be supplied by hand.
DO $p$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== exact match: total_sale_amount 99.96 ==';
  FOR r IN
    SELECT order_id, asin, sku, quantity,
           round(sold_price,4) AS unit_px, round(total_sale_amount,2) AS total,
           CASE WHEN estimated_price IS NULL THEN 'NULL'
                ELSE round(estimated_price,2)::text END AS est,
           COALESCE(price_source,'(null)') AS src,
           COALESCE(price_confidence,'(null)') AS conf,
           COALESCE(order_status,'(null)') AS st,
           order_date, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND round(total_sale_amount,2) = 99.96
    ORDER BY order_date DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | q% | unit % | total % | est % | % | % | % | %',
      r.order_id, r.asin, r.quantity, r.unit_px, r.total, r.est,
      rpad(r.src,20), rpad(r.conf,10), r.st, r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none with total exactly 99.96'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== near match: quantity 5 at a 24.99-ish unit price, last 60d ==';
  FOR r IN
    SELECT order_id, asin, quantity,
           round(sold_price,4) AS unit_px, round(total_sale_amount,2) AS total,
           CASE WHEN estimated_price IS NULL THEN 'NULL'
                ELSE round(estimated_price,2)::text END AS est,
           COALESCE(price_source,'(null)') AS src, COALESCE(order_status,'(null)') AS st,
           order_date
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity = 5
      AND order_date >= current_date - 60
    ORDER BY order_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % | q% | unit % | total % | est % | % | % | %',
      r.order_id, r.asin, r.quantity, r.unit_px, r.total, r.est,
      rpad(r.src,20), r.st, r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no quantity-5 rows in 60 days'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the B0H854F7VF family (the $24.99 soap), last 30d ==';
  FOR r IN
    SELECT order_id, quantity, round(sold_price,4) AS unit_px,
           round(total_sale_amount,2) AS total, COALESCE(order_status,'(null)') AS st,
           COALESCE(price_source,'(null)') AS src, order_date
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B0H854F7VF' AND order_date >= current_date - 30
    ORDER BY order_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | q% | unit % | total % | % | % | %',
      r.order_id, r.quantity, r.unit_px, r.total, rpad(r.st,10), rpad(r.src,20), r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ PATTERN: revenue short by exactly one unit ############';
  RAISE NOTICE '   i.e. total_sale_amount = sold_price * (quantity - 1)';
  FOR r IN
    SELECT COALESCE(order_status,'(null)') AS st, count(*) AS n
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 30
      AND quantity > 1 AND sold_price > 0 AND total_sale_amount > 0
      AND abs(total_sale_amount - sold_price * (quantity - 1)) < 0.011
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.st,12), r.n; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   ZERO rows are short by exactly one unit'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   for comparison, rows where total = sold_price * quantity (correct):';
  SELECT count(*) INTO v_n FROM public.sales_orders
  WHERE user_id = v_uid AND order_date >= current_date - 30
    AND quantity > 1 AND sold_price > 0 AND total_sale_amount > 0
    AND abs(total_sale_amount - sold_price * quantity) < 0.011;
  RAISE NOTICE '   % rows consistent', v_n;
END
$p$;
