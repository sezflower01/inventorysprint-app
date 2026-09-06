-- PROBE (read-only): current state of every cost defect found today, measured
-- rather than recalled. Answers "is everything fixed" with numbers.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== 1. created_listings Contract A (repaired 11 of 12) ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (
             WHERE COALESCE(units,0) > 0 AND COALESCE(amount,0) > 0 AND COALESCE(cost,0) > 0
               AND abs(cost - amount * units) > GREATEST(0.01, abs(amount * units) * 0.005)
           ) AS inconsistent
    FROM public.created_listings
  LOOP RAISE NOTICE '% rows | % still inconsistent', r.total, r.inconsistent; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. inventory Contract A (NOT yet touched) ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE COALESCE(units,0) > 1 AND COALESCE(cost,0) > 0 AND COALESCE(amount,0) > 0
                              AND abs(amount - cost * units) > GREATEST(0.01, abs(cost * units) * 0.005)) AS inconsistent,
           count(*) FILTER (WHERE COALESCE(units,0) > 0 AND COALESCE(cost,0) > 0 AND COALESCE(amount,0) > 0
                              AND abs(amount - cost * units) > GREATEST(0.01, abs(cost * units) * 0.005)
                              AND amount / NULLIF(units,0) < cost) AS safe_would_understate
    FROM public.inventory
  LOOP RAISE NOTICE '% rows | % inconsistent | % where the Safe helper would return the smaller wrong value',
    r.total, r.inconsistent, r.safe_would_understate; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. orders still RESOLVING under $0.50 ========';
  FOR r IN
    SELECT count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)),2) AS booked_cogs,
           count(DISTINCT s.asin) AS asins
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
  LOOP RAISE NOTICE '% orders / % units across % ASINs, booking $%',
    r.orders, r.units, r.asins, r.booked_cogs; END LOOP;

  RAISE NOTICE '   -- which ASINs are left --';
  FOR r IN
    SELECT s.asin, res.unit_cost, count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
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
    GROUP BY 1,2 ORDER BY units DESC LIMIT 12
  LOOP RAISE NOTICE '   % $% : % orders / % units (sells up to $%)',
    r.asin, r.unit_cost, r.orders, r.units, r.max_price; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. $1 placeholder lots (NOT touched -- awaiting records) ========';
  FOR r IN SELECT count(*) AS rows, sum(units) AS units FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1
  LOOP RAISE NOTICE '% rows covering % units', r.rows, r.units; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. the other class: no cost at all ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE COALESCE(unit_cost,0) = 0) AS zero_cost,
           count(*) FILTER (WHERE cost_invalid = true) AS flagged
    FROM public.sales_orders
    WHERE COALESCE(is_cancelled,false) = false AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
  LOOP RAISE NOTICE '% live orders | % with unit_cost 0 | % flagged cost_invalid', r.total, r.zero_cost, r.flagged; END LOOP;
END
$probe$;
