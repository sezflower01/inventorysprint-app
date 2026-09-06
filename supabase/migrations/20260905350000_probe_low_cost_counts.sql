-- PROBE (read-only): the two sections that scrolled off the sweep --
-- the per-source counts, and the orders whose RESOLVED cost is under $0.50.
-- Plus a count of the inventory rows carrying the same Contract A inversion
-- the listing rows had, since the sweep showed those exist in quantity.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '### unit cost > 0 but < $0.50, by source ###';
  FOR r IN
    SELECT 'sales_orders.unit_cost' AS src, count(*) AS hits FROM public.sales_orders WHERE unit_cost > 0 AND unit_cost < 0.50
    UNION ALL SELECT 'sales_orders.unit_cost_at_sale', count(*) FROM public.sales_orders WHERE unit_cost_at_sale > 0 AND unit_cost_at_sale < 0.50
    UNION ALL SELECT 'asin_cost_overrides.unit_cost', count(*) FROM public.asin_cost_overrides WHERE unit_cost > 0 AND unit_cost < 0.50
    UNION ALL SELECT 'cost_history.cost', count(*) FROM public.cost_history WHERE cost > 0 AND cost < 0.50
    UNION ALL SELECT 'created_listing_purchases.unit_cost', count(*) FROM public.created_listing_purchases WHERE unit_cost > 0 AND unit_cost < 0.50
    UNION ALL SELECT 'created_listings.amount (UNIT)', count(*) FROM public.created_listings WHERE amount > 0 AND amount < 0.50
    UNION ALL SELECT 'inventory.cost (UNIT)', count(*) FROM public.inventory WHERE cost > 0 AND cost < 0.50
    ORDER BY 2 DESC
  LOOP RAISE NOTICE '%-38s : %', r.src, r.hits; END LOOP;

  -- The only figures that are actually mis-stated money.
  RAISE NOTICE '';
  RAISE NOTICE '### orders whose RESOLVED unit cost is under $0.50 ###';
  n := 0;
  FOR r IN
    SELECT s.asin, COALESCE(s.seller_sku, s.sku) AS sku,
           res.unit_cost, res.source,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(min(NULLIF(s.item_price,0)),2) AS min_price,
           round(max(s.item_price),2) AS max_price
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.unit_cost > 0 AND res.unit_cost < 0.50
    GROUP BY 1,2,3,4
    ORDER BY sum(COALESCE(s.quantity,1)) DESC
    LIMIT 25
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% UNIT $% [%] | % orders / % units | sells $%..$%',
      r.asin, r.sku, r.unit_cost, r.source, r.orders, r.units, r.min_price, r.max_price;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  FOR r IN
    SELECT count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)), 2) AS booked_cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.unit_cost > 0 AND res.unit_cost < 0.50
  LOOP
    RAISE NOTICE 'TOTAL: % orders, % units, booked COGS $% at these sub-50c costs',
      r.orders, r.units, r.booked_cogs;
  END LOOP;

  -- The $1-placeholder class the sweep exposed: a whole lot recorded as
  -- costing exactly one dollar.
  RAISE NOTICE '';
  RAISE NOTICE '### created_listings with cost(TOTAL) = exactly $1 and units > 1 ###';
  FOR r IN
    SELECT count(*) AS rows, sum(units) AS units
    FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1
  LOOP RAISE NOTICE '% rows covering % units', r.rows, r.units; END LOOP;

  -- Same inversion as the listing rows, in inventory. Contract A INVERTS
  -- here: cost = UNIT, amount = TOTAL.
  RAISE NOTICE '';
  RAISE NOTICE '### inventory rows inconsistent under Contract A ###';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE COALESCE(units,0) > 1 AND COALESCE(cost,0) > 0 AND COALESCE(amount,0) > 0
                              AND abs(amount - cost * units) > GREATEST(0.01, abs(cost * units) * 0.005)) AS inconsistent,
           count(*) FILTER (WHERE COALESCE(units,0) > 1 AND COALESCE(cost,0) > 0 AND COALESCE(amount,0) > 0
                              AND abs(amount - cost) < 0.005) AS unit_written_into_total,
           count(*) FILTER (WHERE COALESCE(units,0) > 0 AND COALESCE(cost,0) > 0 AND COALESCE(amount,0) > 0
                              AND abs(amount - cost * units) > GREATEST(0.01, abs(cost * units) * 0.005)
                              AND amount / NULLIF(units,0) < cost) AS safe_would_understate
    FROM public.inventory
  LOOP
    RAISE NOTICE 'inventory: % rows | % inconsistent | % are unit-in-total | % where getInventoryUnitCostSafe would return the SMALLER wrong value',
      r.total, r.inconsistent, r.unit_written_into_total, r.safe_would_understate;
  END LOOP;
END
$probe$;
