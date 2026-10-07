-- READ-ONLY PROBE. Seller Central: order 702-5492481-4068251, CA marketplace,
-- B002HJ4HSS / KVB-CBK-JRNR, bought 2026-10-06 18:05 PDT, qty 1, CA$34.13.
-- Live Sales and the Sales Report show $14.56.
--
-- CA$34.13 is not $14.56 at any rate anyone uses -- 0.72 gives $24.57, and
-- 14.56/34.13 = 0.4266 is not a currency. So the FX is not being applied to
-- the right number; a different number is being used.
--
-- The order is PENDING, which is exactly when this app substitutes an estimate
-- for a price it does not yet have, and sales_orders carries a whole estimator
-- vocabulary for it: estimated_price, locked_est_price, locked_from,
-- price_calc_mode, price_confidence, bb_estimate_*. Find which one produced
-- 14.56 before touching anything.

DO $p$
DECLARE v_uid uuid; r record; found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the order row ==';
  FOR r IN
    SELECT order_id, asin, sku, seller_sku, quantity, marketplace,
           sold_price, item_price, total_sale_amount, estimated_price,
           locked_est_price, locked_from, price_locked_at,
           price_source, price_calc_mode, price_confidence, price_enrich_status,
           needs_price_enrich, price_attempt_count, price_last_error,
           bb_estimate_price, bb_estimate_marketplace, bb_estimate_qualified,
           bb_estimate_owner_match, bb_estimate_captured_at,
           order_status, status, is_cancelled, fulfillment_channel,
           order_date, purchase_timestamp_utc, created_at, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-5492481-4068251'
  LOOP
    found := true;
    RAISE NOTICE '  asin % | sku % | seller_sku % | qty % | marketplace %',
      r.asin, r.sku, COALESCE(r.seller_sku, '-'), r.quantity, COALESCE(r.marketplace, '(null)');
    RAISE NOTICE '  sold_price % | item_price % | total_sale_amount %',
      r.sold_price, COALESCE(r.item_price::text, '-'), COALESCE(r.total_sale_amount::text, '-');
    RAISE NOTICE '  estimated_price % | locked_est_price % | locked_from % | locked_at %',
      COALESCE(r.estimated_price::text, '-'), COALESCE(r.locked_est_price::text, '-'),
      COALESCE(r.locked_from, '-'), COALESCE(r.price_locked_at::text, '-');
    RAISE NOTICE '  price_source % | calc_mode % | confidence % | enrich_status %',
      COALESCE(r.price_source, '-'), COALESCE(r.price_calc_mode, '-'),
      COALESCE(r.price_confidence::text, '-'), COALESCE(r.price_enrich_status, '-');
    RAISE NOTICE '  needs_enrich % | attempts % | last_error %',
      r.needs_price_enrich, COALESCE(r.price_attempt_count::text, '-'),
      COALESCE(left(r.price_last_error, 90), '-');
    RAISE NOTICE '  bb_estimate price % | mkt % | qualified % | owner_match % | at %',
      COALESCE(r.bb_estimate_price::text, '-'), COALESCE(r.bb_estimate_marketplace, '-'),
      COALESCE(r.bb_estimate_qualified::text, '-'), COALESCE(r.bb_estimate_owner_match::text, '-'),
      COALESCE(r.bb_estimate_captured_at::text, '-');
    RAISE NOTICE '  order_status % | status % | cancelled % | channel %',
      COALESCE(r.order_status, '-'), COALESCE(r.status, '-'), r.is_cancelled,
      COALESCE(r.fulfillment_channel, '-');
    RAISE NOTICE '  order_date % | purchase_utc % | written % | updated %',
      r.order_date, COALESCE(r.purchase_timestamp_utc::text, '-'), r.created_at, r.updated_at;
  END LOOP;
  IF NOT found THEN RAISE NOTICE '  (NO ROW for this order id at all)'; END IF;

  RAISE NOTICE '';
END
$p$;
