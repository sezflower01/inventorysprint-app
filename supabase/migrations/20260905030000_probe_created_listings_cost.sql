-- Read-only: is created_listings.cost a UNIT cost or a LOT total?
DO $$
DECLARE r RECORD; v_tot bigint; v_looks_total bigint;
BEGIN
  FOR r IN
    SELECT asin, sku, cost, amount, units, price
    FROM public.created_listings
    WHERE asin IN ('B0G2YNN87D','B000UVUAFO','B0H8PKYSNL','B07RNKWL2P')
    LIMIT 8
  LOOP
    RAISE NOTICE '  %: cost=% amount=% units=% price=% | cost/units=%',
      r.asin, r.cost, r.amount, r.units, r.price,
      CASE WHEN COALESCE(r.units,0) > 0 THEN round(r.cost / r.units, 2) ELSE NULL END;
  END LOOP;

  -- If cost is a lot total, cost/units should land near amount across the board.
  SELECT count(*) INTO v_tot FROM public.created_listings
   WHERE cost > 0 AND units > 1 AND amount > 0;
  SELECT count(*) INTO v_looks_total FROM public.created_listings
   WHERE cost > 0 AND units > 1 AND amount > 0
     AND abs((cost / units) - amount) < 0.02;
  RAISE NOTICE 'multi-unit listings with both fields: % | where cost/units = amount: %',
    v_tot, v_looks_total;
END $$;
