-- Read-only: is September's tax inflated by duplicate financial events?
DO $$
DECLARE r RECORD; v_uid uuid; v_rows bigint; v_orders bigint; v_dupe bigint; v_dupe_amt numeric;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;

  SELECT count(*), count(DISTINCT amazon_order_id) INTO v_rows, v_orders
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-09-01' AND event_date < '2026-10-01'
    AND COALESCE(sales_tax_collected,0) <> 0;
  RAISE NOTICE 'Sep rows with tax: % across % distinct orders', v_rows, v_orders;

  -- Same order appearing more than once with tax.
  SELECT count(*), COALESCE(sum(extra),0) INTO v_dupe, v_dupe_amt FROM (
    SELECT amazon_order_id, count(*) AS n,
           SUM(COALESCE(sales_tax_collected,0)) - MAX(COALESCE(sales_tax_collected,0)) AS extra
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-09-01' AND event_date < '2026-10-01'
      AND COALESCE(sales_tax_collected,0) <> 0
    GROUP BY amazon_order_id HAVING count(*) > 1
  ) x;
  RAISE NOTICE 'orders appearing more than once: % | tax beyond the first row: $%',
    v_dupe, round(v_dupe_amt, 2);

  FOR r IN
    SELECT event_type, count(*) AS n, SUM(COALESCE(sales_tax_collected,0)) AS tax
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-09-01' AND event_date < '2026-10-01'
      AND COALESCE(sales_tax_collected,0) <> 0
    GROUP BY event_type ORDER BY SUM(COALESCE(sales_tax_collected,0)) DESC
  LOOP
    RAISE NOTICE '  event_type % : % rows, $%', r.event_type, r.n, round(r.tax,2);
  END LOOP;
END $$;
