-- READ-ONLY. "Once it settles, will the system get the real price and fees?"
--
-- Worth measuring rather than asserting. The honest test is what happened to
-- orders that were ALREADY in this position: placed on CA, estimated while
-- pending, and since settled. If they now carry a confirmed price and
-- financial-events fees, the answer is yes and the lag is knowable.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== CA orders by age: how many have a confirmed price yet? ==';
  FOR r IN
    SELECT CASE
             WHEN order_date > current_date - 3   THEN '1. under 3 days'
             WHEN order_date > current_date - 7   THEN '2. 3-7 days'
             WHEN order_date > current_date - 14  THEN '3. 1-2 weeks'
             WHEN order_date > current_date - 30  THEN '4. 2-4 weeks'
             WHEN order_date > current_date - 90  THEN '5. 1-3 months'
             ELSE                                      '6. over 3 months'
           END AS age,
           count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(sold_price,0) > 0) AS have_real_price,
           round(100.0 * count(*) FILTER (WHERE COALESCE(sold_price,0) > 0)
                 / NULLIF(count(*),0), 1) AS pct_priced
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | % with a real price | % pct',
      rpad(r.age, 18), lpad(r.orders::text, 5), lpad(r.have_real_price::text, 5), r.pct_priced;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and where do their FEES end up coming from? ==';
  FOR r IN
    SELECT COALESCE(fees_source,'(null)') AS src, count(*) AS orders,
           round(avg(total_fees)::numeric,2) AS avg_fees
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND COALESCE(sold_price,0) > 0
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | avg fees $%', rpad(r.src, 22), lpad(r.orders::text,5), r.avg_fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how long does it take? days from purchase to the row being finalised ==';
  FOR r IN
    SELECT count(*) AS orders,
           round(avg(EXTRACT(epoch FROM (updated_at - purchase_timestamp_utc))/86400)::numeric,1) AS avg_days,
           round((percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(epoch FROM (updated_at - purchase_timestamp_utc))/86400))::numeric,1) AS median_days,
           round((percentile_cont(0.9) WITHIN GROUP (
                 ORDER BY EXTRACT(epoch FROM (updated_at - purchase_timestamp_utc))/86400))::numeric,1) AS p90_days
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(sold_price,0) > 0 AND purchase_timestamp_utc IS NOT NULL
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND order_date > current_date - 180
  LOOP
    RAISE NOTICE '  % settled CA orders | avg % days | median % days | 90th pct % days',
      r.orders, r.avg_days, r.median_days, r.p90_days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the real price actually REPLACE the estimate, or sit beside it? ==';
  FOR r IN
    SELECT count(*) AS settled_with_both,
           round(avg(estimated_price)::numeric,2) AS avg_estimate_kept,
           round(avg(sold_price)::numeric,2) AS avg_real_usd,
           round((100*avg((estimated_price/NULLIF(fx.rate,1) - sold_price)
                 / NULLIF(sold_price,0)))::numeric,1) AS est_error_pct
    FROM public.sales_orders so
    CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'')) = 'CA'
      AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.estimated_price,0) > 0
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date > current_date - 180
  LOOP
    RAISE NOTICE '  % settled CA orders still carry their old estimate alongside the real price',
      r.settled_with_both;
    RAISE NOTICE '  estimate avg CA$% | real avg US$% | the estimate was % pct out',
      r.avg_estimate_kept, r.avg_real_usd, r.est_error_pct;
    RAISE NOTICE '  (the estimate is KEPT for the record; every read prefers sold_price)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the workers that would do it, and whether they are scheduled ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active,
           substring(command from 'functions/v1/([a-z0-9-]+)') AS fn
    FROM cron.job
    WHERE command ~* '(pending-price|reconcile-pending|self-heal-pending|enrich-pending|sync-sales-orders|financial)'
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  job % | % | % | active % | %',
      r.jobid, rpad(COALESCE(r.jobname,''), 34), rpad(r.schedule, 14), r.active, COALESCE(r.fn,'');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NONE scheduled'; END IF;
END
$p$;
