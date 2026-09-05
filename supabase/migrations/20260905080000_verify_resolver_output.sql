-- Read-only: run the actual cost ladder for this ASIN's recent orders.
-- resolve_unit_cost_v1 returns a composite (unit_cost, source), not a scalar.
DO $$
DECLARE r RECORD; v_cost numeric; v_src text; v_sum numeric := 0;
BEGIN
  FOR r IN
    SELECT user_id, order_id, asin, sku, order_date, quantity, unit_cost
    FROM public.sales_orders
    WHERE asin = 'B0G2YNN87D' AND order_date >= current_date - 1
    ORDER BY order_date DESC
  LOOP
    SELECT x.unit_cost, x.source INTO v_cost, v_src
    FROM public.resolve_unit_cost_v1(r.user_id, r.asin, r.sku, r.order_date, r.unit_cost) x;
    v_sum := v_sum + COALESCE(v_cost,0) * COALESCE(r.quantity,0);
    RAISE NOTICE 'order % qty=% -> unit cost % (from %)',
      r.order_id, r.quantity, v_cost, v_src;
  END LOOP;
  RAISE NOTICE 'TOTAL COGS the ladder yields for the last 24h: % (dashboard showed 2157.92)',
    round(v_sum, 2);
END $$;
