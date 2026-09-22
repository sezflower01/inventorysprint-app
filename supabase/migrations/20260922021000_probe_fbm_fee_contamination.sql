-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- sync-sales-orders enriches fees per ASIN and decides the channel with
--   const isFbmAsin = marketplaceOrders.some(o => o.fulfillment_channel === 'MFN')
-- so ONE FBM order makes every order of that ASIN get FBM fees: referral and
-- closing zeroed, everything bundled into fba_fee, and no FBA fulfilment fee.
-- Measure the damage: FBA (AFN) orders carrying FBM fee sources, and the
-- reverse (MFN orders carrying FBA fees).

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 2026 orders by channel x fee source ==';
  FOR r IN SELECT COALESCE(fulfillment_channel,'(null)') AS channel, COALESCE(fees_source,'(none)') AS src,
                  count(*) AS orders, round(sum(COALESCE(total_sale_amount, item_price, 0))::numeric, 2) AS revenue,
                  round(sum(COALESCE(total_fees,0))::numeric, 2) AS fees_charged
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false
           GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12 LOOP
    RAISE NOTICE '  % / % : % orders | revenue % | fees %', r.channel, r.src, r.orders, r.revenue, r.fees_charged;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the wrong ones: AFN (FBA) orders given FBM fees ==';
  FOR r IN SELECT count(*) AS orders, count(DISTINCT asin) AS asins,
                  round(sum(COALESCE(total_sale_amount, item_price, 0))::numeric, 2) AS revenue,
                  round(sum(COALESCE(total_fees,0))::numeric, 2) AS fees_charged,
                  round(avg(CASE WHEN COALESCE(total_sale_amount, item_price, 0) > 0
                                 THEN COALESCE(total_fees,0) / COALESCE(total_sale_amount, item_price) * 100 END)::numeric, 1) AS avg_fee_pct
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false
             AND fulfillment_channel = 'AFN' AND fees_source = 'fees_api_fbm' LOOP
    RAISE NOTICE '  % orders over % ASINs | revenue % | fees charged % (avg % pct of price)', r.orders, r.asins, r.revenue, r.fees_charged, r.avg_fee_pct;
  END LOOP;
  FOR r IN SELECT order_id, asin, sku, round(COALESCE(total_sale_amount, item_price, 0)::numeric,2) AS price,
                  referral_fee, fba_fee, total_fees, roi, to_char(order_date,'MM-DD') AS d
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false
             AND fulfillment_channel = 'AFN' AND fees_source = 'fees_api_fbm'
           ORDER BY order_date DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | % % | price % | referral % fba % total % | roi % | %', r.order_id, r.asin, r.sku, r.price, r.referral_fee, r.fba_fee, r.total_fees, r.roi, r.d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== for comparison: what FBA fees the same ASINs normally carry ==';
  FOR r IN SELECT o.asin, count(*) AS fba_orders,
                  round(avg(o.fba_fee)::numeric, 2) AS avg_fba_fee, round(avg(o.referral_fee)::numeric, 2) AS avg_referral,
                  round(avg(COALESCE(o.total_sale_amount, o.item_price))::numeric, 2) AS avg_price
           FROM public.sales_orders o
           WHERE o.user_id = v_uid AND o.order_date >= '2026-01-01' AND COALESCE(o.is_cancelled,false) = false
             AND o.fulfillment_channel = 'AFN' AND o.fees_source <> 'fees_api_fbm' AND COALESCE(o.fba_fee,0) > 0
             AND o.asin IN (SELECT asin FROM public.sales_orders WHERE user_id = v_uid AND fees_source = 'fees_api_fbm' AND fulfillment_channel = 'AFN')
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % FBA orders | avg fba fee % | avg referral % | avg price %', r.asin, r.fba_orders, r.avg_fba_fee, r.avg_referral, r.avg_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the swapped fulfillment_type on the repricer rows ==';
  FOR r IN WITH inv AS (
             SELECT asin, sku, CASE WHEN source = 'amazon_sync_fbm' THEN 'FBM' ELSE 'FBA' END AS inv_channel
             FROM public.inventory WHERE user_id = v_uid)
           SELECT count(*) AS mismatched, count(DISTINCT a.asin) AS asins
           FROM public.repricer_assignments a JOIN inv ON inv.sku = a.sku
           WHERE a.user_id = v_uid AND a.fulfillment_type IS NOT NULL
             AND upper(a.fulfillment_type) <> inv.inv_channel LOOP
    RAISE NOTICE '  assignments whose fulfillment_type disagrees with the inventory source: % over % ASINs', r.mismatched, r.asins;
  END LOOP;
END
$p$;
