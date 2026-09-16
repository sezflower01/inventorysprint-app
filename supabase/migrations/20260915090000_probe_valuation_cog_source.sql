-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Inventory Valuation / Synced Inventory currently resolve a unit cost as:
--   1. asin_cost_overrides (this calendar year)
--   2. inventory.unit_cost_manual -> inventory.cost
--   3. created_listings unit cost (SKU match, then ASIN)
--   4. inventory.cost
-- The seller wants step 3 to read asin_cog_on_record instead. Before changing
-- three separate implementations, measure what that actually moves.

DO $probe$
DECLARE
  v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %  user: %', now(), v_uid;

  RAISE NOTICE '';
  RAISE NOTICE '======== table sizes ========';
  FOR r IN
    SELECT
      (SELECT count(*) FROM public.asin_cog_on_record WHERE user_id = v_uid) AS cog_rows,
      (SELECT count(*) FROM public.asin_cog_on_record WHERE user_id = v_uid AND unit_cost IS NOT NULL) AS cog_with_cost,
      (SELECT count(*) FROM public.asin_cost_overrides WHERE user_id = v_uid) AS override_rows,
      (SELECT count(*) FROM public.inventory WHERE user_id = v_uid AND unit_cost_manual IS TRUE) AS manual_rows
  LOOP
    RAISE NOTICE '  asin_cog_on_record: % rows (% with a cost)', r.cog_rows, r.cog_with_cost;
    RAISE NOTICE '  asin_cost_overrides: % rows', r.override_rows;
    RAISE NOTICE '  inventory rows flagged unit_cost_manual: %', r.manual_rows;
  END LOOP;
END
$probe$;

-- The real question: for every STOCKED inventory row, what does the current
-- chain resolve to, and what would the COG-on-record chain resolve to?
DO $probe2$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _val AS
  WITH inv AS (
    SELECT i.asin, i.sku,
           COALESCE(i.available,0) + COALESCE(i.reserved,0)
             + COALESCE(i.inbound,0) + COALESCE(i.unfulfilled,0) AS qty,
           i.cost, i.amount, i.units, i.unit_cost_manual
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND UPPER(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
  ),
  cl AS (
    SELECT DISTINCT ON (sku) sku, asin,
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
    WHERE user_id = v_uid
      AND effective_from <= CURRENT_DATE
      AND date_part('year', effective_from) = date_part('year', CURRENT_DATE)
      AND unit_cost > 0
    ORDER BY asin, effective_from DESC
  ),
  cog AS (
    SELECT asin, unit_cost FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND unit_cost IS NOT NULL
  )
  SELECT inv.asin, inv.sku, inv.qty,
         ovr.unit_cost   AS ovr_cost,
         inv.unit_cost_manual,
         inv.cost        AS inv_cost,
         COALESCE(cl.unit_cost, cl_asin.unit_cost) AS cl_cost,
         cog.unit_cost   AS cog_cost
  FROM inv
  LEFT JOIN cl      ON cl.sku  = inv.sku
  LEFT JOIN cl_asin ON cl_asin.asin = inv.asin
  LEFT JOIN ovr     ON ovr.asin = inv.asin
  LEFT JOIN cog     ON cog.asin = inv.asin;

  RAISE NOTICE '';
  RAISE NOTICE '======== stocked rows: which source wins today ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE qty > 0) AS stocked_rows,
           count(*) FILTER (WHERE qty > 0 AND ovr_cost IS NOT NULL) AS by_override,
           count(*) FILTER (WHERE qty > 0 AND ovr_cost IS NULL AND unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AS by_manual,
           count(*) FILTER (WHERE qty > 0 AND ovr_cost IS NULL AND NOT (unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AND cl_cost IS NOT NULL) AS by_listing,
           count(*) FILTER (WHERE qty > 0 AND ovr_cost IS NULL AND NOT (unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AND cl_cost IS NULL AND inv_cost IS NOT NULL) AS by_inv_cost,
           count(*) FILTER (WHERE qty > 0 AND ovr_cost IS NULL AND NOT (unit_cost_manual IS TRUE AND inv_cost IS NOT NULL) AND cl_cost IS NULL AND inv_cost IS NULL) AS no_cost
    FROM _val
  LOOP
    RAISE NOTICE '  stocked rows: %', r.stocked_rows;
    RAISE NOTICE '    resolved by asin_cost_overrides : %', r.by_override;
    RAISE NOTICE '    resolved by manual inventory    : %', r.by_manual;
    RAISE NOTICE '    resolved by created_listings    : %  <-- the step being replaced', r.by_listing;
    RAISE NOTICE '    resolved by inventory.cost      : %', r.by_inv_cost;
    RAISE NOTICE '    no cost at all                  : %', r.no_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== COG coverage of the rows that matter ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE qty > 0 AND cog_cost IS NOT NULL) AS stocked_with_cog,
           count(*) FILTER (WHERE qty > 0 AND cog_cost IS NULL) AS stocked_without_cog,
           count(*) FILTER (WHERE qty > 0 AND cog_cost IS NULL AND cl_cost IS NOT NULL) AS would_lose_cost
    FROM _val
  LOOP
    RAISE NOTICE '  stocked rows WITH a COG on record   : %', r.stocked_with_cog;
    RAISE NOTICE '  stocked rows WITHOUT a COG on record: %', r.stocked_without_cog;
    RAISE NOTICE '  ...of those, rows that TODAY get a cost from created_listings: %', r.would_lose_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== total valuation: now vs COG-first ========';
  FOR r IN
    SELECT
      round(sum(qty * COALESCE(
        ovr_cost,
        CASE WHEN unit_cost_manual IS TRUE THEN inv_cost END,
        cl_cost, inv_cost, 0))::numeric, 2) AS value_now,
      round(sum(qty * COALESCE(
        ovr_cost,
        CASE WHEN unit_cost_manual IS TRUE THEN inv_cost END,
        cog_cost, cl_cost, inv_cost, 0))::numeric, 2) AS value_cog_then_listing,
      round(sum(qty * COALESCE(
        cog_cost,
        ovr_cost,
        CASE WHEN unit_cost_manual IS TRUE THEN inv_cost END,
        cl_cost, inv_cost, 0))::numeric, 2) AS value_cog_first
    FROM _val WHERE qty > 0
  LOOP
    RAISE NOTICE '  today (created_listings)              : %', r.value_now;
    RAISE NOTICE '  COG replaces created_listings step    : %', r.value_cog_then_listing;
    RAISE NOTICE '  COG above overrides+manual too        : %', r.value_cog_first;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== biggest movers (COG vs created_listings), stocked ========';
  FOR r IN
    SELECT asin, sku, qty, cl_cost, cog_cost,
           round((qty * (cog_cost - cl_cost))::numeric, 2) AS delta
    FROM _val
    WHERE qty > 0 AND cog_cost IS NOT NULL AND cl_cost IS NOT NULL
      AND abs(cog_cost - cl_cost) > 0.005
    ORDER BY abs(qty * (cog_cost - cl_cost)) DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  % (%) qty=% listing=% cog=% delta=%', r.asin, r.sku, r.qty, r.cl_cost, r.cog_cost, r.delta;
  END LOOP;

  DROP TABLE _val;
END
$probe2$;
