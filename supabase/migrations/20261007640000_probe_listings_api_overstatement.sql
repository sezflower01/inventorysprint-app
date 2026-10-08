-- READ-ONLY PROBE. listings_api estimates run +55.6% over settled price across
-- 1,445 orders -- by far the largest estimator error, and the only one big
-- enough to move the headline.
--
-- NO Amazon calls anywhere in this file: cron 194 is draining the stuck-pending
-- cohort and they would compete for the same getOrder/Listings quota.
--
-- THE MECHANISM IS DOCUMENTED IN THE CODE ITSELF. fetch-live-orders Tier C:
--
--   "Live SP-API Listings price -- only when no repricer action exists <=
--    purchaseDate AND no snapshot exists. Returns 'price now', which may
--    differ from price at purchase for oscillating ASINs."
--
-- So the estimate is our list price at SYNC time, not at purchase. Every
-- question below is really one question: does the error behave like a
-- timing/price-drift artefact, or like something else?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 0. the cohort, and is +55.6 pct the mean or the median? ==';
  FOR r IN
    SELECT count(*) AS orders,
           round(avg(estimated_price)::numeric,2) AS avg_est,
           round(avg(sold_price)::numeric,2) AS avg_sold,
           round((100*avg((estimated_price - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS mean_err_pct,
           round((100*percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY (estimated_price - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS median_err_pct,
           round((100*percentile_cont(0.9) WITHIN GROUP (
                 ORDER BY (estimated_price - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS p90_err_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND price_calc_mode = 'listings_api'
      AND COALESCE(estimated_price,0) > 0 AND COALESCE(sold_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '  % orders | est $% vs sold $% | mean % pct | MEDIAN % pct | p90 % pct',
      r.orders, r.avg_est, r.avg_sold, r.mean_err_pct, r.median_err_pct, r.p90_err_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1a. by marketplace ==';
  FOR r IN
    SELECT COALESCE(marketplace,'?') AS mk, count(*) AS orders,
           round(avg(estimated_price)::numeric,2) AS est, round(avg(sold_price)::numeric,2) AS sold,
           round((100*avg((estimated_price-sold_price)/NULLIF(sold_price,0)))::numeric,1) AS err_pct,
           round(sum(estimated_price - sold_price)::numeric,2) AS total_over
    FROM public.sales_orders
    WHERE user_id = v_uid AND price_calc_mode = 'listings_api'
      AND COALESCE(estimated_price,0)>0 AND COALESCE(sold_price,0)>0
      AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | est $% vs sold $% | % pct | overstated $% in total',
      rpad(r.mk,4), lpad(r.orders::text,5), lpad(r.est::text,8), lpad(r.sold::text,8),
      lpad(r.err_pct::text,8), r.total_over;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1b. by settled price band ==';
  FOR r IN
    SELECT CASE WHEN sold_price < 10 THEN '1. under $10'
                WHEN sold_price < 20 THEN '2. $10-19.99'
                WHEN sold_price < 40 THEN '3. $20-39.99'
                WHEN sold_price < 80 THEN '4. $40-79.99'
                ELSE '5. $80+' END AS band,
           count(*) AS orders,
           round(avg(estimated_price)::numeric,2) AS est, round(avg(sold_price)::numeric,2) AS sold,
           round((100*avg((estimated_price-sold_price)/NULLIF(sold_price,0)))::numeric,1) AS err_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND price_calc_mode = 'listings_api'
      AND COALESCE(estimated_price,0)>0 AND COALESCE(sold_price,0)>0
      AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | est $% vs sold $% | % pct',
      rpad(r.band,14), lpad(r.orders::text,5), lpad(r.est::text,8), lpad(r.sold::text,8), r.err_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1c. by quarter of purchase ==';
  FOR r IN
    SELECT to_char(date_trunc('quarter', order_date),'YYYY-"Q"Q') AS q, count(*) AS orders,
           round((100*avg((estimated_price-sold_price)/NULLIF(sold_price,0)))::numeric,1) AS err_pct,
           round(sum(estimated_price - sold_price)::numeric,2) AS total_over
    FROM public.sales_orders
    WHERE user_id = v_uid AND price_calc_mode = 'listings_api'
      AND COALESCE(estimated_price,0)>0 AND COALESCE(sold_price,0)>0
      AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | % pct | $% overstated', r.q, lpad(r.orders::text,5),
      lpad(r.err_pct::text,8), r.total_over;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1d. CONCENTRATION: do a few ASINs carry it? ==';
  FOR r IN
    WITH e AS (
      SELECT asin, count(*) AS orders,
             sum(estimated_price - sold_price) AS over_total,
             round(avg(estimated_price)::numeric,2) AS est,
             round(avg(sold_price)::numeric,2) AS sold
      FROM public.sales_orders
      WHERE user_id = v_uid AND price_calc_mode = 'listings_api'
        AND COALESCE(estimated_price,0)>0 AND COALESCE(sold_price,0)>0
        AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
      GROUP BY 1
    )
    SELECT asin, orders, est, sold, round(over_total::numeric,2) AS over_total,
           round((100 * over_total / NULLIF((SELECT sum(over_total) FROM e), 0))::numeric, 1) AS pct_of_total
    FROM e ORDER BY over_total DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % | % orders | est $% vs sold $% | $% over | % pct of all overstatement',
      r.asin, lpad(r.orders::text,4), lpad(r.est::text,8), lpad(r.sold::text,8),
      lpad(r.over_total::text,9), r.pct_of_total;
  END LOOP;
END
$p$;
