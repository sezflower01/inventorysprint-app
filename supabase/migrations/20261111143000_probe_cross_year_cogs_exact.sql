-- Same question, counted once per ORDER. READ ONLY.
--
-- 20261111142000 deduplicated with DISTINCT over a row that still carried the
-- event's own revenue, so an order with two shipment events collapsed to two
-- rows when the amounts differed and one when they matched -- BR came back as
-- 2 orders / $94.32 against the 3 events / $150.53 the previous probe counted.
-- Good enough to size the problem, not good enough for an accountant. Resolve
-- the order set FIRST, then cost each order exactly once.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  RAISE NOTICE '=== Non-US orders whose revenue year > order year, one row per order ===';
  FOR r IN
    WITH ords AS (
      SELECT f.amazon_order_id AS oid,
             UPPER(MIN(f.marketplace)) AS mp,
             MAX(EXTRACT(YEAR FROM f.event_date::date))::int AS ev_y,
             SUM(ABS(COALESCE(f.sales,0))) AS rev
      FROM public.financial_events_cache f
      JOIN public.sales_orders s ON s.user_id = f.user_id AND s.order_id = f.amazon_order_id
      WHERE f.user_id = v_uid AND f.event_type = 'shipment'
        AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
        AND EXTRACT(YEAR FROM f.event_date::date) > EXTRACT(YEAR FROM s.order_date)
      GROUP BY 1
    ),
    costed AS (
      SELECT o.oid, o.mp, o.ev_y, o.rev,
             SUM(c.unit_cost * COALESCE(s.quantity,1)) AS cogs
      FROM ords o
      JOIN public.sales_orders s ON s.user_id = v_uid AND s.order_id = o.oid
      CROSS JOIN LATERAL public.resolve_unit_cost_v1(
        v_uid, s.asin, COALESCE(s.seller_sku, s.sku), s.order_date, s.unit_cost) c
      GROUP BY 1,2,3,4
    )
    SELECT ev_y, mp, COUNT(*) AS orders, SUM(rev) AS revenue, SUM(cogs) AS cogs
    FROM costed GROUP BY 1,2
    UNION ALL
    SELECT ev_y, 'ALL' AS mp, COUNT(*), SUM(rev), SUM(cogs)
    FROM costed GROUP BY 1
    ORDER BY 1, 2
  LOOP
    RAISE NOTICE 'revenue year % % : % orders, revenue %, COGS stranded in the prior year %',
      r.ev_y, rpad(r.mp,3), r.orders,
      to_char(r.revenue,'FM999999990.00'),
      to_char(COALESCE(r.cogs,0),'FM999999990.00');
  END LOOP;
END $p$;
