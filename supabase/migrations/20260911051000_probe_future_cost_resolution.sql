-- PROBE (read-only): what would a FUTURE sale of B0G4B3117X cost, with the
-- override in place and without it?
--
-- The seller asked whether "leave it alone" should still include removing the
-- 14.5625 override so future sales use a normal cost. That only helps if the
-- rung BELOW the override gives a better answer. Today's listing edit wrote
-- cost_history rows at 7.75 AND at 14.56, all effective 2026-09-11, so the
-- tie-break decides -- and resolve_unit_cost_v1 step 3a orders by
-- effective_date DESC, then recorded_at DESC. The 14.56 rows were recorded
-- LAST (00:33-00:34 vs 00:20-00:32).
--
-- If 14.56 wins anyway, removing the override changes nothing and would be
-- cosmetic. Ask the function itself rather than reason about it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== what a NEW sale resolves to today (override in place) ========';
  FOR r IN
    SELECT unit_cost, source FROM public.resolve_unit_cost_v1(v_uid, v_asin, v_sku, '2026-09-12'::date, NULL)
  LOOP
    RAISE NOTICE '   order dated 2026-09-12 -> % per unit  (source %)', r.unit_cost, r.source;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== step 3a: which cost_history row would win WITHOUT the override? ========';
  FOR r IN
    SELECT h.cost, h.effective_date, h.recorded_at, h.sku
    FROM public.cost_history h
    WHERE h.user_id = v_uid AND h.cost > 0
      AND h.effective_date <= '2026-09-12'::date
      AND h.recorded_at::date <= '2026-09-12'::date
      AND EXTRACT(YEAR FROM h.effective_date) = 2026
      AND (h.sku = v_sku OR h.asin = v_asin)
    ORDER BY CASE WHEN h.sku = v_sku THEN 0 ELSE 1 END, h.effective_date DESC, h.recorded_at DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '   cost=% effective=% recorded=%  <- first row is the winner',
      r.cost, r.effective_date, r.recorded_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== all cost_history rows written today ========';
  FOR r IN
    SELECT round(cost::numeric,4) AS cost, count(*) AS rows_n,
           min(recorded_at) AS first_at, max(recorded_at) AS last_at
    FROM public.cost_history
    WHERE user_id = v_uid AND asin = v_asin AND effective_date = '2026-09-11'
    GROUP BY 1 ORDER BY max(recorded_at) DESC
  LOOP
    RAISE NOTICE '   cost % : % rows (% .. %)', r.cost, r.rows_n, r.first_at, r.last_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the rungs below, for completeness ========';
  FOR r IN
    SELECT round((cost/NULLIF(units,0))::numeric,4) AS unit, count(*) AS lots, max(date_created) AS newest
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1 ORDER BY max(date_created) DESC LIMIT 3
  LOOP
    RAISE NOTICE '   created_listings: % per unit, % lots, newest lot %', r.unit, r.lots, r.newest;
  END LOOP;
  FOR r IN
    SELECT cost AS inv_unit_cost, units, amount FROM public.inventory
    WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   inventory fallback: % per unit (units=% amount=%)', r.inv_unit_cost, r.units, r.amount;
  END LOOP;
END
$probe$;