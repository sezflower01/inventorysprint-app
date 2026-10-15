-- READ-ONLY. The estimate for 701-1848920-5681843 read 49.56 at 00:30 UTC and
-- 55.64 about half an hour later. Is the automatic path actively rewriting it?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '== is the pending estimate stable, or drifting? ==';
  FOR r IN
    SELECT order_id, asin, quantity, estimated_price, locked_est_price,
           COALESCE(locked_from,'(none)') AS lf, COALESCE(price_source,'-') AS src,
           updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843'
  LOOP
    RAISE NOTICE '   % % q%', r.order_id, r.asin, r.quantity;
    RAISE NOTICE '   estimated_price CA$%  locked_est_price %  locked_from %',
      r.estimated_price, COALESCE(r.locked_est_price::text,'NULL'), r.lf;
    RAISE NOTICE '   price_source %  | row last updated %', r.src, r.updated_at;
    RAISE NOTICE '   Amazon actual was CA$39.08/unit -> this estimate is % pct high',
      round((100*(r.estimated_price-39.08)/39.08)::numeric,1);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== our CURRENT CA list price for that ASIN (what listings_api feeds) ==';
  FOR r IN
    SELECT COALESCE(marketplace_id,'-') AS mp, my_price, COALESCE(currency,'-') AS cur,
           COALESCE(source,'-') AS src, fetched_at
    FROM public.asin_my_price_cache
    WHERE user_id = v_uid AND asin = 'B00DLD1C0A'
    ORDER BY fetched_at DESC LIMIT 4
  LOOP
    RAISE NOTICE '   % | my_price % % | % | %', rpad(r.mp,16), r.my_price, r.cur, rpad(r.src,14), r.fetched_at;
  END LOOP;
END
$p$;
