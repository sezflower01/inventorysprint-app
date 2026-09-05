-- PROBE (read-only): what per-unit cost do Sales Report and P&L report for
-- ASIN B0GXCDB8XM, and which rung of the ladder produced it?
--
-- Creates nothing and changes nothing. Every statement is a SELECT; the output
-- is RAISE NOTICE, read from the db push log.
--
-- Both readers are supposed to agree. P&L goes through the SQL ladder
-- public.resolve_unit_cost_v1; Live Sales / Sales Report go through
-- src/lib/cogs/resolveUnitCost.ts, which claims to mirror it "byte-for-byte".
-- This dumps the SQL answer AND the raw rows each rung reads, so a divergence
-- between the two implementations is visible rather than inferred.

DO $probe$
DECLARE
  v_asin text := 'B0GXCDB8XM';
  r record;
  n int;
BEGIN
  RAISE NOTICE '================ SALES ORDERS: % ================', v_asin;
  n := 0;
  FOR r IN
    SELECT s.order_id, s.order_date, s.quantity,
           COALESCE(s.seller_sku, s.sku) AS sku,
           s.unit_cost, s.unit_cost_at_sale, s.cost_locked, s.cost_source_at_sale,
           s.total_cost, s.item_price, s.order_status, s.marketplace, s.cost_invalid
    FROM public.sales_orders s
    WHERE s.asin = v_asin
    ORDER BY s.order_date DESC
    LIMIT 40
  LOOP
    n := n + 1;
    RAISE NOTICE 'order=% date=% qty=% sku=% | unit_cost=% unit_cost_at_sale=% locked=% src_at_sale=% invalid=% | total_cost=% price=% status=% mp=%',
      r.order_id, r.order_date, r.quantity, r.sku,
      r.unit_cost, r.unit_cost_at_sale, r.cost_locked, r.cost_source_at_sale, r.cost_invalid,
      r.total_cost, r.item_price, r.order_status, r.marketplace;
  END LOOP;
  RAISE NOTICE 'sales_orders rows: %', n;

  -- What the P&L actually computes. Same LATERAL call get_monthly_cogs and
  -- get_cogs_for_range make, with the identical snapshot precedence.
  RAISE NOTICE '';
  RAISE NOTICE '========== RESOLVED (this is the P&L number) ==========';
  n := 0;
  FOR r IN
    SELECT s.order_id, s.order_date, s.quantity,
           res.unit_cost AS resolved_unit_cost,
           res.source,
           round(res.unit_cost * COALESCE(s.quantity, 1), 2) AS line_cogs
    FROM public.sales_orders s
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      s.user_id,
      s.asin,
      COALESCE(s.seller_sku, s.sku),
      s.order_date::date,
      CASE
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale, 0) > 0 THEN s.unit_cost_at_sale
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost, 0) > 0 THEN s.unit_cost
        ELSE NULL
      END
    ) res
    WHERE s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
    ORDER BY s.order_date DESC
    LIMIT 40
  LOOP
    n := n + 1;
    RAISE NOTICE 'order=% date=% qty=% -> UNIT $% from [%] (line COGS $%)',
      r.order_id, r.order_date, r.quantity, r.resolved_unit_cost, r.source, r.line_cogs;
  END LOOP;
  RAISE NOTICE 'resolved rows: %', n;

  -- ---- The rungs, in ladder order -------------------------------------
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
  FOR r IN SELECT p.unit_cost, p.total_cost, p.units, p.purchase_date, p.note, cl.sku, cl.asin
           FROM public.created_listing_purchases p
           JOIN public.created_listings cl ON cl.id = p.listing_id
           WHERE cl.asin = v_asin
           ORDER BY p.purchase_date DESC LIMIT 10
  LOOP n := n + 1; RAISE NOTICE 'unit_cost=% total_cost=% units=% purchased=% sku=% note=%',
    r.unit_cost, r.total_cost, r.units, r.purchase_date, r.sku, r.note; END LOOP;
  IF n = 0 THEN RAISE NOTICE '(none)'; END IF;

  -- Contract A: created_listings.cost is the LOT TOTAL, .amount is the UNIT
  -- cost. Printing the derived unit alongside both raw fields is the whole
  -- point -- reading .cost as a unit cost is what put $2,157.92 on two units
  -- of a foam sword on 2026-09-04.
  RAISE NOTICE '';
  RAISE NOTICE '---- rung 3b/4: created_listings (cost=LOT TOTAL, amount=UNIT) ----';
  n := 0;
  FOR r IN SELECT cl.sku, cl.units, cl.cost, cl.amount, cl.date_created, cl.price, cl.title,
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

  -- Contract A INVERTS here: inventory.cost is the UNIT cost and .amount is
  -- the TOTAL stock value -- the opposite of created_listings above.
  RAISE NOTICE '';
  RAISE NOTICE '---- rung 5: inventory (cost=UNIT, amount=TOTAL) ----';
  n := 0;
  FOR r IN SELECT i.sku, i.units, i.cost, i.amount, i.unit_cost_manual,
                  i.manual_cost_source, i.manual_cost_updated_at,
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
