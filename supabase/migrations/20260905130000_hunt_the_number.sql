-- Read-only: find ANY row holding 2157.92, 1078.96 or 2136.34.
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT 'created_listings' AS t, asin, sku, cost::text AS c, amount::text AS a, units::text AS u
    FROM public.created_listings
    WHERE cost BETWEEN 2157.9 AND 2158.0 OR amount BETWEEN 1078.9 AND 1079.0
       OR cost BETWEEN 2136.3 AND 2136.4 OR amount BETWEEN 2157.9 AND 2158.0
    UNION ALL
    SELECT 'inventory', asin, sku, cost::text, amount::text, units::text
    FROM public.inventory
    WHERE cost BETWEEN 1078.9 AND 1079.0 OR cost BETWEEN 2157.9 AND 2158.0
       OR amount BETWEEN 2157.9 AND 2158.0 OR cost BETWEEN 2136.3 AND 2136.4
    LIMIT 20
  LOOP
    RAISE NOTICE '  % % / % : cost=% amount=% units=%', r.t, r.asin, r.sku, r.c, r.a, r.u;
  END LOOP;

  -- All created_listings rows for this ASIN, not just the newest.
  FOR r IN
    SELECT id::text AS t, asin, sku, cost::text AS c, amount::text AS a, units::text AS u
    FROM public.created_listings WHERE asin = 'B0G2YNN87D'
  LOOP
    RAISE NOTICE '  listing % : cost=% amount=% units=%', r.t, r.c, r.a, r.u;
  END LOOP;
END $$;
