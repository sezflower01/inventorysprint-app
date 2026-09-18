-- READ-ONLY VERIFICATION. Creates nothing, changes nothing.
-- The deployed refresh-inventory-valuation-summary wrote 67,937.63 at 00:50
-- with COG above asin_cost_overrides. Recompute today's stock value in SQL
-- under both orders and confirm (a) the summary matches COG-first and (b) the
-- difference between orders is the override swap (~ -2,068 measured).

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN
    WITH inv AS (
      SELECT i.asin, i.sku,
             COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) AS qty,
             i.cost AS inv_cost, i.unit_cost_manual
      FROM public.inventory i
      WHERE i.user_id = v_uid AND UPPER(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
    ),
    cl AS (
      SELECT DISTINCT ON (sku) sku, CASE WHEN amount > 0 THEN amount WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
      FROM public.created_listings WHERE user_id = v_uid AND sku IS NOT NULL ORDER BY sku, created_at DESC
    ),
    cl_asin AS (
      SELECT DISTINCT ON (asin) asin, CASE WHEN amount > 0 THEN amount WHEN cost > 0 AND units > 0 THEN cost / units END AS unit_cost
      FROM public.created_listings WHERE user_id = v_uid AND asin IS NOT NULL ORDER BY asin, created_at DESC
    ),
    ovr AS (
      SELECT DISTINCT ON (asin) asin, unit_cost FROM public.asin_cost_overrides
      WHERE user_id = v_uid AND effective_from <= CURRENT_DATE
        AND date_part('year', effective_from) = date_part('year', CURRENT_DATE) AND unit_cost > 0
      ORDER BY asin, effective_from DESC
    ),
    x AS (
      SELECT inv.qty,
             o.unit_cost AS ovr, c.unit_cost AS cog,
             CASE WHEN inv.unit_cost_manual IS TRUE THEN inv.inv_cost END AS manual,
             COALESCE(cl.unit_cost, cl_asin.unit_cost) AS listing, inv.inv_cost
      FROM inv
      LEFT JOIN cl ON cl.sku = inv.sku
      LEFT JOIN cl_asin ON cl_asin.asin = inv.asin
      LEFT JOIN ovr o ON o.asin = inv.asin
      LEFT JOIN public.asin_cog_for_repricer c ON c.user_id = v_uid AND c.asin = inv.asin
      WHERE inv.qty > 0
    )
    SELECT round(sum(qty * COALESCE(cog, ovr, manual, listing, inv_cost, 0))::numeric, 2) AS cog_first,
           round(sum(qty * COALESCE(ovr, cog, manual, listing, inv_cost, 0))::numeric, 2) AS override_first,
           (SELECT round(value::numeric, 2) FROM public.inventory_valuation_summary WHERE user_id = v_uid) AS summary
    FROM x
  LOOP
    RAISE NOTICE 'COG first (new): %   override first (old): %   difference: %', r.cog_first, r.override_first, r.cog_first - r.override_first;
    RAISE NOTICE 'stored summary: %   matches new model: %', r.summary, abs(r.summary - r.cog_first) < 1;
  END LOOP;
END
$p$;
