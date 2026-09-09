-- Read the retry result and the restored row.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== refresh_pending retry response ========';
  FOR r IN
    SELECT status_code, left(content::text, 400) AS body FROM net._http_response WHERE id = 58143
  LOOP
    RAISE NOTICE '   % | %', r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 111-8310672-6833058 ========';
  FOR r IN
    SELECT quantity, sold_price, total_sale_amount, referral_fee, fba_fee,
           total_fees, unit_cost, total_cost, roi, order_status,
           price_source, fees_source, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '111-8310672-6833058'
  LOOP
    RAISE NOTICE '   quantity=%   (was 1, Amazon says 3)', r.quantity;
    RAISE NOTICE '   sold_price=%  total_sale=%   (was 7.89, Amazon says 23.67)',
      r.sold_price, r.total_sale_amount;
    RAISE NOTICE '   referral=%  fba=%  total_fees=%', r.referral_fee, r.fba_fee, r.total_fees;
    RAISE NOTICE '   unit_cost=%  total_cost=%  roi=%', r.unit_cost, r.total_cost, r.roi;
    RAISE NOTICE '   fee rate against own revenue: %',
      CASE WHEN COALESCE(r.total_sale_amount,0) > 0
        THEN round(r.total_fees / r.total_sale_amount * 100, 1)::text || '%' ELSE 'n/a' END;
    RAISE NOTICE '   status=%  price_source=%  updated=%',
      r.order_status, r.price_source, r.updated_at;
    IF r.quantity = 3 THEN
      RAISE NOTICE '   -> FIXED';
    ELSE
      RAISE NOTICE '   -> not yet 3';
    END IF;
  END LOOP;
END
$probe$;
