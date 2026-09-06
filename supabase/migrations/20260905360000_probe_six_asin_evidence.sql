-- PROBE (read-only): every cost source for the 6 ASINs booked under $0.50,
-- so the corrected unit cost can be confirmed before anything is written.
--
-- Nothing is proposed by formula here. Each source is printed as it stands and
-- the candidates are shown side by side, because the last time a single
-- plausible rule was applied across rows it was wrong on two of them.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE
  v_asins text[] := ARRAY['B00JV57NOG','B08BYX3C46','B07VXRVZHH','B002J3OC7S','B00G3MJ0D2','B079STG3DR'];
  a text; r record; n int;
BEGIN
  FOREACH a IN ARRAY v_asins LOOP
    RAISE NOTICE '';
    RAISE NOTICE '==================== % ====================', a;

    FOR r IN
      SELECT count(*) AS orders, sum(COALESCE(quantity,1)) AS units,
             round(min(NULLIF(item_price,0)),2) AS min_price,
             round(max(item_price),2) AS max_price,
             count(*) FILTER (WHERE cost_locked = true) AS locked,
             min(order_date) AS first_order, max(order_date) AS last_order,
             left(max(title), 46) AS title
      FROM public.sales_orders
      WHERE asin = a AND COALESCE(is_cancelled,false) = false
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
    LOOP
      RAISE NOTICE 'TITLE  : %', r.title;
      RAISE NOTICE 'SALES  : % orders / % units | sells $%..$% | % locked | % .. %',
        r.orders, r.units, r.min_price, r.max_price, r.locked, r.first_order, r.last_order;
    END LOOP;

    RAISE NOTICE '-- booked unit costs now --';
    FOR r IN
      SELECT unit_cost, unit_cost_at_sale, cost_locked, cost_source_at_sale, count(*) AS orders
      FROM public.sales_orders WHERE asin = a
      GROUP BY 1,2,3,4 ORDER BY orders DESC LIMIT 6
    LOOP
      RAISE NOTICE '   unit_cost=% at_sale=% locked=% src=% (% orders)',
        r.unit_cost, r.unit_cost_at_sale, r.cost_locked, r.cost_source_at_sale, r.orders;
    END LOOP;

    RAISE NOTICE '-- inventory (Contract A: cost=UNIT, amount=TOTAL) --';
    n := 0;
    FOR r IN
      SELECT sku, units, cost, amount, unit_cost_manual,
             round(amount / NULLIF(units,0), 4) AS amount_div_units,
             round(cost * 10, 4)  AS cost_x10,
             round(cost * 100, 4) AS cost_x100
      FROM public.inventory WHERE asin = a
    LOOP
      n := n + 1;
      RAISE NOTICE '   sku=% stock=% cost=% amount=% manual=% | amount/units=% | cost*10=% cost*100=%',
        r.sku, r.units, r.cost, r.amount, r.unit_cost_manual,
        r.amount_div_units, r.cost_x10, r.cost_x100;
    END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- created_listings (Contract A: cost=LOT TOTAL, amount=UNIT) --';
    n := 0;
    FOR r IN
      SELECT sku, units, cost, amount, date_created,
             round(cost / NULLIF(units,0), 4) AS cost_div_units
      FROM public.created_listings WHERE asin = a
      ORDER BY date_created DESC NULLS LAST LIMIT 6
    LOOP
      n := n + 1;
      RAISE NOTICE '   sku=% units=% cost(TOTAL)=% amount(UNIT)=% | cost/units=% | created=%',
        r.sku, r.units, r.cost, r.amount, r.cost_div_units, r.date_created;
    END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- created_listing_purchases --';
    n := 0;
    FOR r IN
      SELECT p.units, p.unit_cost, p.total_cost, p.purchase_date
      FROM public.created_listing_purchases p
      JOIN public.created_listings cl ON cl.id = p.listing_id
      WHERE cl.asin = a ORDER BY p.purchase_date DESC LIMIT 6
    LOOP
      n := n + 1;
      RAISE NOTICE '   units=% unit_cost=% total_cost=% date=%',
        r.units, r.unit_cost, r.total_cost, r.purchase_date;
    END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- cost_history --';
    n := 0;
    FOR r IN
      SELECT cost, effective_date, source, sku FROM public.cost_history
      WHERE asin = a ORDER BY effective_date DESC LIMIT 6
    LOOP
      n := n + 1;
      RAISE NOTICE '   cost=% effective=% source=% sku=%', r.cost, r.effective_date, r.source, r.sku;
    END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- asin_cost_overrides --';
    n := 0;
    FOR r IN
      SELECT unit_cost, effective_from, note FROM public.asin_cost_overrides
      WHERE asin = a ORDER BY effective_from DESC LIMIT 4
    LOOP
      n := n + 1;
      RAISE NOTICE '   unit_cost=% from=% note=%', r.unit_cost, r.effective_from, r.note;
    END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '==================== END EVIDENCE ====================';
END
$probe$;
