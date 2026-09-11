-- PROBE (read-only): B0G4B3117X -- the last facts FIFO depends on, and a
-- dry-run preview of both costing methods so the seller chooses with numbers.
--
-- Nothing here writes. The repair itself waits for the seller's choice.
--
-- THE RISK TO FIFO. Records show 1,254 units bought and 1,276 sold. If units
-- are still ON HAND, the purchase records are incomplete -- more stock was
-- bought than was entered -- and FIFO would push the 7.75 stock onto sales that
-- actually consumed unrecorded expensive stock. On-hand inventory decides
-- whether FIFO is trustworthy at all.
--
-- ALSO CORRECTING MY OWN COUNT. The FIFO probe counted every non-cancelled
-- row with qty > 0. It did not exclude '-REFUND' rows or replacement orders.
-- get_cogs_for_range excludes '%-REFUND' and so should any unit count.
--
-- WHAT EVERY REPORT READS, established from source:
--   Sales Report  buildCogsResolver  -> locked unit_cost_at_sale, then unit_cost
--   Mobile        buildCogsResolver, and its card reads unit_cost_at_sale x qty
--   P&L range     get_cogs_for_range -> locked unit_cost_at_sale, then locked unit_cost
--   P&L monthly   get_monthly_cogs   -> unit_cost, UNCONDITIONALLY
--   P&L headline  get_pl_live_summary has no COGS logic of its own
-- So a repair must write unit_cost_at_sale AND unit_cost AND total_cost, or the
-- monthly P&L and the Sales Report will disagree with each other.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== on-hand stock -- does it contradict the purchase records? ========';
  FOR r IN
    SELECT sku, COALESCE(available,0) AS av, COALESCE(reserved,0) AS rv,
           COALESCE(inbound,0) AS ib, COALESCE(unfulfilled,0) AS uf,
           listing_status, source, cost, last_inventory_sync_at
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   sku=%  available=% reserved=% inbound=% unfulfilled=%',
      r.sku, r.av, r.rv, r.ib, r.uf;
    RAISE NOTICE '        status=% source=% unit_cost=% confirmed=%',
      r.listing_status, r.source, r.cost, r.last_inventory_sync_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== refunds, replacements and zero-qty rows my FIFO count included ========';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE order_id LIKE '%-REFUND') AS refund_rows,
      COALESCE(sum(quantity) FILTER (WHERE order_id LIKE '%-REFUND'),0) AS refund_units,
      count(*) FILTER (WHERE COALESCE(is_replacement,false)) AS replacement_rows,
      COALESCE(sum(quantity) FILTER (WHERE COALESCE(is_replacement,false)),0) AS replacement_units,
      count(*) FILTER (WHERE COALESCE(is_cancelled,false)) AS cancelled_flag_rows,
      COALESCE(sum(refund_quantity),0) AS refunded_qty_on_sales
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   -REFUND rows: % (% units)', r.refund_rows, r.refund_units;
    RAISE NOTICE '   replacement rows: % (% units)', r.replacement_rows, r.replacement_units;
    RAISE NOTICE '   is_cancelled flag set: % rows', r.cancelled_flag_rows;
    RAISE NOTICE '   refund_quantity recorded on sales: %', r.refunded_qty_on_sales;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== clean unit count: what get_cogs_for_range itself would count ========';
  FOR r IN
    SELECT count(*) AS orders, sum(COALESCE(quantity,1)) AS units,
           round(sum(total_cost)::numeric,2) AS total_cost_col,
           round(sum(COALESCE(quantity,1) * COALESCE(unit_cost,0))::numeric,2) AS via_unit_cost,
           round(sum(COALESCE(quantity,1) * COALESCE(unit_cost_at_sale,0))::numeric,2) AS via_at_sale
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
      AND (is_cancelled IS NULL OR is_cancelled = false)
  LOOP
    RAISE NOTICE '   % orders, % units', r.orders, r.units;
    RAISE NOTICE '   COGS three ways: total_cost=%  qty*unit_cost=%  qty*unit_cost_at_sale=%',
      r.total_cost_col, r.via_unit_cost, r.via_at_sale;
    RAISE NOTICE '   (if these three disagree, the reports already disagree today)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== DRY RUN: FIFO vs weighted average vs today, by month ========';
  -- Clean population only. FIFO: first 954 units at their real lot costs, next
  -- 300 at 7.75, anything past 1,254 has no purchase record and keeps today's
  -- cost. Weighted average: 13.0024 on every unit.
  FOR r IN
    WITH s AS (
      SELECT order_date, COALESCE(quantity,1) AS qty,
             COALESCE(unit_cost_at_sale, unit_cost, 0) AS cur_unit,
             sum(COALESCE(quantity,1)) OVER (
               ORDER BY order_date, purchase_timestamp_utc NULLS LAST, order_id
               ROWS UNBOUNDED PRECEDING) AS running
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
        AND (is_cancelled IS NULL OR is_cancelled = false)
        AND COALESCE(quantity,0) > 0
    ),
    split AS (
      SELECT order_date, qty, cur_unit,
             GREATEST(0, LEAST(running, 954)  - GREATEST(running - qty, 0))    AS exp_u,
             GREATEST(0, LEAST(running, 1254) - GREATEST(running - qty, 954))  AS cheap_u,
             GREATEST(0, running - GREATEST(running - qty, 1254))              AS unbacked_u
      FROM s
    )
    SELECT to_char(order_date,'YYYY-MM') AS mon,
           sum(qty) AS units,
           round(sum(qty * cur_unit)::numeric, 2) AS today,
           round(sum(exp_u * cur_unit + cheap_u * 7.75 + unbacked_u * cur_unit)::numeric, 2) AS fifo,
           round(sum(qty * 13.0024)::numeric, 2) AS wavg
    FROM split GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % units | today % | FIFO % (%) | avg % (%)',
      r.mon, r.units, r.today,
      r.fifo, round(r.fifo - r.today, 2),
      r.wavg, round(r.wavg - r.today, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals ========';
  FOR r IN
    WITH s AS (
      SELECT COALESCE(quantity,1) AS qty,
             COALESCE(unit_cost_at_sale, unit_cost, 0) AS cur_unit,
             sum(COALESCE(quantity,1)) OVER (
               ORDER BY order_date, purchase_timestamp_utc NULLS LAST, order_id
               ROWS UNBOUNDED PRECEDING) AS running
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
        AND (is_cancelled IS NULL OR is_cancelled = false)
        AND COALESCE(quantity,0) > 0
    ),
    split AS (
      SELECT qty, cur_unit,
             GREATEST(0, LEAST(running, 954)  - GREATEST(running - qty, 0))   AS exp_u,
             GREATEST(0, LEAST(running, 1254) - GREATEST(running - qty, 954)) AS cheap_u,
             GREATEST(0, running - GREATEST(running - qty, 1254))             AS unbacked_u
      FROM s
    )
    SELECT sum(qty) AS units,
           round(sum(qty * cur_unit)::numeric,2) AS today,
           round(sum(exp_u * cur_unit + cheap_u * 7.75 + unbacked_u * cur_unit)::numeric,2) AS fifo,
           round(sum(qty * 13.0024)::numeric,2) AS wavg,
           sum(cheap_u) AS cheap_units, sum(unbacked_u) AS unbacked_units,
           count(*) FILTER (WHERE cheap_u > 0) AS orders_touched_fifo
    FROM split
  LOOP
    RAISE NOTICE '   units %  |  COGS today %', r.units, r.today;
    RAISE NOTICE '   FIFO     %  -> change %  (% orders rewritten, % units at 7.75)',
      r.fifo, round(r.fifo - r.today,2), r.orders_touched_fifo, r.cheap_units;
    RAISE NOTICE '   average  %  -> change %  (every order rewritten)',
      r.wavg, round(r.wavg - r.today,2);
    RAISE NOTICE '   % units have no purchase record under either method', r.unbacked_units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the orders with no purchase record behind them ========';
  FOR r IN
    WITH s AS (
      SELECT order_id, order_date, COALESCE(quantity,1) AS qty, order_status,
             sum(COALESCE(quantity,1)) OVER (
               ORDER BY order_date, purchase_timestamp_utc NULLS LAST, order_id
               ROWS UNBOUNDED PRECEDING) AS running
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
        AND (is_cancelled IS NULL OR is_cancelled = false)
        AND COALESCE(quantity,0) > 0
    )
    SELECT order_id, order_date, qty, running, order_status
    FROM s WHERE running > 1254 ORDER BY running LIMIT 30
  LOOP
    RAISE NOTICE '   % % qty=% running=% %', r.order_date, r.order_id, r.qty, r.running, r.order_status;
  END LOOP;
END
$probe$;
