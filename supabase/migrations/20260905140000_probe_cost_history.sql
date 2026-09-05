-- Read-only: cost_history is Tier A of the ladder and outranks everything.
DO $$
DECLARE r RECORD; v_bad bigint;
BEGIN
  FOR r IN
    SELECT asin, sku, cost, effective_date, recorded_at
    FROM public.cost_history WHERE asin = 'B0G2YNN87D'
    ORDER BY effective_date DESC LIMIT 8
  LOOP
    RAISE NOTICE '  cost_history %/%: cost=% effective=% recorded=%',
      r.asin, r.sku, r.cost, r.effective_date, r.recorded_at;
  END LOOP;

  SELECT count(*) INTO v_bad FROM public.cost_history WHERE cost > 300;
  RAISE NOTICE 'cost_history rows over $300: %', v_bad;

  FOR r IN
    SELECT ch.asin, ch.sku, ch.cost, ch.effective_date,
           (SELECT c.amount FROM public.created_listings c
             WHERE c.asin = ch.asin ORDER BY c.updated_at DESC LIMIT 1) AS listing_unit
    FROM public.cost_history ch WHERE ch.cost > 300
    ORDER BY ch.cost DESC LIMIT 10
  LOOP
    RAISE NOTICE '    % / % : cost_history says %, listing unit cost is %',
      r.asin, r.sku, r.cost, r.listing_unit;
  END LOOP;
END $$;
