-- READ-ONLY PROBE. The screen still says $14.56 after the currency relabel and
-- the fetch-live-orders deploy. Two candidate reasons, and they need different
-- fixes, so read the row rather than assume:
--   1. the estimate is still 20.75 -- the re-derive never ran, because Tier B
--      only computes when there is no estimate yet, and there is one
--   2. the estimate moved to 29.57 and the page is still showing 14.56 --
--      in which case the conversion is happening somewhere I have not looked

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the order row, now ==';
  FOR r IN
    SELECT estimated_price, sold_price, price_source, price_calc_mode,
           price_confidence, needs_price_enrich, price_attempt_count,
           order_status, marketplace, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-5492481-4068251'
  LOOP
    RAISE NOTICE '  estimated_price % | sold_price % | marketplace %',
      r.estimated_price, r.sold_price, r.marketplace;
    RAISE NOTICE '  source % | mode % | confidence %',
      COALESCE(r.price_source, '-'), COALESCE(r.price_calc_mode, '-'), COALESCE(r.price_confidence, '-');
    RAISE NOTICE '  needs_enrich % | attempts % | status % | updated %',
      r.needs_price_enrich, r.price_attempt_count, COALESCE(r.order_status, '-'), r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the snapshot, now (should read USD/USD) ==';
  FOR r IN
    SELECT snapshot_item_price, snapshot_source,
           COALESCE(currency, '(null)') AS cur, COALESCE(currency_code, '(null)') AS code
    FROM public.order_price_snapshots
    WHERE user_id = v_uid AND order_id = '702-5492481-4068251'
  LOOP
    RAISE NOTICE '  price % | source % | currency % | currency_code %',
      r.snapshot_item_price, r.snapshot_source, r.cur, r.code;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== has fetch-live-orders run since the deploy? newest touched orders ==';
  FOR r IN
    SELECT order_id, COALESCE(marketplace,'?') AS mk, estimated_price, sold_price, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid
    ORDER BY updated_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  % | % | est % | sold % | %',
      r.order_id, r.mk, COALESCE(r.estimated_price::text,'-'),
      COALESCE(r.sold_price::text,'-'), r.updated_at;
  END LOOP;
END
$p$;
