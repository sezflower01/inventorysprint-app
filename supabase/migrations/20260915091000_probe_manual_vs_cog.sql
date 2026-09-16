-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 141 stocked rows currently take their unit cost from the Synced Inventory
-- page's own inline editor (inventory.unit_cost_manual), and 18 from
-- asin_cost_overrides. Both sit ABOVE created_listings today. If COG on record
-- only replaces the created_listings step, editing a COG will not move those
-- rows. How much do they actually disagree?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _m AS
  WITH inv AS (
    SELECT i.asin, i.sku,
           COALESCE(i.available,0)+COALESCE(i.reserved,0)
             +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) AS qty,
           i.cost AS inv_cost, i.unit_cost_manual, i.manual_cost_updated_at
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND UPPER(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
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
    SELECT asin, unit_cost, updated_at, reviewed_at, source
    FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND unit_cost IS NOT NULL
  )
  SELECT inv.*, ovr.unit_cost AS ovr_cost, cog.unit_cost AS cog_cost,
         cog.updated_at AS cog_updated, cog.reviewed_at AS cog_reviewed, cog.source AS cog_source
  FROM inv LEFT JOIN ovr ON ovr.asin = inv.asin
           LEFT JOIN cog ON cog.asin = inv.asin
  WHERE inv.qty > 0;

  RAISE NOTICE '';
  RAISE NOTICE '======== manual inventory edits vs COG on record (stocked) ========';
  FOR r IN
    SELECT count(*) AS manual_rows,
           count(*) FILTER (WHERE cog_cost IS NULL) AS no_cog,
           count(*) FILTER (WHERE cog_cost IS NOT NULL AND abs(cog_cost - inv_cost) <= 0.005) AS agree,
           count(*) FILTER (WHERE cog_cost IS NOT NULL AND abs(cog_cost - inv_cost) > 0.005) AS differ,
           round(sum(qty * (COALESCE(cog_cost, inv_cost) - inv_cost))::numeric, 2) AS value_delta
    FROM _m WHERE unit_cost_manual IS TRUE AND inv_cost IS NOT NULL AND ovr_cost IS NULL
  LOOP
    RAISE NOTICE '  manual stocked rows: %', r.manual_rows;
    RAISE NOTICE '    no COG on record      : %', r.no_cog;
    RAISE NOTICE '    COG agrees (<=$0.005) : %', r.agree;
    RAISE NOTICE '    COG differs           : %', r.differ;
    RAISE NOTICE '    valuation change if COG wins: %', r.value_delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- which was edited more recently, the COG or the inventory cost? --';
  FOR r IN
    SELECT count(*) FILTER (WHERE cog_updated > manual_cost_updated_at) AS cog_newer,
           count(*) FILTER (WHERE cog_updated <= manual_cost_updated_at) AS manual_newer,
           count(*) FILTER (WHERE manual_cost_updated_at IS NULL) AS manual_undated
    FROM _m
    WHERE unit_cost_manual IS TRUE AND inv_cost IS NOT NULL AND ovr_cost IS NULL
      AND cog_cost IS NOT NULL AND abs(cog_cost - inv_cost) > 0.005
  LOOP
    RAISE NOTICE '    COG edited more recently   : %', r.cog_newer;
    RAISE NOTICE '    inventory edited more recent: %', r.manual_newer;
    RAISE NOTICE '    inventory edit has no date : %', r.manual_undated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- the 10 biggest manual-vs-COG disagreements --';
  FOR r IN
    SELECT asin, sku, qty, inv_cost, cog_cost, cog_source,
           round((qty * (cog_cost - inv_cost))::numeric, 2) AS delta
    FROM _m
    WHERE unit_cost_manual IS TRUE AND inv_cost IS NOT NULL AND ovr_cost IS NULL
      AND cog_cost IS NOT NULL AND abs(cog_cost - inv_cost) > 0.005
    ORDER BY abs(qty * (cog_cost - inv_cost)) DESC LIMIT 10
  LOOP
    RAISE NOTICE '    % qty=% manual=% cog=% (%) delta=%', r.asin, r.qty, r.inv_cost, r.cog_cost, r.cog_source, r.delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== asin_cost_overrides vs COG (stocked) ========';
  FOR r IN
    SELECT count(*) AS ovr_rows,
           count(*) FILTER (WHERE cog_cost IS NOT NULL AND abs(cog_cost - ovr_cost) > 0.005) AS differ,
           round(sum(qty * (COALESCE(cog_cost, ovr_cost) - ovr_cost))::numeric, 2) AS value_delta
    FROM _m WHERE ovr_cost IS NOT NULL
  LOOP
    RAISE NOTICE '  override stocked rows: %  differing from COG: %  valuation change if COG wins: %',
      r.ovr_rows, r.differ, r.value_delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- are the 27 overrides still being maintained? --';
  FOR r IN
    SELECT min(effective_from) AS oldest, max(effective_from) AS newest, count(*) AS n
    FROM public.asin_cost_overrides WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '    % rows, effective_from % .. %', r.n, r.oldest, r.newest;
  END LOOP;

  DROP TABLE _m;
END
$p$;
