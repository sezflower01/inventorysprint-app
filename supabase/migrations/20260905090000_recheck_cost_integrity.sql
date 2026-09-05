-- Read-only: has anything re-corrupted the unit costs since the repair?
DO $$
DECLARE v_bad bigint; v_max numeric; v_recent bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.inventory i
  JOIN LATERAL (
    SELECT c.amount, c.units, c.cost FROM public.created_listings c
    WHERE c.asin = i.asin AND c.user_id = i.user_id
      AND c.amount IS NOT NULL AND c.amount > 0
    ORDER BY c.updated_at DESC LIMIT 1
  ) cl ON true
  WHERE i.cost IS NOT NULL AND cl.units > 1
    AND abs(i.cost - cl.cost) < 0.02 AND abs(i.cost - cl.amount) > 0.02;

  SELECT max(cost) INTO v_max FROM public.inventory;
  SELECT count(*) INTO v_recent FROM public.inventory
   WHERE updated_at > now() - interval '90 minutes';

  RAISE NOTICE 'rows holding a lot total: % (want 0)', v_bad;
  RAISE NOTICE 'highest unit cost in inventory: %', v_max;
  RAISE NOTICE 'inventory rows written in the last 90 min: %', v_recent;
  RAISE NOTICE 'Nerf sword cost now: %',
    (SELECT cost FROM public.inventory WHERE asin='B0G2YNN87D' LIMIT 1);
END $$;
