-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Where cost actually moves live prices in the repricer today:
--   * repricer-auto-lower-min (hourly cron) never lowers a min below the ROI
--     floor computed from inventory.cost -- US policy floor is 0% ROI, i.e.
--     break-even. A different cost moves how far it may drop.
--   * min ROI is OFF on all 3 rules (20260916011000), so the AI evaluator's
--     ROI floor is analytics only; cost there is display.
--   * The Repricer page shows COG = newest created_listings row, else
--     inventory.cost, and passes it to calculate-roi-range (roi_at_min/max).
-- Measure how COG on record differs from each.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _x AS
  WITH a AS (
    SELECT a.id, to_jsonb(a)->>'asin' AS asin, to_jsonb(a)->>'sku' AS sku,
           COALESCE(to_jsonb(a)->>'marketplace','US') AS mkt,
           (to_jsonb(a)->>'min_price_override')::numeric AS min_override,
           COALESCE((to_jsonb(a)->>'auto_lower_min_price')::boolean,false) AS auto_lower,
           COALESCE((to_jsonb(a)->>'is_enabled')::boolean,false) AS enabled
    FROM public.repricer_assignments a WHERE a.user_id = v_uid
  ),
  cl_newest AS (
    SELECT DISTINCT ON (asin) asin,
           CASE WHEN amount > 0 THEN amount
                WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
    FROM public.created_listings WHERE user_id = v_uid
    ORDER BY asin, created_at DESC
  ),
  ovr AS (
    SELECT DISTINCT ON (asin) asin, unit_cost FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND effective_from <= CURRENT_DATE AND unit_cost > 0
    ORDER BY asin, effective_from DESC, created_at DESC
  )
  SELECT a.*, i.cost AS inv_cost, cl.unit_cost AS cl_cost, o.unit_cost AS ovr_cost,
         c.unit_cost AS cog,
         f.fba_fee_fixed, f.referral_rate
  FROM a
  LEFT JOIN public.inventory i ON i.user_id = v_uid AND i.sku = a.sku
  LEFT JOIN cl_newest cl ON cl.asin = a.asin
  LEFT JOIN ovr o ON o.asin = a.asin
  LEFT JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = a.asin AND c.unit_cost > 0
  LEFT JOIN public.asin_fee_cache f ON f.user_id = v_uid AND f.asin = a.asin AND f.marketplace = a.mkt;

  RAISE NOTICE '';
  RAISE NOTICE '======== auto-lower-min: enabled + auto_lower_min_price ========';
  FOR r IN SELECT mkt, count(*) AS n,
                  count(*) FILTER (WHERE inv_cost > 0) AS has_inv_cost,
                  count(*) FILTER (WHERE cog IS NOT NULL) AS has_cog,
                  count(*) FILTER (WHERE (inv_cost IS NULL OR inv_cost <= 0) AND cog IS NOT NULL) AS skipped_no_cost_but_cog
           FROM _x WHERE enabled AND auto_lower GROUP BY mkt ORDER BY n DESC LOOP
    RAISE NOTICE '  %: % rows | inventory.cost: % | COG: % | skipped today for no cost but HAVE a COG: %',
      r.mkt, r.n, r.has_inv_cost, r.has_cog, r.skipped_no_cost_but_cog;
  END LOOP;

  FOR r IN SELECT count(*) AS n,
                  count(*) FILTER (WHERE abs(cog - inv_cost) <= 0.005) AS same,
                  count(*) FILTER (WHERE cog > inv_cost + 0.005) AS up,
                  count(*) FILTER (WHERE cog < inv_cost - 0.005) AS down,
                  count(*) FILTER (WHERE cog > inv_cost * 1.10) AS up10,
                  count(*) FILTER (WHERE cog < inv_cost * 0.90) AS down10
           FROM _x WHERE enabled AND auto_lower AND inv_cost > 0 AND cog IS NOT NULL AND ovr_cost IS NULL LOOP
    RAISE NOTICE '  cost used today (inventory.cost) vs COG: compared % | same % | COG higher % (>10%%: %) | COG lower % (<-10%%: %)',
      r.n, r.same, r.up, r.up10, r.down, r.down10;
  END LOOP;

  -- US break-even (policy floor 0%% ROI): price = (cost + fba_fee) / (1 - referral).
  RAISE NOTICE '';
  RAISE NOTICE '======== US auto-lower rows: current min vs break-even ========';
  FOR r IN
    WITH b AS (
      SELECT *,
        (inv_cost + COALESCE(fba_fee_fixed,0)) / NULLIF(1 - COALESCE(referral_rate,0.15),0) AS be_now,
        (COALESCE(ovr_cost, cog, inv_cost) + COALESCE(fba_fee_fixed,0)) / NULLIF(1 - COALESCE(referral_rate,0.15),0) AS be_cog
      FROM _x WHERE enabled AND auto_lower AND mkt = 'US' AND inv_cost > 0 AND min_override > 0
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE fba_fee_fixed IS NULL) AS no_fee_cache,
           count(*) FILTER (WHERE min_override < be_now - 0.01) AS below_be_now,
           count(*) FILTER (WHERE min_override < be_cog - 0.01) AS below_be_cog,
           count(*) FILTER (WHERE min_override >= be_now - 0.01 AND min_override < be_cog - 0.01) AS newly_below,
           count(*) FILTER (WHERE min_override < be_now - 0.01 AND min_override >= be_cog - 0.01) AS no_longer_below
    FROM b
  LOOP
    RAISE NOTICE '  US rows with a min: % (fee cache missing on %)', r.n, r.no_fee_cache;
    RAISE NOTICE '  min already below break-even using inventory.cost: %', r.below_be_now;
    RAISE NOTICE '  min already below break-even using COG            : %', r.below_be_cog;
    RAISE NOTICE '    below break-even ONLY under COG (COG says the floor is under cost): %', r.newly_below;
    RAISE NOTICE '    below break-even ONLY under inventory.cost (COG says it is fine)  : %', r.no_longer_below;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- largest cost gaps on US auto-lower rows --';
  FOR r IN SELECT asin, sku, min_override, round(inv_cost,2) AS inv_cost, cog,
                  round(((cog - inv_cost)/inv_cost*100)::numeric,0) AS pct
           FROM _x WHERE enabled AND auto_lower AND mkt='US' AND inv_cost > 0 AND cog IS NOT NULL AND ovr_cost IS NULL
             AND abs(cog - inv_cost) > 0.005
           ORDER BY abs(cog - inv_cost) DESC LIMIT 12 LOOP
    RAISE NOTICE '    % % min=% inventory.cost=% COG=% (%%%)', r.asin, r.sku, r.min_override, r.inv_cost, r.cog, r.pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== Repricer page COG column (enabled assignments) ========';
  FOR r IN
    WITH p AS (
      SELECT *, COALESCE(cl_cost, NULLIF(inv_cost,0)) AS page_cost_now,
                COALESCE(ovr_cost, cog, cl_cost, NULLIF(inv_cost,0)) AS page_cost_new
      FROM _x WHERE enabled
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE page_cost_now IS NULL AND page_cost_new IS NOT NULL) AS gains,
           count(*) FILTER (WHERE page_cost_now IS NOT NULL AND page_cost_new IS NULL) AS loses,
           count(*) FILTER (WHERE abs(page_cost_new - page_cost_now) > 0.005) AS changes,
           count(*) FILTER (WHERE abs(page_cost_new - page_cost_now) > page_cost_now * 0.25) AS changes25
    FROM p
  LOOP
    RAISE NOTICE '  enabled: %  COG shown changes: % (>25%%: %)  gains a cost: %  loses a cost: %',
      r.n, r.changes, r.changes25, r.gains, r.loses;
  END LOOP;

  DROP TABLE _x;
END
$p$;
