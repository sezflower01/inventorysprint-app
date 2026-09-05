-- PROBE (read-only): the previous probe listed the newest 40 orders for
-- B0GXCDB8XM and every one resolved to $9.97. Forty rows is not "all rows",
-- and a single stale locked snapshot outside that window would be invisible
-- while still distorting the P&L -- exactly how the $2,157.92 foam sword hid.
--
-- So: aggregate EVERY row for the ASIN by resolved unit cost and source. One
-- output line per distinct value. More than one line means an outlier exists.

DO $probe$
DECLARE
  v_asin text := 'B0GXCDB8XM';
  r record;
BEGIN
  RAISE NOTICE '===== ALL rows for %, grouped by resolved cost =====', v_asin;
  FOR r IN
    SELECT res.unit_cost, res.source,
           count(*)                        AS orders,
           sum(COALESCE(s.quantity, 1))    AS units,
           min(s.order_date)               AS first_order,
           max(s.order_date)               AS last_order,
           round(sum(res.unit_cost * COALESCE(s.quantity, 1)), 2) AS cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date::date,
      CASE
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale, 0) > 0 THEN s.unit_cost_at_sale
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost, 0) > 0 THEN s.unit_cost
        ELSE NULL
      END
    ) res
    WHERE s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
    GROUP BY res.unit_cost, res.source
    ORDER BY orders DESC
  LOOP
    RAISE NOTICE 'UNIT $% from [%] : % orders, % units, % .. %, COGS $%',
      r.unit_cost, r.source, r.orders, r.units, r.first_order, r.last_order, r.cogs;
  END LOOP;

  -- Revenue side, only because a cost is meaningless without it: this ASIN
  -- showed price=0 on some rows in the previous probe, which is the known
  -- "$0 revenue" class, not a cost problem.
  RAISE NOTICE '';
  RAISE NOTICE '---- revenue sanity ----';
  FOR r IN
    SELECT count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(s.item_price, 0) = 0) AS zero_price,
           count(*) FILTER (WHERE s.order_status = 'Pending')    AS pending,
           round(min(NULLIF(s.item_price, 0)), 2) AS min_price,
           round(max(s.item_price), 2)            AS max_price
    FROM public.sales_orders s
    WHERE s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
  LOOP
    RAISE NOTICE '% orders | % with price 0 | % still Pending | price range $% .. $%',
      r.orders, r.zero_price, r.pending, r.min_price, r.max_price;
  END LOOP;
END
$probe$;
