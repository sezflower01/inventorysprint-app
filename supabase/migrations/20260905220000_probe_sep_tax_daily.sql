-- Read-only: September tax day by day, to test whether the gap against
-- InventoryLab (307.36 vs 646.54) is simply a different date cutoff.
DO $$
DECLARE r RECORD; v_uid uuid; v_run numeric := 0;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;

  FOR r IN
    SELECT event_date::date AS d,
           SUM(COALESCE(sales_tax_collected, 0)) AS collected,
           SUM(ABS(COALESCE(marketplace_facilitator_tax, 0))) AS fac
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-09-01' AND event_date < '2026-10-01'
    GROUP BY event_date::date ORDER BY event_date::date
  LOOP
    v_run := v_run + COALESCE(r.collected, 0);
    RAISE NOTICE '  % : collected=% facilitator=% | running total=%',
      r.d, round(COALESCE(r.collected,0),2), round(COALESCE(r.fac,0),2), round(v_run,2);
  END LOOP;

  RAISE NOTICE 'newest financial event overall: %',
    (SELECT max(event_date) FROM public.financial_events_cache WHERE user_id = v_uid);
END $$;
