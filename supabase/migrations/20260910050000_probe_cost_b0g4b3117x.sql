-- PROBE (read-only): B0G4B3117X. The seller found recent units were bought for
-- less than the COGS being reported and wants the cost adjusted.
--
-- Before changing anything: every cost source the resolver reads, in the order
-- it reads them, and the lock state of every sale. resolve_unit_cost_v1 returns
-- a LOCKED sale-time snapshot at step 1, before it looks at purchases or
-- listings at all -- so a corrected purchase cost does nothing for an order
-- whose cost is already locked. Which orders are locked decides the whole plan.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== created_listings (cost = LOT TOTAL, amount = UNIT) ========';
  FOR r IN
    SELECT id, sku, units, cost, amount, date_created, created_at, updated_at, title
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY date_created NULLS LAST, created_at
  LOOP
    RAISE NOTICE '   sku=%  units=%  cost(lot)=%  amount(unit)=%  -> unit via lot/units=%',
      r.sku, r.units, r.cost, r.amount,
      CASE WHEN COALESCE(r.units,0) > 0 THEN round(r.cost / r.units, 4)::text ELSE 'n/a' END;
    RAISE NOTICE '        date_created=%  created=%  updated=%',
      r.date_created, r.created_at::date, r.updated_at::date;
    RAISE NOTICE '        id=%  title=%', r.id, left(COALESCE(r.title,''), 60);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== created_listing_purchases (purchase batches) ========';
  FOR r IN
    SELECT p.id, p.listing_id, p.units, p.unit_cost, p.total_cost, p.purchase_date, p.created_at
    FROM public.created_listing_purchases p
    JOIN public.created_listings l ON l.id = p.listing_id
    WHERE l.user_id = v_uid AND l.asin = v_asin
    ORDER BY p.purchase_date, p.created_at
  LOOP
    RAISE NOTICE '   purchase_date=%  units=%  unit_cost=%  total=%  created=%',
      r.purchase_date, r.units, r.unit_cost, r.total_cost, r.created_at::date;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== asin_cost_overrides ========';
  FOR r IN
    SELECT unit_cost, effective_from, created_at FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND asin = v_asin ORDER BY effective_from
  LOOP
    RAISE NOTICE '   effective_from=%  unit_cost=%', r.effective_from, r.unit_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== cost_history ========';
  FOR r IN
    SELECT sku, cost, effective_date, recorded_at FROM public.cost_history
    WHERE user_id = v_uid AND asin = v_asin ORDER BY effective_date, recorded_at
  LOOP
    RAISE NOTICE '   sku=%  cost=%  effective=%  recorded=%',
      r.sku, r.cost, r.effective_date, r.recorded_at::date;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== inventory (cost = UNIT, amount = TOTAL) ========';
  FOR r IN
    SELECT sku, cost, amount, units, available, listing_status, manual_cost_source
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   sku=%  cost(unit)=%  amount=%  units=%  avail=%  status=%  manual=%',
      r.sku, r.cost, r.amount, r.units, r.available, r.listing_status, r.manual_cost_source;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== every sale, with its lock state ========';
  FOR r IN
    SELECT order_id, order_date, marketplace, sku, quantity,
           round(total_sale_amount::numeric,2) AS rev,
           unit_cost, unit_cost_at_sale, cost_source_at_sale,
           cost_locked, cost_locked_at, total_cost, order_status
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY order_date
  LOOP
    RAISE NOTICE '   % | % | % | qty=% rev=% | unit_cost=% at_sale=% locked=% src=% | total_cost=% | %',
      r.order_date, r.order_id, r.marketplace, r.quantity, r.rev,
      r.unit_cost, r.unit_cost_at_sale, r.cost_locked, r.cost_source_at_sale,
      r.total_cost, r.order_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== summary ========';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           count(*) FILTER (WHERE cost_locked) AS locked,
           count(*) FILTER (WHERE NOT COALESCE(cost_locked,false)) AS unlocked,
           min(order_date) AS first_sale, max(order_date) AS last_sale,
           round(sum(total_cost)::numeric,2) AS cogs_booked
    FROM public.sales_orders WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   % orders, % units, % locked / % unlocked',
      r.orders, r.units, r.locked, r.unlocked;
    RAISE NOTICE '   first sale %, last sale %, COGS booked %',
      r.first_sale, r.last_sale, r.cogs_booked;
  END LOOP;
END
$probe$;
