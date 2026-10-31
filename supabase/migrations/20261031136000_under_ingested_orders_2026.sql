-- THE REAL MECHANISM, SIZED FOR THE WHOLE YEAR -- READ ONLY. 2026 ONLY.
--
-- 20261031135000 resolved the two sampled mismatches, and they are not the same
-- defect:
--
--   112-5072820-4704241 -- sales_orders: 1 line, qty 2, sold_price 15.00.
--     Amazon's money: THREE shipment events, 2026-05-21 $45, 05-22 $75,
--     06-03 $45 = $165.00, which is exactly 11 units at $15. getOrder also
--     says 11 shipped. So the order was shipped in three tranches and only
--     one was ingested: revenue understated $150.00, referral fees $24.75 vs
--     $4.52 stored, FBA fees $38.94 vs $5.54. A GENUINE defect.
--
--   701-3673086-3533855 -- sales_orders: qty 2 at 51.73. Amazon's money:
--     one shipment of exactly $103.46 = 2 x 51.73. The MONEY AGREES. getOrder
--     says 4 items shipped, and the order carries two zero-value refund
--     events, so the extra 2 are almost certainly a free replacement -- units
--     of inventory consumed with no revenue. Real, but NOT a quantity error,
--     and not something getOrder can distinguish.
--
-- That makes the one-order extrapolation in 20261031134000 unsound: 9 of the 11
-- disputed units came from a single order and 2 from a replacement. Scaling a
-- fat tail from one observation is not a measurement.
--
-- But the mechanism it exposed -- a multi-shipment order where only one
-- shipment was ingested -- can be sized across the whole year with no Amazon
-- call at all, because Amazon's own money rows are already in the cache. That
-- is what this does.
--
-- sold_price is confirmed a UNIT price by both worked examples (2 x 51.73 =
-- 103.46; 11 x 15.00 = 165.00), so the comparable figure is quantity x
-- sold_price.
--
-- FX trap avoided: estimated_price is native and sold_price is USD, so a
-- non-US order can show a fake gap equal to the exchange rate. US/UNKNOWN/NULL
-- marketplaces are reported as the headline and non-US separately.
DO $p$
DECLARE
  r record; v_uid uuid; v_avg_cost numeric;
  v_orders int; v_gap numeric; v_units numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);
  SELECT CASE WHEN sum(units_with_cost) > 0
              THEN round(sum(cogs)/sum(units_with_cost),4) ELSE NULL END
    INTO v_avg_cost FROM public.get_monthly_cogs(2026, NULL);

  CREATE TEMP TABLE ord ON COMMIT DROP AS
  WITH so AS (
    SELECT order_id,
           sum(COALESCE(quantity,0))                            AS units,
           round(sum(COALESCE(quantity,0) * COALESCE(sold_price,0))::numeric,2) AS money,
           max(COALESCE(sold_price,0))::numeric                  AS unit_price,
           count(*)                                             AS lines,
           min(order_date)                                       AS order_date,
           max(COALESCE(marketplace,'US'))                        AS mp
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY order_id
  ),
  fec AS (
    SELECT amazon_order_id AS order_id,
           count(*)                            AS ship_events,
           round(sum(abs(COALESCE(sales,0))),2) AS money
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND event_type = 'shipment' AND amazon_order_id IS NOT NULL
    GROUP BY amazon_order_id
  )
  SELECT so.order_id, so.order_date, so.mp, so.lines, so.units, so.money AS so_money,
         so.unit_price, f.ship_events, f.money AS fec_money,
         round(f.money - so.money, 2) AS gap
  FROM so JOIN fec f ON f.order_id = so.order_id;

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. MULTI-SHIPMENT ORDERS IN 2026 ############';
  RAISE NOTICE '   Amazon shipment events per order, and whether we agree on money';
  RAISE NOTICE '   events | orders |  our revenue | Amazon revenue |        gap';
  FOR r IN
    SELECT CASE WHEN ship_events >= 4 THEN '4+' ELSE ship_events::text END AS ev,
           count(*) AS orders,
           round(sum(so_money),2) AS ours,
           round(sum(fec_money),2) AS amz,
           round(sum(gap),2) AS gap
    FROM ord GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | % | %', lpad(r.ev,6), lpad(r.orders::text,6),
      lpad(r.ours::text,12), lpad(r.amz::text,14), lpad(r.gap::text,10);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. ORDERS WHERE AMAZON BILLED MORE THAN WE STORED ############';
  RAISE NOTICE '   US / UNKNOWN / NULL marketplaces only (no FX ambiguity)';
  SELECT count(*), round(sum(gap),2),
         round(sum(CASE WHEN unit_price > 0 THEN gap / unit_price ELSE 0 END),1)
    INTO v_orders, v_gap, v_units
  FROM ord
  WHERE gap > 1.00
    AND upper(COALESCE(mp,'US')) IN ('US','UNKNOWN');
  RAISE NOTICE '   orders affected          : %', COALESCE(v_orders,0);
  RAISE NOTICE '   revenue NOT in sales_orders: %', COALESCE(v_gap,0);
  RAISE NOTICE '   implied missing units     : % (gap / our unit price)',
    COALESCE(v_units,0);
  RAISE NOTICE '   COGS not booked on them   : % (at % per unit)',
    round(COALESCE(v_units,0) * COALESCE(v_avg_cost,0),2), COALESCE(v_avg_cost,0);
  RAISE NOTICE '   NET effect if all were ingested: % (revenue minus that COGS)',
    round(COALESCE(v_gap,0) - COALESCE(v_units,0) * COALESCE(v_avg_cost,0),2);

  RAISE NOTICE '';
  RAISE NOTICE '   by month:';
  RAISE NOTICE '   month | orders |        gap | shipment events';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mo, count(*) AS n,
           round(sum(gap),2) AS gap,
           sum(ship_events) AS ev
    FROM ord
    WHERE gap > 1.00 AND upper(COALESCE(mp,'US')) IN ('US','UNKNOWN')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | %', r.mo, lpad(r.n::text,6),
      lpad(r.gap::text,10), lpad(r.ev::text,15);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   the 15 largest, with the shipment-event count that explains them:';
  FOR r IN
    SELECT order_id, order_date, lines, units, so_money, fec_money, gap,
           ship_events, unit_price,
           CASE WHEN unit_price > 0 THEN round(fec_money / unit_price,1) ELSE NULL END
             AS implied_units
    FROM ord
    WHERE gap > 1.00 AND upper(COALESCE(mp,'US')) IN ('US','UNKNOWN')
    ORDER BY gap DESC LIMIT 15
  LOOP
    RAISE NOTICE '      % | % | % lines | qty % | ours % | amz % | gap % | % ship events | implies % units',
      r.order_id, r.order_date, r.lines, lpad(r.units::text,3),
      lpad(r.so_money::text,8), lpad(r.fec_money::text,8),
      lpad(r.gap::text,8), r.ship_events, COALESCE(r.implied_units::text,'?');
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. THE REVERSE: WE STORED MORE THAN AMAZON BILLED ############';
  SELECT count(*), round(sum(-gap),2) INTO v_orders, v_gap
  FROM ord WHERE gap < -1.00 AND upper(COALESCE(mp,'US')) IN ('US','UNKNOWN');
  RAISE NOTICE '   orders % | revenue we show that Amazon did not bill %',
    COALESCE(v_orders,0), COALESCE(v_gap,0);
  RAISE NOTICE '   (expected for part-settled orders -- Amazon pays in tranches,';
  RAISE NOTICE '    so a recent order legitimately shows less money than units)';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mo, count(*) AS n,
           round(sum(-gap),2) AS gap
    FROM ord WHERE gap < -1.00 AND upper(COALESCE(mp,'US')) IN ('US','UNKNOWN')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % orders | %', r.mo, lpad(r.n::text,5),
    lpad(r.gap::text,10); END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. NON-US, REPORTED SEPARATELY (FX NOT RESOLVED) ############';
  FOR r IN
    SELECT upper(COALESCE(mp,'US')) AS mp, count(*) AS n,
           round(sum(so_money),2) AS ours, round(sum(fec_money),2) AS amz,
           round(sum(gap),2) AS gap,
           round(CASE WHEN sum(so_money) > 0
                 THEN sum(fec_money)/sum(so_money) ELSE NULL END,4) AS ratio
    FROM ord
    WHERE upper(COALESCE(mp,'US')) NOT IN ('US','UNKNOWN')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | ours % | amz % | gap % | ratio %',
      rpad(r.mp,6), lpad(r.n::text,5), lpad(r.ours::text,10),
      lpad(r.amz::text,10), lpad(r.gap::text,10), r.ratio;
  END LOOP;
  RAISE NOTICE '   a ratio sitting at an exchange rate means a UNIT mismatch, not';
  RAISE NOTICE '   a missing shipment -- do not read those gaps as lost revenue.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, no API called.';
END
$p$;
