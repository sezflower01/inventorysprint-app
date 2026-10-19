-- READ-ONLY baseline for condition 3, captured immediately after the item-4
-- deploy so "new orders" can be measured against a known line.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '== BASELINE at % ==', date_trunc('second', now());
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders,
           max(created_at) AS newest
    FROM public.sales_orders WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders | newest created %', rpad(r.fc,8), lpad(r.orders::text,6), r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== rows created in the last hour (pre-deploy behaviour) ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders
    FROM public.sales_orders
    WHERE user_id = v_uid AND created_at > now() - interval '1 hour'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders', rpad(r.fc,8), r.orders;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none created in the last hour)'; END IF;
END
$p$;
