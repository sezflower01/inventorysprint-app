-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- How many $1.00-style placeholder COGs exist across the whole COG table, and
-- how many are already affecting 2026 COGS (sold) or stock value (stocked)?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN
    WITH c AS (
      SELECT c.asin, c.unit_cost, c.source, c.reviewed_at
      FROM public.asin_cog_on_record c
      WHERE c.user_id = v_uid AND c.unit_cost > 0 AND c.unit_cost < 2
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE unit_cost = 1) AS exactly_1,
           count(*) FILTER (WHERE reviewed_at IS NULL AND source = 'import') AS unreviewed_import,
           count(*) FILTER (WHERE reviewed_at IS NOT NULL OR source = 'manual') AS set_by_seller,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = c.asin
                    AND COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0) > 0)) AS stocked,
           (SELECT count(*) FROM public.sales_orders s WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
              AND s.asin IN (SELECT asin FROM c)) AS sales_2026
    FROM c
  LOOP
    RAISE NOTICE 'COGs under $2: %  (exactly $1.00: %)  unreviewed import: %  set/reviewed by seller: %', r.n, r.exactly_1, r.unreviewed_import, r.set_by_seller;
    RAISE NOTICE '  of those, currently stocked: %   2026 sales rows priced with them: %', r.stocked, r.sales_2026;
  END LOOP;
END
$p$;
