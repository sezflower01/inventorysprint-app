-- READ-ONLY VERIFICATION. Creates nothing, changes nothing.
--
-- The Shipment Builder runs its cost lookup in the browser as the signed-in
-- seller, so every source must be readable under RLS -- including the new
-- view asin_cog_for_repricer (security_invoker) queried WITHOUT a user_id
-- filter, exactly as the page does. Re-run the draft valuation as that role
-- and confirm it matches the figure measured as postgres (302,983.69).

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  FOR r IN SELECT
      (SELECT count(*) FROM public.asin_cog_for_repricer) AS cog_rows,
      (SELECT count(*) FROM public.asin_cost_overrides) AS ovr_rows,
      (SELECT count(*) FROM public.created_listings) AS cl_rows,
      (SELECT count(DISTINCT user_id) FROM public.asin_cog_for_repricer) AS distinct_users
  LOOP
    RAISE NOTICE 'as seller: COG view readable = % rows (distinct users %), overrides %, created_listings %',
      r.cog_rows, r.distinct_users, r.ovr_rows, r.cl_rows;
  END LOOP;

  -- Same chain the page applies, run as the seller.
  FOR r IN
    WITH items AS (
      SELECT upper(trim(it->>'asin')) AS asin, max(COALESCE((it->>'qtyToShip')::numeric, 0)) AS qty
      FROM public.shipment_builder_drafts d,
           LATERAL jsonb_path_query(to_jsonb(d), 'lax $.**[*] ? (@.asin != null)') it
      WHERE d.user_id = v_uid AND it->>'asin' ~ '^[A-Za-z0-9]{10}$'
      GROUP BY d.id, upper(trim(it->>'asin'))
    ),
    cl AS (
      SELECT DISTINCT ON (upper(trim(asin))) upper(trim(asin)) AS asin,
             CASE WHEN amount >= 0 THEN amount WHEN cost > 0 AND units > 0 THEN cost / units ELSE 0 END AS unit_cost
      FROM public.created_listings WHERE asin IS NOT NULL
      ORDER BY upper(trim(asin)), updated_at DESC
    ),
    ovr AS (
      SELECT DISTINCT ON (asin) asin, unit_cost FROM public.asin_cost_overrides
      WHERE effective_from <= CURRENT_DATE AND unit_cost > 0
      ORDER BY asin, effective_from DESC, created_at DESC
    )
    SELECT round(sum(i.qty * COALESCE(o.unit_cost, v.unit_cost, NULLIF(cl.unit_cost, 0), NULLIF(inv.cost, 0), 0))::numeric, 2) AS value_new,
           round(sum(i.qty * COALESCE(NULLIF(cl.unit_cost, 0), 0))::numeric, 2) AS value_old,
           count(*) AS rows
    FROM items i
    LEFT JOIN cl ON cl.asin = i.asin
    LEFT JOIN ovr o ON o.asin = i.asin
    LEFT JOIN public.asin_cog_for_repricer v ON v.asin = i.asin
    LEFT JOIN LATERAL (SELECT cost FROM public.inventory i2 WHERE i2.asin = i.asin AND i2.cost > 0 LIMIT 1) inv ON true
  LOOP
    RAISE NOTICE 'as seller: % item rows | old $% | new $% (expect 302983.69)', r.rows, r.value_old, r.value_new;
  END LOOP;

  SET LOCAL ROLE postgres;
END
$p$;
