DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN SELECT order_id, asin, quantity, sold_price, item_price, estimated_price,
                  round(COALESCE(total_sale_amount, sold_price*quantity)::numeric,2) AS line_total,
                  total_fees, COALESCE(fees_source,'(none)') AS src, to_char(order_date,'YYYY-MM') AS m
           FROM public.sales_orders
           WHERE user_id = v_uid AND quantity > 1 AND COALESCE(is_cancelled,false) = false
             AND COALESCE(total_fees,0) > 0 AND COALESCE(total_sale_amount, sold_price*quantity,0) > 0
             AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price*quantity)
             AND COALESCE(fees_source,'') <> 'financial_events'
           ORDER BY order_date DESC LIMIT 15 LOOP
    RAISE NOTICE '% | % x% | sold % est % | line % | fees % (%) | %', r.order_id, r.asin, r.quantity, r.sold_price, r.estimated_price, r.line_total, r.total_fees, r.src, r.m;
  END LOOP;
END $p$;
