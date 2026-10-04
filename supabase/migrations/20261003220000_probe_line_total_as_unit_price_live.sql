-- READ-ONLY PROBE. Mobile Live Sales shows $507.00 for two FBM orders whose
-- real revenue is $117.00:
--
--   114-1602840-1879415  5 x $19.50 = $97.50   (+$6.10 tax)
--   113-8522899-4553061  1 x $19.50 = $19.50   (+$1.29 tax)
--
-- $97.50 x 5 + $19.50 = $507.00 exactly. So the 5-unit order has its LINE TOTAL
-- in a per-unit field, and something then multiplied it by quantity again.
--
-- This is the bug recorded as isolated on 2026-08-24 (two orders, $1,513
-- against a real $340) whose writer was never identified -- five candidate paths
-- were ruled out. This time there is a live pair: the same SKU, the same price,
-- sixty-two minutes apart, one wrong and one right. The difference between them
-- is the bug.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the two orders as stored ==';
  FOR r IN SELECT order_id, order_date, purchase_timestamp_utc, quantity,
                  sold_price, item_price, total_sale_amount, shipping_price,
                  total_fees, referral_fee, fba_fee, shipping_label_fee,
                  fulfillment_channel, price_source, fees_source, price_calc_mode,
                  price_confidence, created_at, updated_at
           FROM public.sales_orders
           WHERE user_id = v_uid
             AND order_id IN ('114-1602840-1879415', '113-8522899-4553061')
           ORDER BY quantity DESC LOOP
    RAISE NOTICE '  % | % | qty %', r.order_id, r.order_date, r.quantity;
    RAISE NOTICE '      sold_price $% | item_price $% | total_sale_amount $% | shipping $%',
      r.sold_price, r.item_price, r.total_sale_amount, r.shipping_price;
    RAISE NOTICE '      fees: total $% (ref $%, fba $%, label $%) | %',
      r.total_fees, r.referral_fee, r.fba_fee, r.shipping_label_fee, r.fees_source;
    RAISE NOTICE '      channel % | price_source % | calc_mode % | confidence %',
      r.fulfillment_channel, r.price_source, r.price_calc_mode, r.price_confidence;
    RAISE NOTICE '      created % | updated %', r.created_at, r.updated_at;
    RAISE NOTICE '      IMPLIED revenue if sold_price is per-unit: $%',
      round((COALESCE(r.sold_price, 0) * r.quantity)::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how widespread is it? multi-unit orders whose sold_price looks like a line total ==';
  RAISE NOTICE '   (sold_price close to total_sale_amount while quantity > 1)';
  FOR r IN SELECT order_id, order_date, quantity, sold_price, total_sale_amount,
                  fulfillment_channel, price_source,
                  round((sold_price * quantity)::numeric, 2) AS would_report
           FROM public.sales_orders
           WHERE user_id = v_uid AND quantity > 1
             AND COALESCE(is_cancelled, false) = false
             AND order_date >= '2026-01-01'
             AND COALESCE(sold_price, 0) > 0
             AND abs(COALESCE(sold_price, 0) - COALESCE(total_sale_amount, 0)) < 0.02
           ORDER BY order_date DESC LIMIT 20 LOOP
    RAISE NOTICE '  % | % | qty % | sold_price $% = total $% -> would report $% | % | %',
      r.order_id, r.order_date, r.quantity, r.sold_price, r.total_sale_amount,
      r.would_report, r.fulfillment_channel, COALESCE(r.price_source, '');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none found by that test)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== this ASIN today, every row ==';
  FOR r IN SELECT order_id, quantity, sold_price, total_sale_amount, price_source, created_at
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B08229T8SS' AND order_date >= '2026-10-01'
           ORDER BY created_at LOOP
    RAISE NOTICE '  % | qty % | sold $% | total $% | % | %',
      r.order_id, r.quantity, r.sold_price, r.total_sale_amount,
      COALESCE(r.price_source, ''), r.created_at;
  END LOOP;
END
$p$;
