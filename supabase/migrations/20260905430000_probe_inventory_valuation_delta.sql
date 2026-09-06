-- PROBE (read-only): if inventory.amount is recomputed as cost * units on the
-- 85 rows, what actually changes?
--
-- Established by 20260905420000: `cost` is right on all 85 -- it sits below the
-- sale price on 85 of 85, while amount/units would be under 5% of the sale
-- price on 29 of them. And amount/cost lands on clean whole numbers (69, 50,
-- 12, 11, 5, 4, 1 ...), which is the signature of a TOTAL that was correct at
-- an earlier stock level and never recomputed as units moved.
--
-- So this is a stale TOTAL, not a wrong unit cost. The P&L reads
-- resolve_unit_cost_v1, which takes inventory.cost -- so no booked COGS and no
-- month's P&L changes. What changes is inventory VALUATION, plus the removal
-- of a forward hazard: getInventoryUnitCostSafe prefers the smaller derived
-- value on disagreement, so sync-sales-orders can write amount/units as a new
-- order's unit cost.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== inventory valuation: now vs recomputed ========';
  FOR r IN
    SELECT count(*) AS rows,
           sum(i.units) AS units,
           round(sum(i.amount), 2)          AS valuation_now,
           round(sum(i.cost * i.units), 2)  AS valuation_after,
           round(sum(i.cost * i.units) - sum(i.amount), 2) AS delta
    FROM public.inventory i
    WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
      AND i.amount / NULLIF(i.units,0) < i.cost
  LOOP
    RAISE NOTICE '% rows / % units | recorded now $% -> recomputed $% | +$%',
      r.rows, r.units, r.valuation_now, r.valuation_after, r.delta;
  END LOOP;

  -- The forward hazard, sized: what WOULD be written per unit if a new order
  -- resolved off these rows through the Safe helper.
  RAISE NOTICE '';
  RAISE NOTICE '======== forward hazard: biggest stock x wrongest unit ========';
  FOR r IN
    SELECT i.asin, i.sku, i.units AS stock, i.cost AS correct_unit,
           round(i.amount / NULLIF(i.units,0), 4) AS safe_would_write,
           round((i.cost - i.amount / NULLIF(i.units,0)) * i.units, 2) AS understated_if_all_sold,
           left(COALESCE(i.title,''), 30) AS title
    FROM public.inventory i
    WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
      AND i.amount / NULLIF(i.units,0) < i.cost
    ORDER BY (i.cost - i.amount / NULLIF(i.units,0)) * i.units DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '% stock=% correct $% vs Safe $% | $% understated if the stock sells | %',
      r.asin, r.stock, r.correct_unit, r.safe_would_write, r.understated_if_all_sold, r.title;
  END LOOP;

  FOR r IN
    SELECT round(sum((i.cost - i.amount / NULLIF(i.units,0)) * i.units), 2) AS total_at_risk
    FROM public.inventory i
    WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
      AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
      AND i.amount / NULLIF(i.units,0) < i.cost
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'TOTAL COGS at risk if all this stock sold before the fix: $%', r.total_at_risk;
  END LOOP;
END
$probe$;
