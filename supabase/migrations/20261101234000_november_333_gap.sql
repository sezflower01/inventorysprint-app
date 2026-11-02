-- THE 333.73 BETWEEN MY 3,471.10 AND THE SCREEN'S 3,137.37. READ ONLY.
--
-- The seller reads 3,137.37 on the Sales Report. My raw
-- sum(quantity * estimated_price) gave 3,471.10. The difference is 333.73 and
-- is worth closing rather than rounding away, because the two candidate causes
-- mean opposite things:
--
--   * CANCELLED orders excluded by the screen but not by my sum -- benign, the
--     screen is simply right and I was sloppy.
--   * FX -- estimated_price is NATIVE for non-US marketplaces, so a raw
--     multiplication adds MXN/CAD/BRL to USD. If the screen converts and I did
--     not, my figure is the wrong one. If NEITHER converts, that is the known
--     non-US overstatement showing up in this month too.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_all numeric; v_notcancelled numeric; v_us numeric; v_nonus numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT round(sum(COALESCE(quantity,0)*COALESCE(estimated_price,0))::numeric,2)
    INTO v_all
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01';

  SELECT round(sum(COALESCE(quantity,0)*COALESCE(estimated_price,0))::numeric,2)
    INTO v_notcancelled
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01'
    AND COALESCE(is_cancelled,false) = false
    AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled');

  RAISE NOTICE '######## CLOSING THE 333.73 ########';
  RAISE NOTICE '   all November rows                 : %', COALESCE(v_all,0);
  RAISE NOTICE '   excluding cancelled               : %', COALESCE(v_notcancelled,0);
  RAISE NOTICE '   the screen shows                  : 3137.37';
  RAISE NOTICE '   cancelled orders account for      : %',
    round(COALESCE(v_all,0) - COALESCE(v_notcancelled,0),2);

  RAISE NOTICE '';
  RAISE NOTICE '   by marketplace, to test the FX explanation:';
  RAISE NOTICE '   marketplace | rows |  qty x estimated_price (as stored)';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mp, count(*) AS n,
           round(sum(COALESCE(quantity,0)*COALESCE(estimated_price,0))::numeric,2) AS amt
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= '2026-11-01' AND order_date < '2026-12-01'
      AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 ORDER BY 3 DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % | % | %', rpad(r.mp,11), lpad(r.n::text,4), lpad(r.amt::text,10);
  END LOOP;

  SELECT round(sum(COALESCE(quantity,0)*COALESCE(estimated_price,0))::numeric,2)
    INTO v_nonus
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01'
    AND COALESCE(is_cancelled,false) = false
    AND upper(COALESCE(marketplace,'US')) NOT IN ('US','UNKNOWN');
  RAISE NOTICE '';
  RAISE NOTICE '   non-US portion (native currency, unconverted): %',
    COALESCE(v_nonus,0);
  IF COALESCE(v_nonus,0) = 0 THEN
    RAISE NOTICE '   >>> NO non-US rows in November, so FX cannot explain the';
    RAISE NOTICE '   >>> difference. It is cancellations or a date/filter detail.';
  ELSE
    RAISE NOTICE '   >>> non-US rows exist, so the screen converting while my';
    RAISE NOTICE '   >>> raw sum did not would explain part of the gap.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
