-- READ-ONLY PROBE. Any other orders account-wide still carrying FBM fees while
-- not being seller-fulfilled, and what the correction was worth on the two
-- ASINs already fixed.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT asin, COALESCE(fulfillment_channel,'(null)') AS ch, count(*) AS orders,
                  round(sum(COALESCE(total_fees,0))::numeric,2) AS fees,
                  round(avg(COALESCE(total_sale_amount, item_price, 0))::numeric,2) AS avg_price
           FROM public.sales_orders
           WHERE user_id = v_uid AND fees_source = 'fees_api_fbm'
             AND COALESCE(fulfillment_channel,'AFN') <> 'MFN'
             AND COALESCE(is_cancelled,false) = false AND order_date >= '2026-01-01'
           GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10 LOOP
    RAISE NOTICE 'still FBM-priced: % % | % orders | fees % | avg price %', r.asin, r.ch, r.orders, r.fees, r.avg_price;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM public.sales_orders
           WHERE user_id = v_uid AND fees_source = 'fees_api_fbm'
             AND COALESCE(fulfillment_channel,'AFN') <> 'MFN'
             AND COALESCE(is_cancelled,false) = false AND order_date >= '2026-01-01' LOOP
    RAISE NOTICE 'total non-MFN orders still on the FBM fee path: %', r.n;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) AS orders, round(sum(COALESCE(total_fees,0))::numeric,2) AS fees_now,
                  round(sum(COALESCE(total_sale_amount, item_price, 0))::numeric,2) AS revenue
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin IN ('B0CBCSWDQZ','B0G3XTWZYX') AND fees_source = 'fees_api'
             AND COALESCE(fulfillment_channel,'AFN') <> 'MFN' AND COALESCE(is_cancelled,false) = false LOOP
    RAISE NOTICE 'corrected rows: % orders | revenue % | fees now booked %', r.orders, r.revenue, r.fees_now;
  END LOOP;
END
$p$;
