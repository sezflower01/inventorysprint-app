-- SAME-ASIN COLLAPSE: EXACT 2026 COGS EFFECT -- READ ONLY. 2026 ONLY.
--
-- ── CORRECTION TO 20261031136000 ──────────────────────────────────────
--
-- That migration called the defect "a multi-shipment order where only one
-- shipment was ingested". The correlation with shipment-event count is real but
-- the mechanism is not. The actual bug is already documented in
-- supabase/functions/repair-collapsed-orders/index.ts and was diagnosed
-- 2026-09-09:
--
--   sales_orders is unique on (user_id, order_id, asin) with NO order-item
--   column. An Amazon order can carry two OrderItems for the SAME ASIN. The
--   writers loop items and upsert per item, so both land on one row and the
--   LAST ONE WINS -- replacing quantity instead of adding to it.
--
-- Amazon splits shipments per order item, which is why the symptom tracks
-- shipment-event count. So the correlation was a consequence, not the cause.
--
-- ── WHY IT IS STILL HAPPENING ─────────────────────────────────────────
--
-- The fix is _shared/order-items.ts mergeOrderItemsByAsin, landed in d51b6d5
-- (2026-09-09, "Sum repeated ASIN lines on one order instead of overwriting").
-- It is imported by sync-sales-orders and repair-collapsed-orders -- and NOT by
-- fetch-live-orders, which still has both unfixed paths:
--
--   index.ts:2350  "// Insert each item"  for (const item of items) { ...
--                  quantity = parseInt(item.QuantityOrdered) ... upsert }
--                  -> two items on one ASIN collapse, last write wins
--   index.ts:3101  const item = items[0];
--                  -> the enrichment path reads ONLY the first item, even
--                     though it computed isMultiItemOrder one line earlier
--
-- The monthly shape confirms the bug is live rather than historical: affected
-- orders run 11-20 per month from January to June and then 58 / 58 / 63 in
-- August, September and October -- i.e. it got WORSE after the September fix,
-- which is what a second unfixed writer looks like.
--
-- ── WHAT THIS MIGRATION MEASURES, AND WHAT IT CANNOT ──────────────────
--
-- COGS is SUM(resolve_unit_cost_v1(...) * quantity) over sales_orders, so the
-- exact effect needs the real per-ASIN resolved cost, not a year average. That
-- is what is used here, with get_monthly_cogs's own filters reproduced
-- (excludes '%-REFUND', Canceled/Cancelled, is_cancelled).
--
-- The implied quantity, though, is INFERRED: financial_events_cache.quantity is
-- 0 on these rows, so the only DB route is Amazon's money divided by our unit
-- price. Where that lands on a whole number it is strong evidence; where it does
-- not, the unit price differed across tranches and the row is NOT counted in
-- the headline. repair-collapsed-orders exists precisely because this estimate
-- is not good enough to rewrite records on -- it checks every candidate against
-- GetOrderItems. This sizes the problem; it does not authorise a backfill.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_orders int := 0; v_units numeric := 0; v_cogs numeric := 0;
  v_fuzzy_orders int := 0; v_fuzzy_cogs numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  -- candidates: one row per order, with the exact resolved unit cost
  ------------------------------------------------------------------
  CREATE TEMP TABLE cand ON COMMIT DROP AS
  WITH so AS (
    SELECT s.order_id, s.asin, s.sku, s.order_date, s.quantity AS stored_qty,
           s.sold_price, s.unit_cost AS snapshot_cost,
           EXTRACT(MONTH FROM s.order_date)::int AS m
    FROM public.sales_orders s
    WHERE s.user_id = v_uid
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND upper(COALESCE(s.marketplace,'US')) IN ('US','UNKNOWN')
      AND COALESCE(s.sold_price,0) > 0
  ),
  one_line AS (
    SELECT order_id FROM so GROUP BY order_id HAVING count(*) = 1
  ),
  fec AS (
    SELECT amazon_order_id AS order_id, count(*) AS ship_events,
           round(sum(abs(COALESCE(sales,0))),2) AS amz_money
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND event_type = 'shipment' AND amazon_order_id IS NOT NULL
    GROUP BY amazon_order_id
  )
  SELECT so.m, so.order_id, so.asin, so.order_date, so.stored_qty,
         so.sold_price, f.ship_events, f.amz_money,
         (f.amz_money / so.sold_price)                       AS implied_raw,
         round(f.amz_money / so.sold_price)                  AS implied_qty,
         abs(f.amz_money / so.sold_price
             - round(f.amz_money / so.sold_price))           AS whole_err,
         rc.unit_cost                                        AS resolved_cost
  FROM so
  JOIN one_line ol ON ol.order_id = so.order_id
  JOIN fec f       ON f.order_id  = so.order_id
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_uid, so.asin, so.sku, so.order_date, so.snapshot_cost) rc
  WHERE f.amz_money / so.sold_price > so.stored_qty + 0.5;

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. HOW CONFIDENT IS THE IMPLIED QUANTITY? ############';
  RAISE NOTICE '   Amazon money / our unit price, distance from a whole number';
  RAISE NOTICE '   bucket                 | orders | missing units | COGS effect';
  FOR r IN
    SELECT CASE WHEN whole_err <= 0.02 THEN 'on a whole number  (<=0.02)'
                WHEN whole_err <= 0.10 THEN 'near one           (<=0.10)'
                WHEN whole_err <= 0.25 THEN 'loose              (<=0.25)'
                ELSE 'not a whole number (>0.25)' END AS bucket,
           count(*) AS n,
           sum(implied_qty - stored_qty) AS units,
           round(sum((implied_qty - stored_qty) * COALESCE(resolved_cost,0)),2) AS cogs
    FROM cand GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | %', rpad(r.bucket,22), lpad(r.n::text,6),
      lpad(r.units::text,13), lpad(r.cogs::text,11);
  END LOOP;

  SELECT count(*), sum(implied_qty - stored_qty),
         round(sum((implied_qty - stored_qty) * COALESCE(resolved_cost,0)),2)
    INTO v_orders, v_units, v_cogs
  FROM cand WHERE whole_err <= 0.02;
  SELECT count(*), round(sum((implied_qty - stored_qty) * COALESCE(resolved_cost,0)),2)
    INTO v_fuzzy_orders, v_fuzzy_cogs
  FROM cand WHERE whole_err > 0.02;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. THE ONE NUMBER ############';
  RAISE NOTICE '   Confident rows only (implied qty lands on a whole number):';
  RAISE NOTICE '      orders affected         : %', COALESCE(v_orders,0);
  RAISE NOTICE '      units missing           : %', COALESCE(v_units,0);
  RAISE NOTICE '      COGS UNDERSTATEMENT     : % <= the one number',
    COALESCE(v_cogs,0);
  RAISE NOTICE '      net profit OVERSTATED by the same amount';
  RAISE NOTICE '   Unconfident rows set aside : % orders, a further % if real',
    COALESCE(v_fuzzy_orders,0), COALESCE(v_fuzzy_cogs,0);
  RAISE NOTICE '   NOTE: the year-average estimate in 20261031136000 was';
  RAISE NOTICE '   2,500-6,250. This replaces it with resolved per-ASIN costs.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. PREDICTED get_monthly_cogs, BEFORE AND AFTER ############';
  RAISE NOTICE '   month |    COGS now | units now | + units | COGS after | pct';
  FOR r IN
    SELECT c.month_num AS m, round(c.cogs,2) AS cogs_now, c.units_sold AS u_now,
           COALESCE(x.units,0) AS add_u, round(COALESCE(x.cogs,0),2) AS add_c
    FROM public.get_monthly_cogs(2026, NULL) c
    LEFT JOIN (
      SELECT m, sum(implied_qty - stored_qty) AS units,
             sum((implied_qty - stored_qty) * COALESCE(resolved_cost,0)) AS cogs
      FROM cand WHERE whole_err <= 0.02 GROUP BY m
    ) x ON x.m = c.month_num
    ORDER BY c.month_num
  LOOP
    IF r.cogs_now <> 0 OR r.add_u <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | % | % pct',
        lpad(r.m::text,5), lpad(r.cogs_now::text,11), lpad(r.u_now::text,9),
        lpad(r.add_u::text,7), lpad(round(r.cogs_now + r.add_c,2)::text,10),
        lpad(CASE WHEN r.cogs_now > 0
             THEN round(100.0 * r.add_c / r.cogs_now, 2)::text ELSE '-' END,5);
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. EVERY CONFIDENT ORDER ############';
  RAISE NOTICE '   order               | date       | asin         | stored | implied | +units | unit cost | COGS effect | ship ev';
  FOR r IN
    SELECT * FROM cand WHERE whole_err <= 0.02
    ORDER BY (implied_qty - stored_qty) * COALESCE(resolved_cost,0) DESC
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | % | % | %',
      r.order_id, r.order_date, rpad(r.asin,12),
      lpad(r.stored_qty::text,6), lpad(r.implied_qty::text,7),
      lpad((r.implied_qty - r.stored_qty)::text,6),
      lpad(round(COALESCE(r.resolved_cost,0),2)::text,9),
      lpad(round((r.implied_qty - r.stored_qty) * COALESCE(r.resolved_cost,0),2)::text,11),
      r.ship_events;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 5. ROWS WITH NO RESOLVED COST ############';
  FOR r IN
    SELECT count(*) AS n, sum(implied_qty - stored_qty) AS units
    FROM cand WHERE whole_err <= 0.02 AND COALESCE(resolved_cost,0) = 0
  LOOP
    RAISE NOTICE '   % orders / % units have no resolved unit cost, so they add',
      r.n, COALESCE(r.units,0);
    RAISE NOTICE '   units but 0.00 of COGS -- they would move units_missing_cost,';
    RAISE NOTICE '   not the COGS figure. Counted in units, not in dollars.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, no API called.';
END
$p$;
