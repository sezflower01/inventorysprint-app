DO $p$
DECLARE v_uid uuid; v jsonb; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 51643;
  IF v IS NULL THEN RAISE NOTICE '(batch 1 reply not back yet)';
  ELSIF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error';
  ELSE RAISE NOTICE 'batch 1 tally: %', v->'tally';
  END IF;

  SELECT count(*) INTO n FROM public.stuck_pending_resolution_log;
  RAISE NOTICE 'log rows: %', n;
  SELECT count(*) INTO n FROM public.backup_resolve_stuck_pending_20261007;
  RAISE NOTICE 'backup rows: %', n;

  FOR r IN SELECT new_status, new_is_cancelled, price_recovered, count(*) AS rows,
                  round(sum(estimated_price)::numeric,2) AS est
           FROM public.stuck_pending_resolution_log
           GROUP BY 1,2,3 ORDER BY rows DESC LOOP
    RAISE NOTICE '  % | cancelled % | price recovered % | % rows | $% of estimate',
      rpad(r.new_status,10), r.new_is_cancelled, r.price_recovered, r.rows, r.est;
  END LOOP;

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0
        AND COALESCE(so.estimated_price,0)>0 AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false)::numeric,2) AS a FROM base
  LOOP
    RAISE NOTICE 'AFTER batch 1: Live Sales estimated revenue $% (was $28900.87)', r.a;
  END LOOP;

  FOR r IN SELECT count(*) AS rows, round(sum(sales)::numeric,2) AS sales
           FROM public.financial_events_cache WHERE user_id = v_uid LOOP
    RAISE NOTICE 'P&L: % rows | sales $% (baseline 120429 | $2463045.47)', r.rows, r.sales;
  END LOOP;
END
$p$;
