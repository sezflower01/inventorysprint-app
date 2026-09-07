-- PROBE (read-only): are the orphaned assignments genuinely dead, or did an
-- inventory sync drop them?
--
-- 257 enabled assignments have no matching inventory row. Disabling a live,
-- sellable listing because a sync missed it would be worse than leaving the
-- quota bleed, so this has to be settled before anything is switched off.
--
-- The decisive test is SALES. Amazon tells us what sold, independently of our
-- inventory sync -- if one of these ASINs sold recently it is unquestionably
-- live and must not be disabled. Everything else here is supporting evidence:
-- whether the SKU exists anywhere else (different case, different marketplace,
-- created_listings), and how old the assignment is.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== the decisive test: have these ASINs SOLD? ========';
  FOR r IN
    SELECT count(*) AS orphans,
           count(*) FILTER (WHERE s.units_30d  > 0) AS sold_30d,
           count(*) FILTER (WHERE s.units_90d  > 0) AS sold_90d,
           count(*) FILTER (WHERE s.units_365d > 0) AS sold_365d,
           count(*) FILTER (WHERE COALESCE(s.units_365d,0) = 0) AS never_sold_a_year
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(so.quantity) FILTER (WHERE so.order_date >= current_date - 30), 0)  AS units_30d,
        COALESCE(sum(so.quantity) FILTER (WHERE so.order_date >= current_date - 90), 0)  AS units_90d,
        COALESCE(sum(so.quantity) FILTER (WHERE so.order_date >= current_date - 365), 0) AS units_365d
      FROM public.sales_orders so
      WHERE so.user_id = a.user_id AND so.asin = a.asin
        AND COALESCE(so.is_cancelled, false) = false
    ) s ON true
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
  LOOP
    RAISE NOTICE '   % orphaned+enabled | sold in 30d: % | 90d: % | 365d: % | nothing in a year: %',
      r.orphans, r.sold_30d, r.sold_90d, r.sold_365d, r.never_sold_a_year;
    IF r.sold_30d > 0 THEN
      RAISE NOTICE '   *** % sold within 30 days -- those are LIVE, do not disable ***', r.sold_30d;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== does the SKU exist anywhere else? ========';
  FOR r IN
    SELECT count(*) AS orphans,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.inventory i2
             WHERE i2.user_id = a.user_id AND lower(i2.sku) = lower(a.sku))) AS case_variant,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.inventory i3
             WHERE i3.user_id = a.user_id AND i3.asin = a.asin)) AS asin_in_inventory,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.created_listings cl
             WHERE cl.user_id = a.user_id AND cl.sku = a.sku)) AS in_created_listings
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
  LOOP
    RAISE NOTICE '   % orphans | SKU exists with different case: % | ASIN exists in inventory: % | in created_listings: %',
      r.orphans, r.case_variant, r.asin_in_inventory, r.in_created_listings;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how old are they, and by marketplace ========';
  FOR r IN
    SELECT a.marketplace, count(*) AS n,
           min(a.created_at)::date AS oldest,
           max(a.created_at)::date AS newest,
           count(*) FILTER (WHERE a.last_evaluated_at > now() - interval '1 day') AS evaluated_today
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    GROUP BY a.marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % : % orphans | created % .. % | % evaluated today',
      r.marketplace, r.n, r.oldest, r.newest, r.evaluated_today;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== a sample, with any sales history ========';
  n := 0;
  FOR r IN
    SELECT a.asin, a.sku, a.marketplace, a.created_at::date AS created,
           COALESCE(s.units_365d, 0) AS sold_year, a.last_evaluated_at::date AS last_eval
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.quantity) FILTER (WHERE so.order_date >= current_date - 365), 0) AS units_365d
      FROM public.sales_orders so
      WHERE so.user_id = a.user_id AND so.asin = a.asin AND COALESCE(so.is_cancelled,false) = false
    ) s ON true
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    ORDER BY COALESCE(s.units_365d,0) DESC, a.created_at DESC
    LIMIT 12
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | %-26s | % | created % | sold %/yr | last eval %',
      r.asin, left(r.sku,26), r.marketplace, r.created, r.sold_year, r.last_eval;
  END LOOP;
END
$probe$;
