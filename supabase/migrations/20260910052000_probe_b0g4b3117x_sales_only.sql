-- PROBE (read-only): B0G4B3117X, sales only. The second pass was cut off by 40+
-- cost_history rows before reaching the sales section, which is the part that
-- decides the repair.
--
-- Already established:
--   * 25 lots / 300 units now read 7.75 per unit (lot 93 for 12), dated
--     2026-05-24..25 and EDITED 2026-09-11 -- the seller has entered the
--     lower cost already.
--   * asin_cost_overrides holds 14.5625 effective 2026-05-02. Overrides are
--     step 2 of the resolver and outrank purchases, listings and cost_history.
--   * resolveUnitCost Tier C excludes a listing whose updated_at is after the
--     order date, so lots edited today are invisible to every past order.
--
-- So the listing edit alone moves nothing. What remains is which sales are
-- locked, at what cost, and on which dates relative to the 7.75 lots.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== sales grouped by lock state, unit cost and source ========';
  FOR r IN
    SELECT COALESCE(cost_locked,false) AS locked,
           round(COALESCE(unit_cost_at_sale, unit_cost)::numeric, 4) AS unit,
           COALESCE(cost_source_at_sale,'(none)') AS src,
           count(*) AS orders, sum(quantity) AS units,
           min(order_date) AS first_sale, max(order_date) AS last_sale,
           round(sum(total_cost)::numeric, 2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1, 2, 3 ORDER BY min(order_date)
  LOOP
    RAISE NOTICE '   locked=%  unit=%  src=%', r.locked, r.unit, r.src;
    RAISE NOTICE '        % orders, % units, % .. %, COGS %',
      r.orders, r.units, r.first_sale, r.last_sale, r.cogs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== sales before vs after the 7.75 lots were bought (2026-05-24) ========';
  FOR r IN
    SELECT CASE WHEN order_date < '2026-05-24' THEN 'before 2026-05-24'
                ELSE 'on/after 2026-05-24' END AS period,
           count(*) AS orders, sum(quantity) AS units,
           count(*) FILTER (WHERE cost_locked) AS locked,
           round(sum(total_cost)::numeric, 2) AS cogs,
           round(sum(quantity * 7.75)::numeric, 2) AS cogs_at_7_75
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders, % units (% locked) | COGS booked % | at 7.75 would be %',
      rpad(r.period,20), r.orders, r.units, r.locked, r.cogs, r.cogs_at_7_75;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== units bought vs units sold, in date order ========';
  FOR r IN
    SELECT 'bought @14.56-15.89' AS what, sum(units) AS n
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin AND round((cost/NULLIF(units,0))::numeric,2) > 10
    UNION ALL
    SELECT 'bought @7.75', sum(units)
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin AND round((cost/NULLIF(units,0))::numeric,2) < 10
    UNION ALL
    SELECT 'sold before 2026-05-24', sum(quantity)
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND order_date < '2026-05-24'
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
    UNION ALL
    SELECT 'sold on/after 2026-05-24', sum(quantity)
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND order_date >= '2026-05-24'
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   %  %', rpad(r.what,26), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the 15 most recent sales ========';
  FOR r IN
    SELECT order_date, order_id, marketplace, quantity,
           unit_cost, unit_cost_at_sale, cost_locked, cost_source_at_sale, total_cost, order_status
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY order_date DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % % % qty=% unit=% at_sale=% locked=% src=% cogs=% %',
      r.order_date, r.order_id, r.marketplace, r.quantity, r.unit_cost, r.unit_cost_at_sale,
      r.cost_locked, r.cost_source_at_sale, r.total_cost, r.order_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== by month ========';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS orders, sum(quantity) AS units,
           count(*) FILTER (WHERE cost_locked) AS locked,
           round(avg(COALESCE(unit_cost_at_sale, unit_cost))::numeric, 2) AS avg_unit,
           round(sum(total_cost)::numeric, 2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders, % units, % locked, avg unit %, COGS %',
      r.mon, r.orders, r.units, r.locked, r.avg_unit, r.cogs;
  END LOOP;
END
$probe$;
