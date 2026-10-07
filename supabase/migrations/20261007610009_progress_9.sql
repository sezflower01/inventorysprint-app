DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT count(*) INTO n FROM public.stuck_pending_resolution_log;
  RAISE NOTICE 'resolution log rows: %', n;
  FOR r IN SELECT new_status, price_recovered, count(*) AS rows,
                  round(sum(estimated_price)::numeric,2) AS est
           FROM public.stuck_pending_resolution_log GROUP BY 1,2 ORDER BY rows DESC LOOP
    RAISE NOTICE '  % | price recovered % | % rows | $%',
      rpad(r.new_status,10), r.price_recovered, lpad(r.rows::text,4), r.est;
  END LOOP;

  FOR r IN SELECT count(*) AS orders, round(sum(estimated_price*quantity)::numeric,2) AS est
           FROM public.sales_orders
           WHERE user_id = v_uid AND COALESCE(sold_price,0)=0 AND COALESCE(estimated_price,0)>0
             AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
             AND order_date <= current_date - 90 LOOP
    RAISE NOTICE 'cohort remaining: % orders | $% (started 272 / $7315.38)', r.orders, r.est;
  END LOOP;

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0
        AND COALESCE(so.estimated_price,0)>0 AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false)::numeric,2) AS a FROM base
  LOOP
    RAISE NOTICE 'Live Sales estimated revenue: $% (was $28900.87 before batch 1)', r.a;
  END LOOP;

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE user_id = v_uid AND price_confidence = 'ESTIMATE_UNRECOVERABLE';
  RAISE NOTICE 'rows labelled ESTIMATE_UNRECOVERABLE: %', n;

  FOR r IN SELECT count(*) AS rows, round(sum(sales)::numeric,2) AS sales
           FROM public.financial_events_cache WHERE user_id = v_uid LOOP
    RAISE NOTICE 'P&L: % rows | sales $% (baseline 120429 | $2463045.47)', r.rows, r.sales;
  END LOOP;
END
$p$;
