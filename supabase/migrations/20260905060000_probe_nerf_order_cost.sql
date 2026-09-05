-- Read-only: what cost is STORED on the recent orders for this ASIN?
DO $$
DECLARE r RECORD; v_sum numeric; v_units bigint;
BEGIN
  FOR r IN
    SELECT order_id, order_date, quantity, sold_price, total_sale_amount,
           unit_cost, total_cost, total_fees, roi, created_at
    FROM public.sales_orders
    WHERE asin = 'B0G2YNN87D'
      AND order_date >= current_date - 2
    ORDER BY order_date DESC, created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE 'order % (% / created %): qty=% sold=% total_sale=% unit_cost=% total_cost=% fees=%',
      r.order_id, r.order_date, r.created_at, r.quantity, r.sold_price,
      r.total_sale_amount, r.unit_cost, r.total_cost, r.total_fees;
  END LOOP;

  SELECT COALESCE(sum(total_cost),0), COALESCE(sum(quantity),0) INTO v_sum, v_units
  FROM public.sales_orders
  WHERE asin = 'B0G2YNN87D' AND order_date >= current_date - 1;
  RAISE NOTICE 'last 24h: % units, total_cost sum = %', v_units, v_sum;
END $$;
