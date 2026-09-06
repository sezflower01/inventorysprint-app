-- PROBE (read-only): how many created_listings rows violate Contract A the way
-- B0G1ZFK88V does, and how many of those are still live?
--
-- B0G1ZFK88V / OKI-IRC-X2DN carries units=30, amount(UNIT)=19.55 and
-- cost(LOT TOTAL)=19.55. The lot total should be 30 x 19.55 = 586.50; instead
-- the UNIT value was written into the TOTAL field. Four independent sources
-- agree 19.55 is the unit (cost_history, inventory.cost, every locked snapshot,
-- and a $29.95-$36.08 sale price), so the defect is in .cost, not .amount.
--
-- WHY IT MATTERS BEYOND ONE ROW. getListingUnitCostSafe cross-checks the two
-- fields and, on disagreement, "prefers the smaller derived value":
--
--   expectedTotal = amount * units          = 586.50
--   |cost - expectedTotal| = 566.95 > tol   -> inconsistent
--   derivedUnit   = cost / units            = 0.65
--   derivedUnit < amount                    -> RETURNS 0.65
--
-- That guard was written to defend against the inventory{cost/amount} swap. On
-- THIS shape it inverts the answer, turning a $19.55 unit cost into $0.65 --
-- a 30x understatement. sync-sales-orders calls it in three places, so a new
-- order on an affected SKU can be written and LOCKED at the wrong cost.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '===== created_listings rows inconsistent under Contract A =====';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (
             WHERE COALESCE(units,0) > 0 AND COALESCE(amount,0) > 0 AND COALESCE(cost,0) > 0
               AND abs(cost - amount * units) > GREATEST(0.01, abs(amount * units) * 0.005)
           ) AS inconsistent,
           count(*) FILTER (
             WHERE COALESCE(units,0) > 1 AND COALESCE(amount,0) > 0 AND COALESCE(cost,0) > 0
               AND abs(cost - amount) < 0.005
           ) AS unit_written_into_total
    FROM public.created_listings
  LOOP
    RAISE NOTICE 'created_listings: % rows, % inconsistent, % of them look like UNIT-written-into-TOTAL',
      r.total, r.inconsistent, r.unit_written_into_total;
  END LOOP;

  -- The dangerous subset: inconsistent AND still holding stock, so a future
  -- sale can be priced off the bad row.
  RAISE NOTICE '';
  RAISE NOTICE '---- inconsistent AND still in stock (a sale here writes a wrong locked cost) ----';
  n := 0;
  FOR r IN
    SELECT cl.asin, cl.sku, cl.units, cl.cost, cl.amount, i.units AS stock,
           round(cl.cost / NULLIF(cl.units,0), 2) AS safe_would_return,
           cl.amount                              AS contract_says,
           left(COALESCE(cl.title,''), 34)        AS title
    FROM public.created_listings cl
    JOIN public.inventory i ON i.user_id = cl.user_id AND i.sku = cl.sku
    WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
      AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
      AND COALESCE(i.units,0) > 0
    ORDER BY i.units DESC
    LIMIT 25
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% lot_units=% cost=% amount=% stock=% | Safe would say $% vs contract $% | %',
      r.asin, r.sku, r.units, r.cost, r.amount, r.stock,
      r.safe_would_return, r.contract_says, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none in stock -- the defect is real but currently dormant)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '---- widest gaps overall, in stock or not ----';
  n := 0;
  FOR r IN
    SELECT cl.asin, cl.sku, cl.units, cl.cost, cl.amount,
           round(abs(cl.cost - cl.amount * cl.units), 2) AS gap,
           left(COALESCE(cl.title,''), 34) AS title
    FROM public.created_listings cl
    WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
      AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
    ORDER BY gap DESC
    LIMIT 15
  LOOP
    n := n + 1;
    RAISE NOTICE 'asin=% sku=% units=% cost=% amount=% gap=$% | %',
      r.asin, r.sku, r.units, r.cost, r.amount, r.gap, r.title;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '================ END PROBE ================';
END
$probe$;
