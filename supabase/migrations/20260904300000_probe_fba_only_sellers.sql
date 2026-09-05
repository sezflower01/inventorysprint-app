-- Read-only: how many other listings were stuck the same way?
--
-- The bug held any listing where the seller is FBA, the strategy competes with
-- FBM, the Buy Box is suppressed and there are no OTHER FBA offers -- the
-- anchor was unsatisfiable, so the price never moved.
DO $$
DECLARE r RECORD; v bigint;
BEGIN
  SELECT count(*) INTO v
  FROM public.repricer_price_actions
  WHERE created_at > now() - interval '7 days'
    AND reason ILIKE '%anchor unavailable%';
  RAISE NOTICE 'price actions in 7d citing an unavailable anchor: %', v;

  FOR r IN
    SELECT asin, marketplace, count(*) AS hits,
           min(created_at) AS first_seen, max(created_at) AS last_seen
    FROM public.repricer_price_actions
    WHERE created_at > now() - interval '7 days'
      AND reason ILIKE '%anchor unavailable%'
    GROUP BY asin, marketplace
    ORDER BY count(*) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % (%): % holds, % .. %',
      r.asin, r.marketplace, r.hits, r.first_seen, r.last_seen;
  END LOOP;
END $$;
