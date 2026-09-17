-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The FBA Shipment Builder values a shipment as sum(unit cost x qty). Its cost
-- comes from created_listings alone -- newest row by updated_at, amount if
-- present else cost/units -- with no cost override, no COG on record and no
-- inventory fallback ("Missing costs count as $0").
--
-- Inventory Valuation and the whole repricer now resolve:
--   asin_cost_overrides -> COG on record -> created_listings -> inventory.cost
-- Measure what that would do to the saved drafts.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _d AS
  WITH drafts AS (
    SELECT d.id AS draft_id,
           COALESCE(to_jsonb(d)->>'name', '(unnamed)') AS name,
           to_jsonb(d) AS j
    FROM public.shipment_builder_drafts d
    WHERE d.user_id = v_uid
  ),
  items AS (
    -- items live in the draft payload; find the first array of objects that
    -- carries an asin, whatever the column is called
    SELECT dr.draft_id, dr.name, it
    FROM drafts dr,
         LATERAL jsonb_path_query(dr.j, 'lax $.**[*] ? (@.asin != null)') it
  ),
  norm AS (
    SELECT draft_id, name,
           upper(trim(it->>'asin')) AS asin,
           COALESCE((it->>'qtyToShip')::numeric, 0) AS qty
    FROM items
    WHERE it->>'asin' ~ '^[A-Za-z0-9]{10}$'
  ),
  agg AS (
    SELECT draft_id, name, asin, max(qty) AS qty   -- same item can appear in several views of the payload
    FROM norm GROUP BY draft_id, name, asin
  ),
  cl AS (   -- exactly the builder's rule today
    SELECT DISTINCT ON (asin) upper(trim(asin)) AS asin,
           CASE WHEN amount >= 0 THEN amount
                WHEN cost > 0 AND units > 0 THEN cost / units
                ELSE 0 END AS unit_cost
    FROM public.created_listings
    WHERE user_id = v_uid AND asin IS NOT NULL
    ORDER BY upper(trim(asin)), updated_at DESC
  ),
  ovr AS (
    SELECT DISTINCT ON (asin) asin, unit_cost FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND effective_from <= CURRENT_DATE AND unit_cost > 0
    ORDER BY asin, effective_from DESC, created_at DESC
  )
  SELECT a.*, cl.unit_cost AS cost_now, o.unit_cost AS ovr_cost, v.unit_cost AS cog,
         i.cost AS inv_cost,
         COALESCE(o.unit_cost, v.unit_cost, cl.unit_cost, NULLIF(i.cost, 0), 0) AS cost_new
  FROM agg a
  LEFT JOIN cl ON cl.asin = a.asin
  LEFT JOIN ovr o ON o.asin = a.asin
  LEFT JOIN public.asin_cog_for_repricer v ON v.user_id = v_uid AND v.asin = a.asin
  LEFT JOIN LATERAL (SELECT cost FROM public.inventory i2 WHERE i2.user_id = v_uid AND i2.asin = a.asin AND i2.cost > 0 LIMIT 1) i ON true;

  RAISE NOTICE '======== saved shipment drafts ========';
  FOR r IN SELECT count(DISTINCT draft_id) AS drafts, count(*) AS rows, sum(qty) AS units FROM _d LOOP
    RAISE NOTICE '  drafts: %  item rows: %  units: %', r.drafts, r.rows, r.units;
  END LOOP;

  FOR r IN
    SELECT name,
           count(*) AS items,
           count(*) FILTER (WHERE COALESCE(cost_now,0) = 0) AS zero_now,
           count(*) FILTER (WHERE cost_new = 0) AS zero_new,
           round(sum(qty * COALESCE(cost_now,0))::numeric, 2) AS value_now,
           round(sum(qty * cost_new)::numeric, 2) AS value_new
    FROM _d GROUP BY name ORDER BY 5 DESC LIMIT 10
  LOOP
    RAISE NOTICE '  "%": % items | valued at $0 today: % -> % | value % -> %',
      r.name, r.items, r.zero_now, r.zero_new, r.value_now, r.value_new;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== per-ASIN differences ========';
  FOR r IN SELECT count(*) AS n,
                  count(*) FILTER (WHERE abs(cost_new - COALESCE(cost_now,0)) > 0.005) AS changed,
                  count(*) FILTER (WHERE COALESCE(cost_now,0) = 0 AND cost_new > 0) AS gains,
                  count(*) FILTER (WHERE COALESCE(cost_now,0) > 0 AND cost_new = 0) AS loses
           FROM _d LOOP
    RAISE NOTICE '  item rows: %  cost changes: %  gains a cost (was $0): %  loses a cost: %', r.n, r.changed, r.gains, r.loses;
  END LOOP;

  FOR r IN SELECT asin, qty, round(COALESCE(cost_now,0),2) AS now_c, round(cost_new,2) AS new_c,
                  CASE WHEN ovr_cost IS NOT NULL THEN 'override' WHEN cog IS NOT NULL THEN 'COG'
                       WHEN cost_now IS NOT NULL AND cost_now > 0 THEN 'created_listings' ELSE 'inventory/none' END AS src,
                  round((qty * (cost_new - COALESCE(cost_now,0)))::numeric, 2) AS delta
           FROM _d WHERE abs(cost_new - COALESCE(cost_now,0)) > 0.005
           ORDER BY abs(qty * (cost_new - COALESCE(cost_now,0))) DESC LIMIT 15 LOOP
    RAISE NOTICE '    % qty=% % -> % [%] line delta %', r.asin, r.qty, r.now_c, r.new_c, r.src, r.delta;
  END LOOP;

  DROP TABLE _d;
END
$p$;
