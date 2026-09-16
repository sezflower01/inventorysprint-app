-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- apply-min-roi-intl-sweep (daily 07:00 UTC) calls apply-min-roi for every
-- (rule, CA/MX/BR) pair whose rule has a positive min_roi_percent (or a
-- marketplace override), and apply-min-roi WRITES min prices from unit cost.
-- Its cost today: newest created_listings unit cost by ASIN, else
-- inventory.cost by SKU. With the COG change: override -> usable COG -> same.
-- The min scales roughly linearly with cost, so the cost change IS the floor
-- change. Measure it per marketplace before deploying.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _w AS
  WITH a AS (
    SELECT a.id, a.asin, a.sku, a.marketplace AS mkt, a.rule_id, a.min_price_override AS cur_min,
           COALESCE((ru.min_roi_marketplace_overrides ->> a.marketplace)::numeric, ru.min_roi_percent) AS roi
    FROM public.repricer_assignments a
    JOIN public.repricer_rules ru ON ru.id = a.rule_id
    WHERE a.user_id = v_uid AND a.is_enabled AND a.marketplace IN ('CA','MX','BR')
  ),
  cl AS (
    SELECT DISTINCT ON (asin) asin,
           CASE WHEN amount > 0 THEN amount WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
    FROM public.created_listings
    WHERE user_id = v_uid AND (amount > 0 OR (cost > 0 AND units > 0))
    ORDER BY asin, date_created DESC NULLS LAST, created_at DESC, id DESC
  ),
  ovr AS (
    SELECT DISTINCT ON (asin) asin, unit_cost FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND effective_from <= CURRENT_DATE AND unit_cost > 0
    ORDER BY asin, effective_from DESC, created_at DESC
  )
  SELECT a.*, cl.unit_cost AS cl_cost, i.cost AS inv_cost, o.unit_cost AS ovr_cost, v.unit_cost AS cog,
         COALESCE(cl.unit_cost, NULLIF(i.cost,0)) AS cost_now,
         COALESCE(o.unit_cost, v.unit_cost, cl.unit_cost, NULLIF(i.cost,0)) AS cost_new
  FROM a
  LEFT JOIN cl ON cl.asin = a.asin
  LEFT JOIN public.inventory i ON i.user_id = v_uid AND i.sku = a.sku AND i.cost > 0
  LEFT JOIN ovr o ON o.asin = a.asin
  LEFT JOIN public.asin_cog_for_repricer v ON v.user_id = v_uid AND v.asin = a.asin;

  RAISE NOTICE '======== intl enabled assignments the daily sweep touches (roi > 0) ========';
  FOR r IN SELECT mkt, count(*) AS n,
                  count(*) FILTER (WHERE roi > 0) AS swept,
                  count(*) FILTER (WHERE roi > 0 AND cost_now IS NULL AND cost_new IS NOT NULL) AS gains_cost,
                  count(*) FILTER (WHERE roi > 0 AND abs(cost_new - cost_now) > 0.005) AS changes,
                  count(*) FILTER (WHERE roi > 0 AND cost_new < cost_now * 0.9) AS down10,
                  count(*) FILTER (WHERE roi > 0 AND cost_new > cost_now * 1.1) AS up10,
                  round(avg(roi) FILTER (WHERE roi > 0), 0) AS roi
           FROM _w GROUP BY mkt ORDER BY mkt LOOP
    RAISE NOTICE '  %: % enabled, % swept (ROI %%%) | cost changes % (floor down >10%%: %, up >10%%: %) | gains a cost: %',
      r.mkt, r.n, r.swept, r.roi, r.changes, r.down10, r.up10, r.gains_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- largest proportional cost moves (floor moves by about the same %%) --';
  FOR r IN SELECT mkt, asin, cur_min, round(cost_now,2) AS now_c, cost_new, round(((cost_new - cost_now)/cost_now*100)::numeric,0) AS pct,
                  CASE WHEN ovr_cost IS NOT NULL THEN 'override' ELSE 'COG' END AS src
           FROM _w WHERE roi > 0 AND abs(cost_new - cost_now) > 0.005
           ORDER BY abs(cost_new - cost_now) / cost_now DESC LIMIT 15 LOOP
    RAISE NOTICE '    % % min=% cost % -> % (%%%) [%]', r.mkt, r.asin, r.cur_min, r.now_c, r.cost_new, r.pct, r.src;
  END LOOP;

  DROP TABLE _w;
END
$p$;
