-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The seller wants the repricer to read the COG on record, the same way
-- Inventory Valuation now does. Cost is LIVE in the repricer: when min ROI is
-- enabled the effective floor is max(manual min, ROI floor from unit cost),
-- and the floor-recovery paths RAISE a live price up to it. So before changing
-- anything: what unit cost is each enabled assignment's latest evaluation
-- actually using, where did it come from, and how would COG move it?
--
-- Source of truth for "what the repricer used": the profit_guard block the
-- evaluator writes into repricer_ai_decisions (unit_cost, cost_source,
-- profit_floor_price, effective_min_roi).

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  CREATE TEMP TABLE _a AS
  SELECT a.id AS assignment_id,
         to_jsonb(a)->>'asin' AS asin,
         to_jsonb(a)->>'sku' AS sku,
         COALESCE(to_jsonb(a)->>'marketplace', 'US') AS mkt,
         (to_jsonb(a)->>'min_price_override')::numeric AS min_override,
         (to_jsonb(a)->>'min_roi_override')::numeric AS roi_override,
         CASE
           WHEN (to_jsonb(ru)->'min_roi_enabled_marketplace_overrides') ? COALESCE(to_jsonb(a)->>'marketplace', 'US')
             THEN ((to_jsonb(ru)->'min_roi_enabled_marketplace_overrides')->>COALESCE(to_jsonb(a)->>'marketplace', 'US'))::boolean
           ELSE COALESCE((to_jsonb(ru)->>'min_roi_enabled')::boolean, false)
         END AS min_roi_enabled
  FROM public.repricer_assignments a
  LEFT JOIN public.repricer_rules ru ON ru.id = a.rule_id
  WHERE a.user_id = v_uid
    AND COALESCE((to_jsonb(a)->>'is_enabled')::boolean, false) = true;

  RAISE NOTICE '';
  RAISE NOTICE '======== enabled assignments ========';
  FOR r IN SELECT mkt, count(*) AS n, count(*) FILTER (WHERE min_roi_enabled) AS roi_on
           FROM _a GROUP BY mkt ORDER BY n DESC LOOP
    RAISE NOTICE '  %: % enabled, % with min ROI ON (cost is live)', r.mkt, r.n, r.roi_on;
  END LOOP;

  CREATE TEMP TABLE _d AS
  SELECT DISTINCT ON (d.assignment_id)
         d.assignment_id, d.created_at, d.current_price, d.min_price_used,
         jsonb_path_query_first(to_jsonb(d), 'lax $.**.profit_guard') AS pg
  FROM public.repricer_ai_decisions d
  WHERE d.user_id = v_uid
    AND d.created_at > now() - interval '6 hours'
    AND d.assignment_id IN (SELECT assignment_id FROM _a)
  ORDER BY d.assignment_id, d.created_at DESC;

  CREATE TEMP TABLE _j AS
  SELECT a.*, d.created_at AS eval_at, d.current_price, d.min_price_used,
         NULLIF(d.pg->>'unit_cost','')::numeric AS used_cost,
         d.pg->>'cost_source' AS cost_source,
         NULLIF(d.pg->>'profit_floor_price','')::numeric AS roi_floor,
         NULLIF(d.pg->>'effective_min_roi','')::numeric AS eff_roi,
         d.pg->'floor_breakdown'->>'triggered_by' AS floor_trigger,
         c.unit_cost AS cog
  FROM _a a
  LEFT JOIN _d d ON d.assignment_id = a.assignment_id
  LEFT JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = a.asin AND c.unit_cost > 0;

  RAISE NOTICE '';
  RAISE NOTICE '======== coverage ========';
  FOR r IN SELECT count(*) AS n,
                  count(*) FILTER (WHERE eval_at IS NOT NULL) AS evaluated_6h,
                  count(*) FILTER (WHERE cog IS NOT NULL) AS with_cog,
                  count(*) FILTER (WHERE eval_at IS NOT NULL AND used_cost IS NULL) AS evaluated_no_cost
           FROM _j LOOP
    RAISE NOTICE '  enabled: %  evaluated in last 6h: %  have a COG: %  evaluated with NO cost: %',
      r.n, r.evaluated_6h, r.with_cog, r.evaluated_no_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== where the live cost comes from today (evaluated rows) ========';
  FOR r IN SELECT CASE
                    WHEN cost_source IS NULL THEN '(none)'
                    WHEN cost_source ILIKE 'manual cost override%' THEN 'asin_cost_overrides'
                    WHEN cost_source ILIKE 'inventory.cost%' THEN 'inventory.cost'
                    WHEN cost_source ILIKE 'created_listings%' THEN 'created_listings'
                    ELSE left(cost_source, 40) END AS src,
                  count(*) AS n
           FROM _j WHERE eval_at IS NOT NULL GROUP BY 1 ORDER BY n DESC LOOP
    RAISE NOTICE '  %: %', r.src, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== live cost vs COG (evaluated rows with both, excluding overrides) ========';
  FOR r IN SELECT count(*) AS n,
                  count(*) FILTER (WHERE abs(cog - used_cost) <= 0.005) AS same,
                  count(*) FILTER (WHERE cog > used_cost + 0.005) AS cog_higher,
                  count(*) FILTER (WHERE cog < used_cost - 0.005) AS cog_lower,
                  count(*) FILTER (WHERE cog > used_cost * 1.25) AS cog_higher_25,
                  count(*) FILTER (WHERE cog < used_cost * 0.75) AS cog_lower_25
           FROM _j
           WHERE used_cost IS NOT NULL AND cog IS NOT NULL
             AND COALESCE(cost_source,'') NOT ILIKE 'manual cost override%' LOOP
    RAISE NOTICE '  compared: %  same: %  COG higher: % (>25%%: %)  COG lower: % (<-25%%: %)',
      r.n, r.same, r.cog_higher, r.cog_higher_25, r.cog_lower, r.cog_lower_25;
  END LOOP;

  -- What actually changes a live price: min ROI ON, and the ROI floor (not the
  -- manual min) is the binding floor. Estimate the new ROI floor by moving the
  -- recorded floor by the cost change: floor*(1-ref) = cost*(1+roi)+fixed, so
  -- d_floor = d_cost*(1+roi)/(1-ref). ref taken as 0.15; US rows only (non-US
  -- need FX, reported separately).
  RAISE NOTICE '';
  RAISE NOTICE '======== LIVE IMPACT: min ROI ON, US, cost would change ========';
  FOR r IN
    WITH x AS (
      SELECT *, roi_floor + (cog - used_cost) * (1 + COALESCE(eff_roi,0)/100.0) / 0.85 AS new_floor
      FROM _j
      WHERE min_roi_enabled AND mkt = 'US' AND used_cost IS NOT NULL AND cog IS NOT NULL
        AND roi_floor IS NOT NULL
        AND COALESCE(cost_source,'') NOT ILIKE 'manual cost override%'
        AND abs(cog - used_cost) > 0.005
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE new_floor > roi_floor) AS floor_up,
           count(*) FILTER (WHERE new_floor < roi_floor) AS floor_down,
           -- a raise happens when the new effective floor exceeds today's price
           count(*) FILTER (WHERE GREATEST(new_floor, COALESCE(min_price_used,0)) > current_price + 0.005
                              AND GREATEST(roi_floor, COALESCE(min_price_used,0)) <= current_price + 0.005) AS would_newly_raise,
           count(*) FILTER (WHERE GREATEST(roi_floor, COALESCE(min_price_used,0)) > current_price + 0.005
                              AND GREATEST(new_floor, COALESCE(min_price_used,0)) <= current_price + 0.005) AS would_stop_raising
    FROM x
  LOOP
    RAISE NOTICE '  US min-ROI rows whose cost changes: %', r.n;
    RAISE NOTICE '    ROI floor goes UP: %   goes DOWN: %', r.floor_up, r.floor_down;
    RAISE NOTICE '    currently priced OK but would be RAISED to the new floor: %', r.would_newly_raise;
    RAISE NOTICE '    currently held up by the ROI floor, would be FREED to go lower: %', r.would_stop_raising;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- the 15 largest US floor moves (min ROI ON) --';
  FOR r IN
    SELECT asin, sku, current_price, min_price_used, used_cost, cog, eff_roi, roi_floor,
           round((roi_floor + (cog - used_cost) * (1 + COALESCE(eff_roi,0)/100.0) / 0.85)::numeric, 2) AS new_floor,
           left(cost_source, 30) AS src
    FROM _j
    WHERE min_roi_enabled AND mkt = 'US' AND used_cost IS NOT NULL AND cog IS NOT NULL AND roi_floor IS NOT NULL
      AND COALESCE(cost_source,'') NOT ILIKE 'manual cost override%'
      AND abs(cog - used_cost) > 0.005
    ORDER BY abs(cog - used_cost) * (1 + COALESCE(eff_roi,0)/100.0) DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '    % % price=% min=% cost % -> COG % roi=%%% floor % -> ~% [%]',
      r.asin, r.sku, r.current_price, r.min_price_used, round(r.used_cost,2), r.cog, r.eff_roi, r.roi_floor, r.new_floor, r.src;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== non-US min-ROI rows whose cost would change (FX applies) ========';
  FOR r IN SELECT mkt, count(*) AS n,
                  count(*) FILTER (WHERE cog > used_cost + 0.005) AS up,
                  count(*) FILTER (WHERE cog < used_cost - 0.005) AS down
           FROM _j
           WHERE min_roi_enabled AND mkt <> 'US' AND used_cost IS NOT NULL AND cog IS NOT NULL
             AND COALESCE(cost_source,'') NOT ILIKE 'manual cost override%'
             AND abs(cog - used_cost) > 0.005
           GROUP BY mkt LOOP
    RAISE NOTICE '  %: % rows (COG higher %, lower %)', r.mkt, r.n, r.up, r.down;
  END LOOP;

  DROP TABLE _j; DROP TABLE _d; DROP TABLE _a;
END
$p$;
