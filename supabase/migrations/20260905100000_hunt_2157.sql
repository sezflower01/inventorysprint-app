-- Read-only: find any stored row that literally holds the bad COGS.
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT order_id, asin, order_date, quantity, unit_cost, total_cost, total_sale_amount
    FROM public.sales_orders
    WHERE total_cost BETWEEN 2100 AND 2200
       OR unit_cost BETWEEN 1000 AND 1200
       OR unit_cost BETWEEN 2100 AND 2200
    ORDER BY order_date DESC LIMIT 10
  LOOP
    RAISE NOTICE 'sales_orders % (% / %): qty=% unit_cost=% total_cost=%',
      r.order_id, r.asin, r.order_date, r.quantity, r.unit_cost, r.total_cost;
  END LOOP;

  -- Every row for this ASIN, no date filter, in case one sits on another date.
  FOR r IN
    SELECT order_id, order_date, quantity, unit_cost, total_cost, total_sale_amount, is_cancelled
    FROM public.sales_orders WHERE asin = 'B0G2YNN87D'
    ORDER BY order_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '  B0G2YNN87D % (%): qty=% unit=% total=% sale=% cancelled=%',
      r.order_id, r.order_date, r.quantity, r.unit_cost, r.total_cost,
      r.total_sale_amount, r.is_cancelled;
  END LOOP;
END $$;
