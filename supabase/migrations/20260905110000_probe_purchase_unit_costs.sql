-- Read-only: does a purchase row hold a lot total in its unit_cost field?
DO $$
DECLARE r RECORD; v_bad bigint;
BEGIN
  FOR r IN
    SELECT p.units, p.unit_cost, p.total_cost, p.note, p.purchase_date
    FROM public.created_listing_purchases p
    JOIN public.created_listings c ON c.id = p.listing_id
    WHERE c.asin = 'B0G2YNN87D'
    ORDER BY p.purchase_date DESC LIMIT 8
  LOOP
    RAISE NOTICE '  purchase: units=% unit_cost=% total_cost=% "%" (%)',
      r.units, r.unit_cost, r.total_cost, r.note, r.purchase_date;
  END LOOP;

  -- Anywhere unit_cost looks like a batch total.
  SELECT count(*) INTO v_bad FROM public.created_listing_purchases
   WHERE units > 1 AND unit_cost > 0 AND total_cost > 0
     AND abs(unit_cost - total_cost) < 0.02;
  RAISE NOTICE 'purchase rows where unit_cost == total_cost on a multi-unit batch: %', v_bad;

  FOR r IN
    SELECT c.asin, p.units, p.unit_cost, p.total_cost
    FROM public.created_listing_purchases p
    JOIN public.created_listings c ON c.id = p.listing_id
    WHERE p.units > 1 AND p.unit_cost > 0 AND p.total_cost > 0
      AND abs(p.unit_cost - p.total_cost) < 0.02
    ORDER BY p.unit_cost DESC LIMIT 8
  LOOP
    RAISE NOTICE '    % : units=% unit_cost=% total=%', r.asin, r.units, r.unit_cost, r.total_cost;
  END LOOP;
END $$;
