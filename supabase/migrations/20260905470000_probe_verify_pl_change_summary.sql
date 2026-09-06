-- PROBE (read-only): verify the end-of-session summary of what moved the P&L.
--
-- Re-reads the live tables rather than trusting the running notes. Three
-- claims to check:
--   1. Only the six-lot repair changed booked COGS, and by $2,092.27.
--   2. Its 2026 footprint -- which months, and how much each.
--   3. The other two data repairs (11 listing lot totals, 85 inventory
--      totals) left every unit cost the P&L reads untouched.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  CREATE TEMP TABLE _fix (asin text, old_unit numeric, new_unit numeric) ON COMMIT DROP;
  INSERT INTO _fix VALUES
    ('B00JV57NOG', 0.089,   2.29), ('B08BYX3C46', 0.10,    2.00),
    ('B07VXRVZHH', 0.1079, 10.79), ('B002J3OC7S', 0.4107, 12.32),
    ('B00G3MJ0D2', 0.10,    4.86), ('B079STG3DR', 0.25,   14.92);

  RAISE NOTICE '==== 1. total COGS change from the six-lot repair ====';
  FOR r IN
    SELECT count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(COALESCE(s.quantity,1) * (f.new_unit - f.old_unit)),2) AS delta
    FROM public.sales_orders s JOIN _fix f ON f.asin = s.asin
    WHERE s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field'
  LOOP RAISE NOTICE '% orders / % units | profit falls $%', r.orders, r.units, r.delta; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '==== 2. EVERY 2026 month it touches ====';
  n := 0;
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date),'YYYY-MM') AS mon,
           count(*) AS orders,
           round(sum(COALESCE(s.quantity,1) * (f.new_unit - f.old_unit)),2) AS delta
    FROM public.sales_orders s JOIN _fix f ON f.asin = s.asin
    WHERE s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field'
      AND s.order_date >= '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP n := n + 1; RAISE NOTICE '   % : % orders, profit falls $%', r.mon, r.orders, r.delta; END LOOP;
  RAISE NOTICE '   -> % separate 2026 months affected, not one', n;

  RAISE NOTICE '';
  RAISE NOTICE '==== 3. did the other two repairs move any unit cost? ====';
  -- The 11 listing rows: only .cost (LOT TOTAL) changed; .amount (UNIT) is what
  -- the ladder reads. Confirm each still resolves off .amount unchanged.
  FOR r IN
    SELECT count(*) AS listing_rows,
           count(*) FILTER (WHERE abs(cost - amount * units) <= GREATEST(0.01, abs(amount*units)*0.005)) AS now_consistent
    FROM public.created_listings
    WHERE asin IN ('B003A66SSE','B0792DJ2LB','B07CB1M6N7','B07DPWR6ZQ','B0BCL1G8CJ','B0DT7GF2P8',
                   'B0FK2YGWR2','B0G1ZFK88V','B0GNY5PGKS','B0GW6VWPGN','B0H1NRLXNV')
      AND COALESCE(units,0) > 0 AND COALESCE(amount,0) > 0 AND COALESCE(cost,0) > 0
  LOOP RAISE NOTICE '   listing repair: % rows on those ASINs, % consistent', r.listing_rows, r.now_consistent; END LOOP;

  -- The 85 inventory rows: only .amount (TOTAL) changed; .cost (UNIT) is the
  -- rung-5 value. Nothing that resolves through rung 5 should be under $0.50.
  FOR r IN
    SELECT count(*) AS fallback_orders,
           count(*) FILTER (WHERE res.unit_cost < 0.50) AS under_50c
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.source = 'inventoryFallback' AND res.unit_cost > 0
  LOOP RAISE NOTICE '   inventory repair: % orders resolve via rung 5, % of them under $0.50',
    r.fallback_orders, r.under_50c; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '==== 4. the unfixed 2025 gap, restated ====';
  FOR r IN
    SELECT count(*) AS orders, round(sum(COALESCE(s.item_price,0)),2) AS revenue,
           count(*) FILTER (WHERE s.asin = 'PENDING') AS pending_orders,
           round(sum(COALESCE(s.item_price,0)) FILTER (WHERE s.asin = 'PENDING'),2) AS pending_revenue
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END) res
    WHERE COALESCE(s.unit_cost,0) = 0
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND COALESCE(res.unit_cost,0) = 0
      AND s.order_date >= '2025-01-01' AND s.order_date < '2026-01-01'
  LOOP
    RAISE NOTICE '   2025: % orders, $% revenue with no cost | % of them PENDING carrying $%',
      r.orders, r.revenue, r.pending_orders, r.pending_revenue;
  END LOOP;
END
$probe$;
