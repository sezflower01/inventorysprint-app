-- READ-ONLY. Does .eq('is_cancelled', false) miss rows that COALESCE catches?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '== non-US pending rows by is_cancelled state ==';
  FOR r IN
    SELECT COALESCE(is_cancelled::text,'NULL') AS state, marketplace AS mk, count(*) AS rows
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1,2 ORDER BY 2,1
  LOOP
    RAISE NOTICE '   is_cancelled=% | % | % rows', rpad(r.state,5), rpad(r.mk,3), r.rows;
  END LOOP;
END
$p$;
