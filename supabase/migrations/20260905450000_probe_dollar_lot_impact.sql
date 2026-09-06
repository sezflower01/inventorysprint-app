-- PROBE (read-only): the $1 placeholder lots -- exposure versus actual damage.
--
-- 108 created_listings rows carry cost = exactly $1.00 across 14,529 units,
-- and 440 orders fell in 2026 on those ASINs. But "440 orders on an affected
-- ASIN" is exposure, not damage -- the same conflation corrected on the
-- inventory rows an hour ago. An order is only wrong if the ladder actually
-- HANDED IT a cost derived from a $1 lot.
--
-- So this asks three separate questions in order:
--   1. What do those listing rows look like -- is $1 a placeholder, or a real
--      cheap lot? A $1 total over 134 units is $0.0075 each; a $1 total over
--      2 units is 50c each and might be genuine.
--   2. What cost did the orders on those ASINs actually RESOLVE to, and from
--      which rung? If they resolve from a locked snapshot or a later good lot,
--      the $1 row is inert.
--   3. Only for orders that really did take a sub-plausible cost: which
--      months, and how much.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== 1. shape of the $1 lots ========';
  FOR r IN
    SELECT count(*) AS rows, sum(units) AS units,
           round(avg(units),1) AS avg_units,
           count(*) FILTER (WHERE units <= 2)  AS tiny_lots,
           count(*) FILTER (WHERE units > 50)  AS big_lots,
           round(min(1.0/units), 6) AS smallest_derived_unit,
           round(max(1.0/units), 4) AS largest_derived_unit
    FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1
  LOOP
    RAISE NOTICE '% rows / % units | avg % units per lot | % lots of <=2 units | % lots of >50 | derived unit ranges $% .. $%',
      r.rows, r.units, r.avg_units, r.tiny_lots, r.big_lots, r.smallest_derived_unit, r.largest_derived_unit;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- the ten biggest, with what the item sells for --';
  FOR r IN
    SELECT cl.asin, cl.sku, cl.units, cl.amount, cl.date_created,
           round(sp.max_price,2) AS max_price, sp.orders,
           left(COALESCE(cl.title,''),28) AS title
    FROM public.created_listings cl
    LEFT JOIN LATERAL (
      SELECT max(s.item_price) AS max_price, count(*) AS orders
      FROM public.sales_orders s WHERE s.user_id = cl.user_id AND s.asin = cl.asin
    ) sp ON true
    WHERE cl.cost = 1 AND COALESCE(cl.units,0) > 1
    ORDER BY cl.units DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % units=% amount(UNIT)=$% created=% | sells to $% (% orders) | %',
      r.asin, r.units, r.amount, r.date_created, r.max_price, r.orders, r.title;
  END LOOP;

  -- 2. What the orders on those ASINs actually resolve to.
  RAISE NOTICE '';
  RAISE NOTICE '======== 2. how orders on those ASINs actually resolve ========';
  FOR r IN
    SELECT res.source,
           count(*) AS orders,
           round(min(res.unit_cost),4) AS min_unit,
           round(max(res.unit_cost),2) AS max_unit,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)),2) AS cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE s.asin IN (SELECT asin FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1)
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   [%] % orders | unit $% .. $% | $% booked',
      r.source, r.orders, r.min_unit, r.max_unit, r.cogs;
  END LOOP;

  -- 3. The damage: orders whose resolved cost is implausible against the price.
  RAISE NOTICE '';
  RAISE NOTICE '======== 3. DAMAGE: orders on a $1 ASIN resolving below 5%% of sale price ========';
  n := 0;
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date),'YYYY-MM') AS mon,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)),2) AS booked
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE s.asin IN (SELECT asin FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1)
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.unit_cost > 0
      AND COALESCE(s.item_price,0) > 0
      AND res.unit_cost < s.item_price * 0.05
    GROUP BY 1 ORDER BY 1
  LOOP
    n := n + 1;
    RAISE NOTICE '   % : % orders / % units, $% booked', r.mon, r.orders, r.units, r.booked;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none -- the $1 rows are inert; nothing resolves off them)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '-- which ASINs, if any --';
  n := 0;
  FOR r IN
    SELECT s.asin, res.unit_cost, res.source, count(*) AS orders,
           sum(COALESCE(s.quantity,1)) AS units,
           round(max(s.item_price),2) AS max_price
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE s.asin IN (SELECT asin FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1)
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.unit_cost > 0 AND COALESCE(s.item_price,0) > 0
      AND res.unit_cost < s.item_price * 0.05
    GROUP BY 1,2,3 ORDER BY units DESC LIMIT 15
  LOOP
    n := n + 1;
    RAISE NOTICE '   % $% [%] : % orders / % units, sells to $%',
      r.asin, r.unit_cost, r.source, r.orders, r.units, r.max_price;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;
END
$probe$;
