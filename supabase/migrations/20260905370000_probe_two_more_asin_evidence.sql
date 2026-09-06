-- PROBE (read-only): same evidence dump for the two ASINs whose output was
-- cut off, plus the arithmetic test that identifies the real mechanism.
--
-- CORRECTION to the earlier read: this is NOT a decimal shift. It is the same
-- Contract A inversion as the listing rows -- the UNIT price was entered into
-- the TOTAL field, and every downstream reader then divided it by units.
--
--   B07VXRVZHH  purchases: units=100, total_cost=$10.79 -> derived $0.1079
--               inventory.amount = $1079 = 100 x $10.79
--   B002J3OC7S  purchases: units=30,  total_cost=$12.32 -> derived $0.4107
--               inventory.amount = $369.51 = 30 x $12.317
--
-- In both, inventory.amount equals (the value in the total field) x units, so
-- that value was the UNIT price all along. The test below applies that check
-- to every affected ASIN rather than to the two that were noticed by eye.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE
  v_asins text[] := ARRAY['B00G3MJ0D2','B079STG3DR'];
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
             left(max(title), 44) AS title
      FROM public.sales_orders
      WHERE asin = a AND COALESCE(is_cancelled,false) = false
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
    LOOP
      RAISE NOTICE 'TITLE  : %', r.title;
      RAISE NOTICE 'SALES  : % orders / % units | sells $%..$% | % locked',
        r.orders, r.units, r.min_price, r.max_price, r.locked;
    END LOOP;

    RAISE NOTICE '-- booked now --';
    FOR r IN SELECT unit_cost, cost_locked, cost_source_at_sale, count(*) AS orders
             FROM public.sales_orders WHERE asin = a GROUP BY 1,2,3 ORDER BY orders DESC LIMIT 6
    LOOP RAISE NOTICE '   unit_cost=% locked=% src=% (% orders)', r.unit_cost, r.cost_locked, r.cost_source_at_sale, r.orders; END LOOP;

    RAISE NOTICE '-- inventory (cost=UNIT, amount=TOTAL) --';
    n := 0;
    FOR r IN SELECT sku, units, cost, amount, unit_cost_manual FROM public.inventory
             WHERE asin = a AND (cost IS NOT NULL OR amount IS NOT NULL)
    LOOP n := n + 1; RAISE NOTICE '   sku=% stock=% cost=% amount=% manual=%', r.sku, r.units, r.cost, r.amount, r.unit_cost_manual; END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- created_listings (cost=LOT TOTAL, amount=UNIT) --';
    n := 0;
    FOR r IN SELECT sku, units, cost, amount, date_created FROM public.created_listings
             WHERE asin = a ORDER BY date_created DESC NULLS LAST LIMIT 6
    LOOP n := n + 1; RAISE NOTICE '   sku=% units=% cost=% amount=% created=%', r.sku, r.units, r.cost, r.amount, r.date_created; END LOOP;
    IF n = 0 THEN RAISE NOTICE '   (none)'; END IF;

    RAISE NOTICE '-- purchases / cost_history / overrides --';
    FOR r IN SELECT p.units, p.unit_cost, p.total_cost, p.purchase_date
             FROM public.created_listing_purchases p JOIN public.created_listings cl ON cl.id = p.listing_id
             WHERE cl.asin = a ORDER BY p.purchase_date DESC LIMIT 4
    LOOP RAISE NOTICE '   purchase units=% unit_cost=% total_cost=% date=%', r.units, r.unit_cost, r.total_cost, r.purchase_date; END LOOP;
    FOR r IN SELECT cost, effective_date, source FROM public.cost_history WHERE asin = a ORDER BY effective_date DESC LIMIT 4
    LOOP RAISE NOTICE '   history cost=% effective=% source=%', r.cost, r.effective_date, r.source; END LOOP;
    FOR r IN SELECT unit_cost, effective_from, note FROM public.asin_cost_overrides WHERE asin = a ORDER BY effective_from DESC LIMIT 3
    LOOP RAISE NOTICE '   override unit_cost=% from=% note=%', r.unit_cost, r.effective_from, r.note; END LOOP;
  END LOOP;

  -- The mechanism test, applied to every ASIN booked under 50c rather than to
  -- the two that happened to be noticed: does inventory.amount equal the
  -- purchase's total_cost x units? If so, that "total" was a unit price.
  RAISE NOTICE '';
  RAISE NOTICE '==== does inventory.amount == purchase.total_cost x units? ====';
  n := 0;
  FOR r IN
    SELECT DISTINCT cl.asin, p.units, p.total_cost, p.unit_cost AS derived_unit,
           i.amount AS inventory_total, i.cost AS inventory_unit,
           round(p.total_cost * p.units, 2) AS total_if_unit_price,
           CASE WHEN i.amount IS NOT NULL AND i.amount > 0
                 AND abs(i.amount - p.total_cost * p.units) <= GREATEST(0.05, abs(i.amount) * 0.01)
                THEN 'CONFIRMS total_cost was a UNIT price' ELSE 'no match' END AS verdict
    FROM public.created_listing_purchases p
    JOIN public.created_listings cl ON cl.id = p.listing_id
    LEFT JOIN public.inventory i ON i.user_id = cl.user_id AND i.sku = cl.sku AND i.amount IS NOT NULL AND i.amount > 0
    WHERE p.unit_cost > 0 AND p.unit_cost < 0.50 AND COALESCE(p.units,0) > 1
    ORDER BY cl.asin
    LIMIT 40
  LOOP
    n := n + 1;
    RAISE NOTICE '% units=% total_cost=% -> derived $% | inv.amount=% vs total_cost*units=% | %',
      r.asin, r.units, r.total_cost, r.derived_unit, r.inventory_total, r.total_if_unit_price, r.verdict;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(no sub-50c purchase rows with units>1)'; END IF;
END
$probe$;
