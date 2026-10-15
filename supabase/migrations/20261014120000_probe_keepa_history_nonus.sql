-- READ-ONLY. keepa_price_cache holds US only (1,011 rows, 272 ASINs, zero
-- CA/MX/BR). The non-US Keepa data we DO hold is in
-- keepa_price_history_cache: CA 125 rows / 117 ASINs, MX 103 / 99, BR 90 / 88.
-- Can a usable price be read out of it, and does it reach enough orders?
DO $p$
DECLARE v_uid uuid; r record; v_series jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== what does a non-US series actually look like? ==';
  FOR r IN
    SELECT asin, marketplace, days_range,
           jsonb_typeof(series) AS series_type,
           left(series::text, 300) AS sample,
           fetched_at
    FROM public.keepa_price_history_cache
    WHERE marketplace <> 'US' ORDER BY fetched_at DESC LIMIT 2
  LOOP
    RAISE NOTICE '  % / % | range % | series is % | fetched %',
      r.asin, r.marketplace, r.days_range, r.series_type, r.fetched_at;
    RAISE NOTICE '    %', r.sample;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== COVERAGE: how many settled CA orders have ANY Keepa history? ==';
  FOR r IN
    SELECT count(*) AS orders,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.keepa_price_history_cache k
             WHERE k.asin = so.asin AND k.marketplace = 'CA')) AS with_keepa
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,''))='CA'
      AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false)=false
      AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
  LOOP
    RAISE NOTICE '  % settled CA orders | % have a Keepa history row (% pct)',
      r.orders, r.with_keepa, round(100.0*r.with_keepa/NULLIF(r.orders,0), 1);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== same question for the orders that NEED an estimate (unsettled) ==';
  FOR r IN
    SELECT COALESCE(so.marketplace,'?') AS mk, count(*) AS pending,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.keepa_price_history_cache k
             WHERE k.asin = so.asin AND k.marketplace = so.marketplace)) AS with_keepa
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'')) IN ('CA','MX','BR')
      AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.estimated_price,0) > 0
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY pending DESC
  LOOP
    RAISE NOTICE '  % | % unsettled | % have Keepa history', rpad(r.mk,4), r.pending, r.with_keepa;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is the history even FRESH enough? newest fetch per marketplace ==';
  FOR r IN
    SELECT marketplace AS mk, max(fetched_at) AS newest,
           count(*) FILTER (WHERE expires_at > now()) AS unexpired,
           count(*) AS total
    FROM public.keepa_price_history_cache WHERE marketplace <> 'US'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | newest % | % of % rows unexpired', rpad(r.mk,4), r.newest, r.unexpired, r.total;
  END LOOP;
END
$p$;
