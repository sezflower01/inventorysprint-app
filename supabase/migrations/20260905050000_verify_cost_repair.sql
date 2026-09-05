-- Read-only: confirm the repair landed and count what it touched.
DO $$
DECLARE v_left bigint; v_over bigint; r RECORD;
BEGIN
  SELECT count(*) INTO v_left FROM public.inventory i
  JOIN LATERAL (
    SELECT c.amount, c.units, c.cost FROM public.created_listings c
    WHERE c.asin = i.asin AND c.user_id = i.user_id
      AND c.amount IS NOT NULL AND c.amount > 0
    ORDER BY c.updated_at DESC LIMIT 1
  ) cl ON true
  WHERE i.cost IS NOT NULL AND cl.units > 1
    AND abs(i.cost - cl.cost) < 0.02 AND abs(i.cost - cl.amount) > 0.02;
  RAISE NOTICE 'rows still holding a lot total: % (want 0)', v_left;

  SELECT count(*) INTO v_over FROM public.inventory WHERE cost > 300;
  RAISE NOTICE 'inventory rows with cost over $300 now: %', v_over;

  FOR r IN SELECT sku, asin, cost FROM public.inventory
            WHERE asin = 'B0G2YNN87D' LIMIT 3 LOOP
    RAISE NOTICE '  the Nerf sword: % cost=%', r.sku, r.cost;
  END LOOP;
END $$;
