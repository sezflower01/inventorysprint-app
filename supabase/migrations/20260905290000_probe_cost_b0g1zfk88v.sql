-- PROBE (read-only): per-unit cost for ASIN B0G1ZFK88V in Sales Report and P&L.
--
-- Same shape as 20260905270000/20260905280000 for B0GXCDB8XM, but aggregate
-- FIRST. That order matters: the aggregate covers every row, so one output
-- line proves no outlier exists, while a detail listing only ever shows the
-- newest N and can hide a stale locked snapshot -- which is how the $2,157.92
-- foam sword went unnoticed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE
  v_asin text := 'B0G1ZFK88V';
  r record;
  n int;
BEGIN
  RAISE NOTICE '===== ALL rows for %, grouped by resolved cost =====', v_asin;
  n := 0;
  FOR r IN
    SELECT res.unit_cost, res.source,
           count(*)                     AS orders,
           sum(COALESCE(s.quantity, 1)) AS units,
           min(s.order_date)            AS first_order,
           max(s.order_date)            AS last_order,
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
    n := n + 1;
    RAISE NOTICE 'UNIT $% from [%] : % orders, % units, % .. %, COGS $%',
      r.unit_cost, r.source, r.orders, r.units, r.first_order, r.last_order, r.cogs;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(no sales orders for this ASIN)'; END IF;
  IF n > 1 THEN RAISE NOTICE '*** % DISTINCT unit costs -- the rows above disagree ***', n; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '---- revenue sanity (a cost means nothing without it) ----';
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

  -- ---- The rungs, in ladder order -------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '---- rung 1: locked snapshots on sales_orders ----';
  n := 0;
  FOR r IN SELECT s.unit_cost_at_sale, s.unit_cost, s.cost_locked, s.cost_source_at_sale,
                  s.cost_invalid, count(*) AS orders
           FROM public.sales_orders s WHERE s.asin = v_asin
           GROUP BY 1,2,3,4,5 ORDER BY orders DESC LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'at_sale=% unit_cost=% locked=% src=% invalid=% (% orders)',
    r.unit_cost_at_sale, r.unit_cost, r.cost_locked, r.cost_source_at_sale, r.cost_invalid, r.orders; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '---- rung 2: asin_cost_overrides ----';
  n := 0;
  FOR r IN SELECT o.unit_cost, o.effective_from, o.note
           FROM public.asin_cost_overrides o WHERE o.asin = v_asin
           ORDER BY o.effective_from DESC LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'unit_cost=% effective_from=% note=%', r.unit_cost, r.effective_from, r.note; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '---- rung 3a: cost_history ----';
  n := 0;
  FOR r IN SELECT h.cost, h.prev_cost, h.effective_date, h.recorded_at, h.source, h.sku
           FROM public.cost_history h WHERE h.asin = v_asin
           ORDER BY h.effective_date DESC LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'cost=% prev=% effective=% recorded=% source=% sku=%',
    r.cost, r.prev_cost, r.effective_date, r.recorded_at, r.source, r.sku; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '---- rung 3b: created_listing_purchases ----';
  n := 0;
  FOR r IN SELECT p.unit_cost, p.total_cost, p.units, p.purchase_date, p.note, cl.sku
           FROM public.created_listing_purchases p
           JOIN public.created_listings cl ON cl.id = p.listing_id
           WHERE cl.asin = v_asin
           ORDER BY p.purchase_date DESC LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'unit_cost=% total_cost=% units=% purchased=% sku=% note=%',
    r.unit_cost, r.total_cost, r.units, r.purchase_date, r.sku, r.note; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  -- Contract A: created_listings.cost is the LOT TOTAL, .amount is the UNIT.
  RAISE NOTICE '';
  RAISE NOTICE '---- rung 3b/4: created_listings (cost=LOT TOTAL, amount=UNIT) ----';
  n := 0;
  FOR r IN SELECT cl.sku, cl.units, cl.cost, cl.amount, cl.date_created, cl.title,
                  CASE WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
                       WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
                       ELSE NULL END AS contract_unit_cost,
                  CASE WHEN COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
                         AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
                       THEN 'INCONSISTENT' ELSE 'ok' END AS consistency
           FROM public.created_listings cl WHERE cl.asin = v_asin
           ORDER BY cl.date_created DESC NULLS LAST LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'sku=% units=% cost(TOTAL)=% amount(UNIT)=% -> contract unit $% [%] created=% title=%',
    r.sku, r.units, r.cost, r.amount, r.contract_unit_cost, r.consistency, r.date_created, left(COALESCE(r.title,''), 40); END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  -- Contract A INVERTS here: inventory.cost is UNIT, .amount is TOTAL.
  RAISE NOTICE '';
  RAISE NOTICE '---- rung 5: inventory (cost=UNIT, amount=TOTAL) ----';
  n := 0;
  FOR r IN SELECT i.sku, i.units, i.cost, i.amount, i.unit_cost_manual, i.manual_cost_source,
                  CASE WHEN COALESCE(i.cost,0) > 0 THEN i.cost
                       WHEN COALESCE(i.amount,0) > 0 AND COALESCE(i.units,0) > 0 THEN i.amount / i.units
                       ELSE NULL END AS contract_unit_cost
           FROM public.inventory i WHERE i.asin = v_asin LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'sku=% units=% cost(UNIT)=% amount(TOTAL)=% manual=% src=% -> contract unit $%',
    r.sku, r.units, r.cost, r.amount, r.unit_cost_manual, r.manual_cost_source, r.contract_unit_cost; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '================ END PROBE ================';
END
$probe$;
