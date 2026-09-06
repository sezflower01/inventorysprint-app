-- PROBE (read-only): the 6,697 orders with no cost -- exposure versus damage.
--
-- 6,697 live orders carry sales_orders.unit_cost = 0, out of 72,306. But that
-- is the STORED field, and the P&L does not read it directly: it calls
-- resolve_unit_cost_v1, which only takes a locked snapshot at rung 1 and
-- otherwise falls through to overrides, cost_history, purchase batches,
-- listings and inventory. An order with unit_cost = 0 and no lock can still
-- resolve to a perfectly good cost at read time.
--
-- So the damage is only the orders that resolve to ZERO after the whole
-- ladder has run. Those book revenue against no cost, which overstates profit
-- by the full margin rather than by a fraction of it.
--
-- Four questions, in order:
--   1. How many actually resolve to zero, by year -- exposure vs damage.
--   2. Of those, how much REVENUE do they carry? That is the overstatement.
--   3. Are they real sales, or the known $0-revenue / cancelled junk classes?
--   4. Is the cost recoverable -- does the ASIN exist in listings or inventory
--      at all, or is there genuinely nothing to resolve from?
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== 1. stored zero vs RESOLVED zero, by year ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*)                                                  AS stored_zero,
           count(*) FILTER (WHERE res.unit_cost > 0)                 AS resolves_fine,
           count(*) FILTER (WHERE COALESCE(res.unit_cost,0) = 0)     AS still_zero
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % stored zero | % resolve fine | % STILL ZERO',
      r.yr, r.stored_zero, r.resolves_fine, r.still_zero;
  END LOOP;

  -- 2. The money. Revenue booked against no cost at all.
  RAISE NOTICE '';
  RAISE NOTICE '======== 2. revenue carried by the still-zero orders ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(COALESCE(s.item_price,0)),2)          AS revenue,
           count(*) FILTER (WHERE COALESCE(s.item_price,0) = 0) AS also_zero_revenue
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND COALESCE(res.unit_cost,0) = 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders / % units | revenue $% | % of them also have $0 revenue',
      r.yr, r.orders, r.units, r.revenue, r.also_zero_revenue;
  END LOOP;

  -- 3. 2026 by month, since that is the year being watched.
  RAISE NOTICE '';
  RAISE NOTICE '======== 3. 2026 by month: still-zero orders and their revenue ========';
  n := 0;
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date),'YYYY-MM') AS mon,
           count(*) AS orders,
           round(sum(COALESCE(s.item_price,0)),2) AS revenue,
           count(*) FILTER (WHERE COALESCE(s.item_price,0) > 0) AS with_revenue
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND COALESCE(res.unit_cost,0) = 0
      AND s.order_date >= '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    n := n + 1;
    RAISE NOTICE '   % : % orders | $% revenue | % with a real price',
      r.mon, r.orders, r.revenue, r.with_revenue;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none in 2026)'; END IF;

  -- 4. Recoverable or not?
  RAISE NOTICE '';
  RAISE NOTICE '======== 4. is there anything to resolve FROM? ========';
  FOR r IN
    SELECT count(*) AS orders,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.created_listings cl
                                           WHERE cl.user_id = s.user_id AND cl.asin = s.asin)) AS has_listing,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inventory i
                                           WHERE i.user_id = s.user_id AND i.asin = s.asin
                                             AND COALESCE(i.cost,0) > 0)) AS has_inventory_cost,
           count(*) FILTER (WHERE s.asin IS NULL OR btrim(s.asin) = ''
                              OR s.asin IN ('UNKNOWN','PENDING')) AS no_usable_asin
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND COALESCE(res.unit_cost,0) = 0
  LOOP
    RAISE NOTICE '   % still-zero orders | % have a created_listings row | % have inventory with a cost | % have no usable ASIN',
      r.orders, r.has_listing, r.has_inventory_cost, r.no_usable_asin;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- biggest still-zero ASINs by revenue --';
  n := 0;
  FOR r IN
    SELECT s.asin, count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(COALESCE(s.item_price,0)),2) AS revenue,
           EXISTS (SELECT 1 FROM public.created_listings cl WHERE cl.user_id = s.user_id AND cl.asin = s.asin) AS has_listing,
           EXISTS (SELECT 1 FROM public.inventory i WHERE i.user_id = s.user_id AND i.asin = s.asin AND COALESCE(i.cost,0) > 0) AS has_inv_cost,
           left(max(s.title), 26) AS title
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND COALESCE(res.unit_cost,0) = 0
      AND COALESCE(s.item_price,0) > 0
    GROUP BY s.asin, s.user_id ORDER BY revenue DESC LIMIT 12
  LOOP
    n := n + 1;
    RAISE NOTICE '   % : % orders / % units | $% revenue | listing=% inv_cost=% | %',
      r.asin, r.orders, r.units, r.revenue, r.has_listing, r.has_inv_cost, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none with revenue)'; END IF;
END
$probe$;
