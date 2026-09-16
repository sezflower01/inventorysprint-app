-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- If repricer-auto-lower-min reads COG on record, a wrong-low COG lets it drop
-- a min price below the real cost (US policy floor is break-even). How many
-- enabled auto-lower assignments carry a COG that looks like a placeholder,
-- and what does purchase history say for them?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _s AS
  WITH a AS (
    SELECT to_jsonb(a)->>'asin' AS asin, to_jsonb(a)->>'sku' AS sku,
           COALESCE(to_jsonb(a)->>'marketplace','US') AS mkt,
           (to_jsonb(a)->>'min_price_override')::numeric AS min_override
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid
      AND COALESCE((to_jsonb(a)->>'is_enabled')::boolean,false)
      AND COALESCE((to_jsonb(a)->>'auto_lower_min_price')::boolean,false)
  ),
  hist AS (   -- purchase history: median unit cost of real lots (>= $0.10/unit)
    SELECT asin,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY cost / units) AS median_lot,
           count(*) AS lots
    FROM public.created_listings
    WHERE user_id = v_uid AND cost > 0 AND units > 0 AND cost / units >= 0.10
    GROUP BY asin
  )
  SELECT a.*, c.unit_cost AS cog, c.source, c.reviewed_at, c.calculated_cost,
         to_jsonb(c)->>'needs_review' AS needs_review,
         h.median_lot, h.lots, i.cost AS inv_cost
  FROM a
  JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = a.asin AND c.unit_cost > 0
  LEFT JOIN hist h ON h.asin = a.asin
  LEFT JOIN public.inventory i ON i.user_id = v_uid AND i.sku = a.sku;

  RAISE NOTICE '======== enabled auto-lower rows with a COG: % ========', (SELECT count(*) FROM _s);
  FOR r IN SELECT
      count(*) FILTER (WHERE cog < 2) AS under2,
      count(*) FILTER (WHERE median_lot IS NOT NULL AND cog < median_lot * 0.5) AS half_hist,
      count(*) FILTER (WHERE median_lot IS NOT NULL AND cog < median_lot * 0.5 AND min_override > 0 AND cog < min_override * 0.15) AS half_hist_and_tiny_vs_min,
      count(*) FILTER (WHERE median_lot IS NOT NULL AND cog > median_lot * 2) AS double_hist
    FROM _s LOOP
    RAISE NOTICE '  COG under $2: %', r.under2;
    RAISE NOTICE '  COG under HALF the purchase-history median: %  (of which COG < 15%% of the min price: %)', r.half_hist, r.half_hist_and_tiny_vs_min;
    RAISE NOTICE '  COG over DOUBLE the purchase-history median: %', r.double_hist;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- every COG under half its purchase history, or under $2 --';
  FOR r IN SELECT asin, sku, min_override, cog, source, (reviewed_at IS NOT NULL) AS reviewed,
                  round(median_lot::numeric,2) AS median_lot, lots, round(inv_cost,2) AS inv_cost,
                  round(calculated_cost::numeric,2) AS calc
           FROM _s
           WHERE cog < 2 OR (median_lot IS NOT NULL AND cog < median_lot * 0.5)
           ORDER BY (median_lot - cog) DESC NULLS LAST LIMIT 30 LOOP
    RAISE NOTICE '    % min=% COG=% [% reviewed=%] history median=% (% lots) calc=% inventory.cost=%',
      r.asin, r.min_override, r.cog, r.source, r.reviewed, r.median_lot, r.lots, r.calc, r.inv_cost;
  END LOOP;

  DROP TABLE _s;
END
$p$;
