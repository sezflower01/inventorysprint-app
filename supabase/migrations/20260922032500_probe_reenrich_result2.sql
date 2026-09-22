-- READ-ONLY PROBE. Did the re-enrichment (requests 22317/22318 after clearing fees_source) fix the fees
-- on the FBA orders that had been billed as FBM?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT id, status_code, left(content, 300) AS body FROM net._http_response WHERE id IN (22317, 22318) ORDER BY id LOOP
    RAISE NOTICE 'request % -> HTTP % | %', r.id, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT COALESCE(fees_source,'(none)') AS src, fulfillment_channel AS channel, count(*) AS orders,
                  round(avg(COALESCE(referral_fee,0))::numeric,2) AS avg_referral,
                  round(avg(COALESCE(fba_fee,0))::numeric,2) AS avg_fba,
                  round(avg(COALESCE(total_fees,0))::numeric,2) AS avg_total
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin IN ('B0CBCSWDQZ','B0G3XTWZYX') AND COALESCE(is_cancelled,false) = false
             AND order_date >= '2026-01-01'
           GROUP BY 1, 2 ORDER BY 3 DESC LOOP
    RAISE NOTICE '  % / % : % orders | avg referral % | avg fba % | avg total %', r.src, COALESCE(r.channel,'(null)'), r.orders, r.avg_referral, r.avg_fba, r.avg_total;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT order_id, asin, fulfillment_channel AS ch, fees_source, referral_fee, fba_fee, total_fees,
                  round(COALESCE(total_sale_amount, item_price, 0)::numeric,2) AS price, roi
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin IN ('B0CBCSWDQZ','B0G3XTWZYX') AND COALESCE(is_cancelled,false) = false
           ORDER BY order_date DESC LIMIT 6 LOOP
    RAISE NOTICE '  % | % % | % | price % | referral % fba % total % | roi %', r.order_id, r.asin, r.ch, r.fees_source, r.price, r.referral_fee, r.fba_fee, r.total_fees, r.roi;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) AS still_wrong FROM public.sales_orders
           WHERE user_id = v_uid AND fulfillment_channel = 'AFN' AND fees_source = 'fees_api_fbm'
             AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false LOOP
    RAISE NOTICE 'AFN orders still carrying FBM fees: %', r.still_wrong;
  END LOOP;
END
$p$;
