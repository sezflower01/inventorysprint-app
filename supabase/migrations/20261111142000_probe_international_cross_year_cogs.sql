-- Exact COGS carried by the 49 cross-year non-US orders. READ ONLY.
--
-- Probe 2 found $1,526.26 of 2026 non-US revenue belongs to orders PLACED in
-- 2025, and zero 2026 orders settling later. Revenue is booked on
-- financial_events_cache.event_date; COGS on sales_orders.order_date. So that
-- revenue sits in 2026 with its cost in 2025, and 2026 international profit is
-- overstated by exactly those orders' COGS. Estimating it from the 39.2%
-- portfolio ratio is not good enough for a figure going to an accountant, so
-- resolve the real unit cost the same way get_monthly_cogs does -- via
-- resolve_unit_cost_v1.
--
-- Also check the prior year for the same effect, to establish whether this is a
-- rolling wash (every year receives a tail and sends one) or a one-off.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  RAISE NOTICE '=== COGS of non-US orders whose revenue lands in a LATER year ===';
  FOR r IN
    WITH x AS (
      SELECT DISTINCT
             UPPER(f.marketplace) AS mp,
             EXTRACT(YEAR FROM f.event_date::date)::int AS ev_y,
             EXTRACT(YEAR FROM s.order_date)::int       AS ord_y,
             s.order_id, s.asin, COALESCE(s.seller_sku, s.sku) AS sku,
             s.order_date, s.unit_cost, COALESCE(s.quantity,1) AS qty,
             ABS(COALESCE(f.sales,0)) AS rev
      FROM public.financial_events_cache f
      JOIN public.sales_orders s ON s.user_id = f.user_id AND s.order_id = f.amazon_order_id
      WHERE f.user_id = v_uid AND f.event_type = 'shipment'
        AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
        AND EXTRACT(YEAR FROM f.event_date::date) > EXTRACT(YEAR FROM s.order_date)
    )
    SELECT x.ev_y, x.mp, COUNT(*) AS orders,
           SUM(x.rev) AS revenue,
           SUM(c.unit_cost * x.qty) AS cogs_left_behind
    FROM x
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_uid, x.asin, x.sku, x.order_date, x.unit_cost) c
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE 'revenue year % % : % orders, revenue %, COGS stranded in prior year %',
      r.ev_y, r.mp, r.orders,
      to_char(r.revenue,'FM999999990.00'),
      to_char(COALESCE(r.cogs_left_behind,0),'FM999999990.00');
  END LOOP;
END $p$;
