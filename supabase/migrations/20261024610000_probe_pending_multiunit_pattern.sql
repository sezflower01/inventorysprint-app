-- READ-ONLY. How wide is the multi-unit pending understatement?
--
-- The example order is NOT a quantity bug: 113-1305212-7465044 stores
-- quantity 2 correctly. What it stores wrong is the money --
-- total_sale_amount 24.99 where Amazon shows 2 x $24.99 = $49.98, and
-- sold_price 12.495, which is 24.99/2.
--
-- live-sales-core.ts already documents this exact failure
-- (isRecentPendingSuspectLowball): a still-Pending order can carry a
-- preliminary ItemPrice from Amazon before payment authorisation finishes.
-- That guard compares against estimated_price * qty -- so it is blind on any
-- row where estimated_price IS NULL, which is the case here.
--
-- No SP-API calls: everything below is measured from what is already stored.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== last 30 days: rows by quantity and order_status ==';
  FOR r IN
    SELECT CASE WHEN quantity = 1 THEN '1' WHEN quantity = 2 THEN '2'
                WHEN quantity BETWEEN 3 AND 5 THEN '3-5' ELSE '6+' END AS qty,
           COALESCE(order_status,'(null)') AS st, count(*) AS n
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 30
    GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '   qty % | % | % rows', rpad(r.qty,4), rpad(r.st,12), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== multi-unit (qty>1) rows in the last 30 days ==';
  FOR r IN
    SELECT COALESCE(order_status,'(null)') AS st,
           count(*) AS n,
           count(*) FILTER (WHERE estimated_price IS NULL) AS no_estimate,
           count(*) FILTER (WHERE roi < 0) AS negative_roi,
           count(*) FILTER (WHERE round(sold_price * quantity, 2)
                                 = round(total_sale_amount, 2)) AS internally_consistent
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 30 AND quantity > 1
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % | % rows | % without estimated_price | % negative ROI | % internally consistent',
      rpad(r.st,12), lpad(r.n::text,5), lpad(r.no_estimate::text,5),
      lpad(r.negative_roi::text,5), r.internally_consistent;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the tell: PENDING multi-unit rows whose unit price looks halved ==';
  RAISE NOTICE '   (sold_price far below the per-unit cost is not a real sale)';
  FOR r IN
    SELECT order_id, asin, quantity,
           round(sold_price,2) AS unit_px, round(total_sale_amount,2) AS total,
           round(unit_cost,2) AS unit_cost, round(roi,1) AS roi,
           COALESCE(price_source,'(null)') AS src,
           CASE WHEN estimated_price IS NULL THEN 'NULL' ELSE round(estimated_price,2)::text END AS est,
           order_date
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 30
      AND quantity > 1 AND lower(COALESCE(order_status,'')) = 'pending'
      AND sold_price IS NOT NULL AND unit_cost IS NOT NULL
      AND sold_price < unit_cost
    ORDER BY order_date DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | q% | unit % vs cost % | total % | roi % | src % | est %',
      r.order_id, r.asin, r.quantity, lpad(r.unit_px::text,8), lpad(r.unit_cost::text,8),
      lpad(r.total::text,8), lpad(r.roi::text,7), rpad(r.src,18), r.est;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none found'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== scale: pending multi-unit rows selling below cost, last 30d ==';
  FOR r IN
    SELECT count(*) AS n,
           round(sum(total_sale_amount)::numeric,2) AS booked,
           round(sum(sold_price * quantity * quantity)::numeric,2) AS if_unit_price_were_right
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 30
      AND quantity > 1 AND lower(COALESCE(order_status,'')) = 'pending'
      AND sold_price IS NOT NULL AND unit_cost IS NOT NULL AND sold_price < unit_cost
  LOOP
    RAISE NOTICE '   % rows | booked % | if the stored unit price is really the line total: %',
      r.n, r.booked, r.if_unit_price_were_right;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do SETTLED multi-unit orders self-heal? ==';
  FOR r IN
    SELECT COALESCE(price_source,'(null)') AS src, count(*) AS n,
           count(*) FILTER (WHERE sold_price < unit_cost) AS below_cost
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 90
      AND quantity > 1 AND lower(COALESCE(order_status,'')) <> 'pending'
    GROUP BY 1 ORDER BY n DESC LIMIT 8
  LOOP RAISE NOTICE '   % | % rows | % below cost', rpad(r.src,24), lpad(r.n::text,5), r.below_cost; END LOOP;
END
$p$;
