-- PROBE (read-only): what do the 85 inconsistent inventory rows actually cost
-- in booked P&L, as opposed to what they could cost?
--
-- IMPORTANT DISTINCTION I BLURRED. "10,959 orders in 2026 across 84 ASINs" is
-- the count of orders whose ASIN HAS a bad inventory row. It is exposure, not
-- damage. inventory is rung 5 of resolve_unit_cost_v1 -- the last resort --
-- and almost every order resolves at rung 1 from its locked snapshot. So the
-- booked error is only the orders that actually came through inventoryFallback
-- carrying a wrong number, which is a much smaller and quite different set.
--
-- Second thing to establish before any repair: WHICH field is wrong. Contract A
-- says inventory.cost = UNIT and .amount = TOTAL. If amount is simply a stale
-- total from when stock was lower -- amount/cost landing on a plausible past
-- unit count -- then `cost` is fine, the cost ladder is fine, and this is an
-- inventory-valuation display problem rather than a P&L one. That is a very
-- different repair from the six lots, and guessing between them is exactly the
-- error caught earlier tonight.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== 1. is `amount` merely a STALE total? ========';
  RAISE NOTICE 'amount/cost = the stock level at which amount would have been right';
  n := 0;
  FOR r IN
    SELECT i.asin, i.sku, i.units AS stock, i.cost, i.amount,
           round(i.amount / NULLIF(i.cost,0), 1)  AS implied_past_stock,
           round(i.cost * i.units, 2)             AS total_if_cost_right,
           round(i.amount / NULLIF(i.units,0), 4) AS unit_if_amount_right,
           round(sp.max_price, 2)                 AS max_price,
           left(COALESCE(i.title,''), 26)         AS title
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT max(s.item_price) AS max_price FROM public.sales_orders s
      WHERE s.user_id = i.user_id AND s.asin = i.asin
    ) sp ON true
    WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
      AND i.amount / NULLIF(i.units,0) < i.cost
    ORDER BY i.units DESC
    LIMIT 15
  LOOP
    n := n + 1;
    RAISE NOTICE '% stock=% cost=$% amount=$% | amount/cost=% units | cost*units=$% | amount/units=$% | sells to $% | %',
      r.asin, r.stock, r.cost, r.amount, r.implied_past_stock,
      r.total_if_cost_right, r.unit_if_amount_right, r.max_price, r.title;
  END LOOP;

  -- If cost is right, it should sit sensibly under the selling price; if the
  -- amount/units figure were right instead, it would be absurdly low.
  RAISE NOTICE '';
  RAISE NOTICE '======== 2. which reading is plausible against the sale price? ========';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE sp.max_price > 0 AND i.cost < sp.max_price) AS cost_below_price,
           count(*) FILTER (WHERE sp.max_price > 0 AND (i.amount / NULLIF(i.units,0)) < sp.max_price * 0.05) AS amount_unit_absurd
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT max(s.item_price) AS max_price FROM public.sales_orders s
      WHERE s.user_id = i.user_id AND s.asin = i.asin
    ) sp ON true
    WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
      AND i.amount / NULLIF(i.units,0) < i.cost
  LOOP
    RAISE NOTICE '% rows | cost sits below the sale price on % | amount/units would be under 5%% of it on %',
      r.rows, r.cost_below_price, r.amount_unit_absurd;
  END LOOP;

  -- The only figure that is actually money: orders that resolved via rung 5.
  RAISE NOTICE '';
  RAISE NOTICE '======== 3. orders actually RESOLVING through inventoryFallback ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)),2) AS cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.source = 'inventoryFallback'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders / % units booking $%', r.yr, r.orders, r.units, r.cogs;
  END LOOP;

  -- And of those, how many land on one of the inconsistent rows?
  RAISE NOTICE '';
  RAISE NOTICE '======== 4. inventoryFallback orders landing on an INCONSISTENT row ========';
  n := 0;
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(res.unit_cost * COALESCE(s.quantity,1)),2) AS cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0) > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.source = 'inventoryFallback'
      AND s.asin IN (
        SELECT i.asin FROM public.inventory i
         WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
           AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
           AND i.amount / NULLIF(i.units,0) < i.cost)
    GROUP BY 1 ORDER BY 1
  LOOP
    n := n + 1;
    RAISE NOTICE '   % : % orders / % units, $% booked', r.mon, r.orders, r.units, r.cogs;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none -- no booked order resolves off an inconsistent inventory row)'; END IF;
END
$probe$;
