-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: order 113-1733950-4411411 (ASIN B0G3XTWZYX, SKU XAS-552-ZTOO, $50)
-- is FBA on Amazon ("Fulfillment: Amazon") but Live Sales calls it FBM and
-- charges only a 15% referral fee -- no FBA fulfilment fee -- so profit is
-- overstated. Suspicion: fulfilment is resolved per ASIN, and this ASIN has
-- both an FBA and an FBM listing.
-- Check the stored order, that ASIN's SKUs, and how widespread dual-channel
-- ASINs are.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the order as stored ==';
  FOR r IN SELECT order_id, asin, sku, seller_sku, fulfillment_channel, order_status, status, quantity,
                  item_price, sold_price, total_sale_amount, referral_fee, fba_fee, closing_fee, total_fees,
                  fees_source, fees_missing, needs_fee_enrich, unit_cost, unit_cost_at_sale, roi,
                  to_char(order_date, 'MM-DD HH24:MI') AS ordered, to_char(created_at, 'MM-DD HH24:MI') AS written
           FROM public.sales_orders WHERE user_id = v_uid AND order_id = '113-1733950-4411411' LOOP
    RAISE NOTICE '  % | asin % | sku % | seller_sku % | channel % | status %/% | qty % | price % sold % total %',
      r.order_id, r.asin, r.sku, r.seller_sku, r.fulfillment_channel, r.order_status, r.status, r.quantity, r.item_price, r.sold_price, r.total_sale_amount;
    RAISE NOTICE '    fees: referral % | fba % | closing % | total % | source % | missing % | needs_enrich % | cost % / % | roi %',
      r.referral_fee, r.fba_fee, r.closing_fee, r.total_fees, r.fees_source, r.fees_missing, r.needs_fee_enrich, r.unit_cost, r.unit_cost_at_sale, r.roi;
    RAISE NOTICE '    ordered % | written %', r.ordered, r.written;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every SKU we hold for B0G3XTWZYX ==';
  FOR r IN SELECT sku, source, available, reserved, inbound, units, listing_status, fnsku,
                  to_char(last_inventory_sync_at, 'MM-DD HH24:MI') AS synced
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B0G3XTWZYX' ORDER BY sku LOOP
    RAISE NOTICE '  inventory: % | source % | avail % res % inb % units % | % | fnsku % | synced %',
      r.sku, COALESCE(r.source,'-'), r.available, r.reserved, r.inbound, r.units, r.listing_status, COALESCE(r.fnsku,'-'), r.synced;
  END LOOP;
  FOR r IN SELECT sku, marketplace, fulfillment_type, status, is_enabled
           FROM public.repricer_assignments WHERE user_id = v_uid AND asin = 'B0G3XTWZYX' ORDER BY marketplace, sku LOOP
    RAISE NOTICE '  assignment: %/% | fulfillment % | % enabled %', r.marketplace, r.sku, COALESCE(r.fulfillment_type,'-'), r.status, r.is_enabled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many ASINs have BOTH an FBA and an FBM SKU? ==';
  FOR r IN WITH per_asin AS (
             SELECT asin,
                    count(*) FILTER (WHERE source = 'amazon_sync_fbm') AS fbm_skus,
                    count(*) FILTER (WHERE COALESCE(source,'') <> 'amazon_sync_fbm') AS other_skus
             FROM public.inventory WHERE user_id = v_uid GROUP BY asin)
           SELECT count(*) AS asins_both FROM per_asin WHERE fbm_skus > 0 AND other_skus > 0 LOOP
    RAISE NOTICE '  ASINs with both channels: %', r.asins_both;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== orders on dual-channel ASINs: what channel did we store? ==';
  FOR r IN WITH dual AS (
             SELECT asin FROM public.inventory WHERE user_id = v_uid GROUP BY asin
             HAVING count(*) FILTER (WHERE source = 'amazon_sync_fbm') > 0
                AND count(*) FILTER (WHERE COALESCE(source,'') <> 'amazon_sync_fbm') > 0)
           SELECT COALESCE(o.fulfillment_channel, '(null)') AS channel, count(*) AS orders,
                  count(*) FILTER (WHERE COALESCE(o.fba_fee,0) = 0) AS without_fba_fee,
                  round(sum(COALESCE(o.total_sale_amount, o.item_price, 0))::numeric, 2) AS revenue
           FROM public.sales_orders o JOIN dual d ON d.asin = o.asin
           WHERE o.user_id = v_uid AND o.order_date >= '2026-01-01' AND COALESCE(o.is_cancelled,false) = false
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  channel % : % orders (% with no FBA fee) | revenue %', r.channel, r.orders, r.without_fba_fee, r.revenue;
  END LOOP;
END
$p$;
