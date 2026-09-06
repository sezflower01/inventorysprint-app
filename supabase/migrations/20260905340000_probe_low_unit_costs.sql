-- PROBE (read-only): sweep every unit-cost source in the database for values
-- under $0.50.
--
-- A sub-50c unit cost is not wrong by itself -- some things really do cost 30c.
-- What makes it suspicious is the SALE PRICE beside it: $0.18 against a $22
-- sale is the arithmetic signature of the Contract A inversion just repaired
-- (cost/units applied to a row where cost already held the unit value), not a
-- bargain. So every list below carries the price the item actually sells for.
--
-- Sources swept, in the order the cost ladder consults them:
--   sales_orders.unit_cost / unit_cost_at_sale   (what is already booked)
--   asin_cost_overrides.unit_cost                (rung 2)
--   cost_history.cost                            (rung 3a)
--   created_listing_purchases.unit_cost          (rung 3b)
--   created_listings.amount                      (rung 3b/4, UNIT per Contract A)
--   inventory.cost                               (rung 5, UNIT per Contract A)
--   resolve_unit_cost_v1                         (what P&L and Sales Report use)
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '################ COUNTS: unit cost > 0 but < $0.50 ################';
  FOR r IN
    SELECT 'sales_orders.unit_cost'        AS src, count(*) AS hits FROM public.sales_orders        WHERE unit_cost         > 0 AND unit_cost         < 0.50
    UNION ALL SELECT 'sales_orders.unit_cost_at_sale', count(*) FROM public.sales_orders            WHERE unit_cost_at_sale > 0 AND unit_cost_at_sale < 0.50
    UNION ALL SELECT 'asin_cost_overrides.unit_cost',  count(*) FROM public.asin_cost_overrides     WHERE unit_cost         > 0 AND unit_cost         < 0.50
    UNION ALL SELECT 'cost_history.cost',              count(*) FROM public.cost_history            WHERE cost              > 0 AND cost              < 0.50
    UNION ALL SELECT 'created_listing_purchases.unit_cost', count(*) FROM public.created_listing_purchases WHERE unit_cost > 0 AND unit_cost < 0.50
    UNION ALL SELECT 'created_listings.amount (UNIT)', count(*) FROM public.created_listings        WHERE amount            > 0 AND amount            < 0.50
    UNION ALL SELECT 'inventory.cost (UNIT)',          count(*) FROM public.inventory               WHERE cost              > 0 AND cost              < 0.50
    ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '%-38s : %', r.src, r.hits;
  END LOOP;

  -- The one that actually reaches the P&L. Anything here is money already
  -- mis-stated, not just a suspicious row sitting in a lookup table.
  RAISE NOTICE '';
  RAISE NOTICE '################ BOOKED: orders whose RESOLVED unit cost < $0.50 ################';
  n := 0;
  FOR r IN
    SELECT s.asin,
           COALESCE(s.seller_sku, s.sku)        AS sku,
           res.unit_cost, res.source,
           count(*)                             AS orders,
           sum(COALESCE(s.quantity,1))          AS units,
           round(min(NULLIF(s.item_price,0)),2) AS min_price,
           round(max(s.item_price),2)           AS max_price,
           min(s.order_date)                    AS first_order,
           max(s.order_date)                    AS last_order
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale,0) > 0 THEN s.unit_cost_at_sale
           WHEN s.cost_locked = true AND COALESCE(s.unit_cost,0)         > 0 THEN s.unit_cost
           ELSE NULL END
    ) res
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND res.unit_cost > 0 AND res.unit_cost < 0.50
    GROUP BY s.asin, COALESCE(s.seller_sku, s.sku), res.unit_cost, res.source
    ORDER BY sum(COALESCE(s.quantity,1)) DESC
    LIMIT 30
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% UNIT $% [%] | % orders / % units | sells $%..$% | % .. %',
      r.asin, r.sku, r.unit_cost, r.source, r.orders, r.units,
      r.min_price, r.max_price, r.first_order, r.last_order;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none -- no order in the book resolves under $0.50)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '################ created_listings.amount < $0.50, with sale price ################';
  n := 0;
  FOR r IN
    SELECT cl.asin, cl.sku, cl.units, cl.amount, cl.cost, cl.price,
           sp.min_price, sp.max_price, sp.orders,
           left(COALESCE(cl.title,''), 32) AS title
    FROM public.created_listings cl
    LEFT JOIN LATERAL (
      SELECT round(min(NULLIF(s.item_price,0)),2) AS min_price,
             round(max(s.item_price),2)           AS max_price,
             count(*)                             AS orders
      FROM public.sales_orders s
      WHERE s.user_id = cl.user_id AND s.asin = cl.asin
    ) sp ON true
    WHERE cl.amount > 0 AND cl.amount < 0.50
    ORDER BY COALESCE(sp.max_price,0) DESC
    LIMIT 25
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% units=% amount(UNIT)=$% cost(TOTAL)=$% | sells $%..$% (% orders) | %',
      r.asin, r.sku, r.units, r.amount, r.cost, r.min_price, r.max_price, r.orders, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '################ inventory.cost < $0.50, with sale price ################';
  n := 0;
  FOR r IN
    SELECT i.asin, i.sku, i.units, i.cost, i.amount, i.unit_cost_manual, i.price,
           sp.min_price, sp.max_price, sp.orders,
           left(COALESCE(i.title,''), 32) AS title
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT round(min(NULLIF(s.item_price,0)),2) AS min_price,
             round(max(s.item_price),2)           AS max_price,
             count(*)                             AS orders
      FROM public.sales_orders s
      WHERE s.user_id = i.user_id AND s.asin = i.asin
    ) sp ON true
    WHERE i.cost > 0 AND i.cost < 0.50
    ORDER BY COALESCE(sp.max_price,0) DESC
    LIMIT 25
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% stock=% cost(UNIT)=$% amount(TOTAL)=$% manual=% | sells $%..$% (% orders) | %',
      r.asin, r.sku, r.units, r.cost, r.amount, r.unit_cost_manual,
      r.min_price, r.max_price, r.orders, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  -- The same Contract A inversion, looked for in the OTHER direction: an
  -- inventory row where the TOTAL was written into the UNIT field, or vice
  -- versa. inventory.cost = UNIT, .amount = TOTAL -- the inverse of listings.
  RAISE NOTICE '';
  RAISE NOTICE '################ inventory rows inconsistent under Contract A ################';
  n := 0;
  FOR r IN
    SELECT i.asin, i.sku, i.units, i.cost, i.amount,
           round(i.amount / NULLIF(i.units,0), 4) AS unit_if_amount_is_total,
           round(i.cost * i.units, 2)             AS total_if_cost_is_unit,
           left(COALESCE(i.title,''), 32) AS title
    FROM public.inventory i
    WHERE COALESCE(i.units,0) > 1 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
    ORDER BY abs(i.amount - i.cost * i.units) DESC
    LIMIT 25
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% stock=% cost(UNIT)=$% amount(TOTAL)=$% | cost*units=$% or amount/units=$% | %',
      r.asin, r.sku, r.units, r.cost, r.amount,
      r.total_if_cost_is_unit, r.unit_if_amount_is_total, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  -- The other failure class, counted for context: no cost at all.
  RAISE NOTICE '';
  RAISE NOTICE '################ context: missing rather than tiny ################';
  FOR r IN
    SELECT count(*) FILTER (WHERE COALESCE(s.unit_cost,0) = 0)  AS zero_cost_orders,
           count(*) FILTER (WHERE s.cost_invalid = true)        AS flagged_invalid,
           count(*)                                             AS total_orders
    FROM public.sales_orders s
    WHERE COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
  LOOP
    RAISE NOTICE '% live orders | % with unit_cost 0 | % flagged cost_invalid',
      r.total_orders, r.zero_cost_orders, r.flagged_invalid;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '################ END SWEEP ################';
END
$probe$;
