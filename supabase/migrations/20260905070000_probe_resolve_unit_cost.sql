-- Read-only: what does the SQL cost ladder return for this ASIN right now?
DO $$
DECLARE r RECORD; v_uid uuid; v numeric;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders
   WHERE asin = 'B0G2YNN87D' ORDER BY order_date DESC LIMIT 1;

  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('resolve_unit_cost_v1','get_cogs_for_range')
  LOOP
    RAISE NOTICE 'fn %(%)', r.proname, r.args;
  END LOOP;

  -- The raw ladder inputs as they stand now.
  RAISE NOTICE 'sales_orders unit_cost: %',
    (SELECT unit_cost FROM public.sales_orders
      WHERE asin='B0G2YNN87D' ORDER BY order_date DESC LIMIT 1);
  RAISE NOTICE 'inventory.cost (unit): %',
    (SELECT cost FROM public.inventory WHERE asin='B0G2YNN87D' LIMIT 1);
  RAISE NOTICE 'created_listings amount (unit) / cost (lot): % / %',
    (SELECT amount FROM public.created_listings WHERE asin='B0G2YNN87D' ORDER BY updated_at DESC LIMIT 1),
    (SELECT cost   FROM public.created_listings WHERE asin='B0G2YNN87D' ORDER BY updated_at DESC LIMIT 1);
  RAISE NOTICE 'asin_cost_overrides: %',
    (SELECT count(*) FROM public.asin_cost_overrides WHERE asin='B0G2YNN87D');
END $$;
