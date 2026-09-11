-- PROBE (read-only): B0G4B3117X, second pass. The first pass overflowed on the
-- created_listings section alone -- dozens of 12-unit lots at 174.75 -- and
-- never reached the sections that decide the plan. Listings are summarised
-- here instead of printed row by row.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== created_listings, summarised by unit cost ========';
  FOR r IN
    SELECT round((cost / NULLIF(units,0))::numeric, 4) AS unit_via_lot,
           round(amount::numeric, 4) AS amount_unit,
           count(*) AS lots, sum(units) AS units,
           min(date_created) AS first_lot, max(date_created) AS last_lot,
           max(updated_at)::date AS last_edit
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1, 2 ORDER BY min(date_created)
  LOOP
    RAISE NOTICE '   unit=% (amount=%)  % lots, % units  dated % .. %  last edited %',
      r.unit_via_lot, r.amount_unit, r.lots, r.units, r.first_lot, r.last_lot, r.last_edit;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the newest 8 lots individually ========';
  FOR r IN
    SELECT id, units, cost, amount, date_created, created_at::date AS created, updated_at::date AS updated
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY date_created DESC NULLS LAST, created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | units=% lot=% unit=% | created % updated % | %',
      r.date_created, r.units, r.cost,
      round((r.cost / NULLIF(r.units,0))::numeric,4), r.created, r.updated, r.id;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== purchase batches ========';
  FOR r IN
    SELECT p.purchase_date, p.units, p.unit_cost, p.total_cost, p.created_at::date AS created
    FROM public.created_listing_purchases p
    JOIN public.created_listings l ON l.id = p.listing_id
    WHERE l.user_id = v_uid AND l.asin = v_asin
    ORDER BY p.purchase_date
  LOOP
    RAISE NOTICE '   % units=% unit_cost=% total=% (entered %)',
      r.purchase_date, r.units, r.unit_cost, r.total_cost, r.created;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== overrides / cost_history / inventory ========';
  FOR r IN SELECT effective_from, unit_cost FROM public.asin_cost_overrides
           WHERE user_id = v_uid AND asin = v_asin ORDER BY effective_from
  LOOP RAISE NOTICE '   OVERRIDE effective % unit %', r.effective_from, r.unit_cost; END LOOP;
  FOR r IN SELECT effective_date, cost, recorded_at::date AS rec FROM public.cost_history
           WHERE user_id = v_uid AND asin = v_asin ORDER BY effective_date
  LOOP RAISE NOTICE '   COST_HISTORY effective % cost % recorded %', r.effective_date, r.cost, r.rec; END LOOP;
  FOR r IN SELECT sku, cost, amount, units, available, listing_status FROM public.inventory
           WHERE user_id = v_uid AND asin = v_asin
  LOOP RAISE NOTICE '   INVENTORY sku=% unit=% amount=% units=% avail=% %',
         r.sku, r.cost, r.amount, r.units, r.available, r.listing_status; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== sales, grouped by cost and lock state ========';
  FOR r IN
    SELECT COALESCE(cost_locked,false) AS locked,
           round(COALESCE(unit_cost_at_sale, unit_cost)::numeric, 4) AS unit,
           cost_source_at_sale AS src,
           count(*) AS orders, sum(quantity) AS units,
           min(order_date) AS first_sale, max(order_date) AS last_sale,
           round(sum(total_cost)::numeric, 2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1, 2, 3 ORDER BY min(order_date)
  LOOP
    RAISE NOTICE '   locked=%  unit=%  src=%  | % orders, % units | % .. % | COGS %',
      r.locked, r.unit, r.src, r.orders, r.units, r.first_sale, r.last_sale, r.cogs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the 12 most recent sales ========';
  FOR r IN
    SELECT order_date, order_id, marketplace, quantity, unit_cost, unit_cost_at_sale,
           cost_locked, cost_source_at_sale, total_cost, order_status
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY order_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % % % qty=% unit=% at_sale=% locked=% src=% cogs=% %',
      r.order_date, r.order_id, r.marketplace, r.quantity, r.unit_cost,
      r.unit_cost_at_sale, r.cost_locked, r.cost_source_at_sale, r.total_cost, r.order_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals by year ========';
  FOR r IN
    SELECT extract(year FROM order_date)::int AS yr, count(*) AS orders, sum(quantity) AS units,
           count(*) FILTER (WHERE cost_locked) AS locked,
           round(sum(total_cost)::numeric,2) AS cogs
    FROM public.sales_orders WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders, % units, % locked, COGS %', r.yr, r.orders, r.units, r.locked, r.cogs;
  END LOOP;
END
$probe$;
