-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Verify the precedence just shipped into SyncedInventory.tsx,
-- src/lib/inventory-valuation.ts and _shared/inventory-valuation-core.ts:
--   asin_cost_overrides -> asin_cog_on_record -> inventory.unit_cost_manual
--   -> created_listings -> inventory.cost
-- Predicted total: 59,967.58 (from 59,260.63). Confirm, and check nothing
-- lost a cost it used to have.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _v AS
  WITH inv AS (
    SELECT i.asin, i.sku,
           COALESCE(i.available,0)+COALESCE(i.reserved,0)
             +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) AS qty,
           i.cost AS inv_cost, i.unit_cost_manual
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND UPPER(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
  ),
  cl AS (
    SELECT DISTINCT ON (sku) sku,
           CASE WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
    FROM public.created_listings
    WHERE user_id = v_uid AND sku IS NOT NULL
    ORDER BY sku, created_at DESC
  ),
  cl_asin AS (
    SELECT DISTINCT ON (asin) asin,
           CASE WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
    FROM public.created_listings
    WHERE user_id = v_uid AND asin IS NOT NULL
    ORDER BY asin, created_at DESC
  ),
  ovr AS (
    SELECT DISTINCT ON (asin) asin, unit_cost
    FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND effective_from <= CURRENT_DATE
      AND date_part('year', effective_from) = date_part('year', CURRENT_DATE)
      AND unit_cost > 0
    ORDER BY asin, effective_from DESC
  ),
  cog AS (
    SELECT asin, unit_cost FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND unit_cost IS NOT NULL AND unit_cost > 0
  )
  SELECT inv.asin, inv.sku, inv.qty, inv.inv_cost, inv.unit_cost_manual,
         ovr.unit_cost AS ovr_cost, cog.unit_cost AS cog_cost,
         COALESCE(cl.unit_cost, cl_asin.unit_cost) AS cl_cost,
         -- OLD chain
         COALESCE(ovr.unit_cost,
                  CASE WHEN inv.unit_cost_manual IS TRUE THEN inv.inv_cost END,
                  COALESCE(cl.unit_cost, cl_asin.unit_cost),
                  inv.inv_cost) AS old_cost,
         -- NEW chain
         COALESCE(ovr.unit_cost,
                  cog.unit_cost,
                  CASE WHEN inv.unit_cost_manual IS TRUE THEN inv.inv_cost END,
                  COALESCE(cl.unit_cost, cl_asin.unit_cost),
                  inv.inv_cost) AS new_cost
  FROM inv
  LEFT JOIN cl      ON cl.sku = inv.sku
  LEFT JOIN cl_asin ON cl_asin.asin = inv.asin
  LEFT JOIN ovr     ON ovr.asin = inv.asin
  LEFT JOIN cog     ON cog.asin = inv.asin
  WHERE inv.qty > 0;

  RAISE NOTICE '';
  RAISE NOTICE '======== total stock value ========';
  FOR r IN
    SELECT round(sum(qty * COALESCE(old_cost,0))::numeric, 2) AS old_v,
           round(sum(qty * COALESCE(new_cost,0))::numeric, 2) AS new_v,
           count(*) AS rows
    FROM _v
  LOOP
    RAISE NOTICE '  rows: %', r.rows;
    RAISE NOTICE '  before: %', r.old_v;
    RAISE NOTICE '  after : %   (predicted 59967.58)', r.new_v;
    RAISE NOTICE '  change: %', round((r.new_v - r.old_v)::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== safety: did any row LOSE a cost it used to have? ========';
  FOR r IN
    SELECT count(*) AS lost
    FROM _v WHERE old_cost IS NOT NULL AND new_cost IS NULL
  LOOP
    RAISE NOTICE '  rows that had a cost and now have none: %  (must be 0)', r.lost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== safety: rows with NO cost under either chain ========';
  FOR r IN
    SELECT count(*) AS n FROM _v WHERE new_cost IS NULL
  LOOP
    RAISE NOTICE '  rows valued at $0: %', r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== which source wins under the NEW chain ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE ovr_cost IS NOT NULL) AS by_ovr,
           count(*) FILTER (WHERE ovr_cost IS NULL AND cog_cost IS NOT NULL) AS by_cog,
           count(*) FILTER (WHERE ovr_cost IS NULL AND cog_cost IS NULL AND unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AS by_manual,
           count(*) FILTER (WHERE ovr_cost IS NULL AND cog_cost IS NULL AND NOT (unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AND cl_cost IS NOT NULL) AS by_listing,
           count(*) FILTER (WHERE ovr_cost IS NULL AND cog_cost IS NULL AND NOT (unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AND cl_cost IS NULL) AS by_rest
    FROM _v
  LOOP
    RAISE NOTICE '    asin_cost_overrides : %', r.by_ovr;
    RAISE NOTICE '    COG on record       : %   <-- now the main source', r.by_cog;
    RAISE NOTICE '    inline manual edit  : %', r.by_manual;
    RAISE NOTICE '    created_listings    : %', r.by_listing;
    RAISE NOTICE '    inventory.cost/none : %', r.by_rest;
  END LOOP;

  DROP TABLE _v;
END
$p$;
