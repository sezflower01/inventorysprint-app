-- PROBE (read-only): 242 enabled assignments have no inventory row, after the
-- sweep earlier today disabled 231 of that same class. Only 3 assignments were
-- created since. So these are not new assignments -- they are assignments whose
-- INVENTORY ROW went away underneath them.
--
-- Which raises the question the seller cares about: is the listing dead, or did
-- an inventory sync drop the row? Same question as earlier, same test -- sales
-- are proof of life, because Amazon reports what sold regardless of what the
-- local inventory table says.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== the 242: which rule, which marketplace ========';
  FOR r IN
    SELECT COALESCE(rr.name, '(no rule)') AS rule_name, a.marketplace, count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    GROUP BY 1,2 ORDER BY n DESC LIMIT 12
  LOOP
    RAISE NOTICE '   %  %  : % rows', rpad(left(r.rule_name,28),28), r.marketplace, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== when were these assignments created? ========';
  FOR r IN
    SELECT date_trunc('month', a.created_at)::date AS mon, count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    GROUP BY 1 ORDER BY 1 DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % : % assignments', r.mon, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== PROOF OF LIFE: has anything sold on these ASINs? ========';
  FOR r IN
    WITH orph AS (
      SELECT DISTINCT a.asin, a.sku
      FROM public.repricer_assignments a
      LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
      WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    )
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = v_uid AND s.asin = orph.asin
          AND s.order_date > now() - interval '90 days')) AS sold_90d,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = v_uid AND s.asin = orph.asin
          AND s.order_date > now() - interval '365 days')) AS sold_365d,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = v_uid AND s.asin = orph.asin)) AS sold_ever
    FROM orph
  LOOP
    RAISE NOTICE '   % orphan (asin,sku) pairs', r.total;
    RAISE NOTICE '   % sold in the last 90 days   <- ALIVE, do not touch', r.sold_90d;
    RAISE NOTICE '   % sold in the last 365 days', r.sold_365d;
    RAISE NOTICE '   % ever sold at all', r.sold_ever;
    RAISE NOTICE '   -> % never sold in a year and no inventory row', r.total - r.sold_365d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== does the ASIN exist in inventory under a DIFFERENT sku? ========';
  FOR r IN
    WITH orph AS (
      SELECT DISTINCT a.asin, a.sku
      FROM public.repricer_assignments a
      LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
      WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
    )
    SELECT count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.inventory i2
             WHERE i2.user_id = v_uid AND i2.asin = orph.asin)) AS asin_present_other_sku,
           count(*) AS total
    FROM orph
  LOOP
    RAISE NOTICE '   % of % have the ASIN in inventory under another SKU',
      r.asin_present_other_sku, r.total;
    RAISE NOTICE '   (those are SKU renames / relistings, not dead listings)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== has the inventory table itself shrunk today? ========';
  FOR r IN
    SELECT count(*) AS rows_now,
           count(*) FILTER (WHERE updated_at > now() - interval '12 hours') AS touched_12h,
           max(updated_at) AS newest
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % inventory rows | % touched in 12h | newest %',
      r.rows_now, r.touched_12h, r.newest;
  END LOOP;
END
$probe$;
