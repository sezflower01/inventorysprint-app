-- PROBE (read-only): what the finished collapsed-orders sweep changed, in money.
--
-- 143 rows were repaired against Amazon GetOrderItems. Most were quantity
-- corrections (class B), where the row had kept one order line's quantity while
-- revenue and fees already covered the whole order. COGS follows quantity, so
-- the correction added unit_cost x (true quantity - 1) per row.
--
-- A handful may have been revenue-only (class A, USD orders); those change
-- revenue, not COGS, and are counted separately.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== repaired rows ========';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE s.quantity > 1) AS qty_fixed,
           count(*) FILTER (WHERE s.quantity = 1) AS qty_one,
           sum(s.quantity) AS units,
           sum(s.quantity) - count(*) AS units_recovered,
           round(sum(COALESCE(s.total_cost,0))::numeric, 2) AS cogs_now,
           round(sum(COALESCE(s.unit_cost,0) * GREATEST(s.quantity - 1, 0))::numeric, 2) AS cogs_added,
           count(*) FILTER (WHERE COALESCE(s.unit_cost,0) = 0) AS no_unit_cost
    FROM public.collapsed_order_checks c
    JOIN public.sales_orders s ON s.id = c.sales_order_id
    WHERE c.outcome = 'repaired'
  LOOP
    RAISE NOTICE '   % rows: % quantity corrections, % still qty 1 (revenue-only)', r.n, r.qty_fixed, r.qty_one;
    RAISE NOTICE '   % units now, % units recovered', r.units, r.units_recovered;
    RAISE NOTICE '   COGS now % | COGS the repair ADDED % (profit reported lower by this)', r.cogs_now, r.cogs_added;
    RAISE NOTICE '   rows with no unit cost (added nothing): %', r.no_unit_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== COGS added, by order month ========';
  FOR r IN
    SELECT to_char(s.order_date, 'YYYY-MM') AS mon, count(*) AS n,
           round(sum(COALESCE(s.unit_cost,0) * GREATEST(s.quantity - 1, 0))::numeric, 2) AS added
    FROM public.collapsed_order_checks c
    JOIN public.sales_orders s ON s.id = c.sales_order_id
    WHERE c.outcome = 'repaired'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % rows, +% COGS', r.mon, r.n, r.added;
  END LOOP;
END
$probe$;