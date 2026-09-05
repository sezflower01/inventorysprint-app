-- Read-only: is a lot-total-in-a-unit-cost field one SKU or many?
DO $$
DECLARE r RECORD; v_total bigint; v_bad bigint; v_sum numeric;
BEGIN
  SELECT count(*) INTO v_total FROM public.inventory WHERE cost IS NOT NULL AND cost > 0;
  SELECT count(*), COALESCE(sum(cost),0) INTO v_bad, v_sum
    FROM public.inventory WHERE cost > 300;
  RAISE NOTICE 'inventory rows with a cost: % | rows over $300: % (totalling $%)',
    v_total, v_bad, round(v_sum, 2);

  FOR r IN
    SELECT sku, asin, cost, available, updated_at
    FROM public.inventory WHERE cost > 300
    ORDER BY cost DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % / % : cost=% avail=% updated=%',
      rpad(r.sku, 18), r.asin, r.cost, r.available, r.updated_at;
  END LOOP;

  -- Does the sales side agree? A big gap means one of the two is a lot total.
  FOR r IN
    SELECT i.sku, i.asin, i.cost AS inv_cost,
           (SELECT round(avg(s.unit_cost), 2) FROM public.sales_orders s
             WHERE s.asin = i.asin AND s.unit_cost > 0) AS sales_unit_cost
    FROM public.inventory i WHERE i.cost > 300
    ORDER BY i.cost DESC LIMIT 8
  LOOP
    RAISE NOTICE '  % : inventory says %, sales say % per unit',
      r.asin, r.inv_cost, COALESCE(r.sales_unit_cost::text, 'n/a');
  END LOOP;
END $$;
