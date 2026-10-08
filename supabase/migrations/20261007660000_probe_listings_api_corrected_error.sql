-- READ-ONLY PROBE. The listings_api error, measured in ONE currency.
--
-- Established by 20261007650000: sold_price is USD on every marketplace --
-- its ratio to the order's financial event is 0.999 (US), 0.987 (CA), 1.016
-- (MX), 0.946 (BR) across 64,268 settled orders. If it were native, MX would
-- read ~17.9. estimated_price, by its documented contract in
-- fetch-live-orders, is NATIVE for non-US.
--
-- So the two columns are in different currencies for CA/MX/BR, and every
-- comparison of them I have reported -- "+55.6 pct listings_api", "+30 pct CA",
-- "+1630 pct MX", "+422 pct BR" -- compared pesos to dollars. The MX detail
-- makes it unmistakable: the ratio est/sold lands on 17.90 over and over, and
-- USD->MXN is 17.945. 700 MXN / 17.9 is $39.11 against a settled $39.10.
-- Those estimates were right to the cent.
--
-- The app itself is not fooled -- getConfirmedSalesOrderRevenueUsd has a
-- source-aware guard, and currencyConversion.ts documents the mixed contract.
-- My SQL had no such guard.
--
-- This re-runs the comparison with estimated_price converted to USD first.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== listings_api error, BOTH SIDES IN USD ==';
  FOR r IN
    WITH e AS (
      SELECT so.marketplace, so.asin, so.order_id, so.sold_price,
             so.estimated_price / COALESCE(fx.rate, 1) AS est_usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND so.price_calc_mode = 'listings_api'
        AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
        AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT COALESCE(marketplace,'?') AS mk, count(*) AS orders,
           round(avg(est_usd)::numeric,2) AS est, round(avg(sold_price)::numeric,2) AS sold,
           round((100*avg((est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS mean_pct,
           round((100*percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY (est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS median_pct,
           round(sum(est_usd - sold_price)::numeric,2) AS total_over
    FROM e GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | est $% vs sold $% | mean % pct | median % pct | $% over',
      rpad(r.mk,4), lpad(r.orders::text,5), lpad(r.est::text,7), lpad(r.sold::text,7),
      lpad(r.mean_pct::text,7), lpad(r.median_pct::text,7), r.total_over;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the same for EVERY estimator, so listings_api has context ==';
  FOR r IN
    WITH e AS (
      SELECT COALESCE(so.price_calc_mode,'(null)') AS mode, so.sold_price,
             so.estimated_price / COALESCE(fx.rate, 1) AS est_usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid
        AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
        AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
        AND so.order_date > current_date - 180
    )
    SELECT mode, count(*) AS orders,
           round((100*avg((est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS mean_pct,
           round((100*percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY (est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS median_pct,
           round(sum(est_usd - sold_price)::numeric,2) AS total_over
    FROM e GROUP BY 1 HAVING count(*) >= 20 ORDER BY abs(sum(est_usd - sold_price)) DESC
  LOOP
    RAISE NOTICE '  % | % orders | mean % pct | median % pct | $% net',
      rpad(r.mode,26), lpad(r.orders::text,6), lpad(r.mean_pct::text,7),
      lpad(r.median_pct::text,7), r.total_over;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what is genuinely left: listings_api orders still >25 pct out in USD ==';
  FOR r IN
    WITH e AS (
      SELECT so.order_id, COALESCE(so.marketplace,'?') AS mk, so.asin, so.sold_price,
             round((so.estimated_price / COALESCE(fx.rate,1))::numeric,2) AS est_usd,
             so.order_date
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND so.price_calc_mode = 'listings_api'
        AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
        AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT count(*) AS orders,
           round(sum(est_usd - sold_price)::numeric,2) AS total_over,
           round(avg((est_usd - sold_price)/NULLIF(sold_price,0) * 100)::numeric,1) AS avg_pct
    FROM e WHERE est_usd > sold_price * 1.25
  LOOP
    RAISE NOTICE '  % orders | $% overstated | averaging % pct out',
      r.orders, r.total_over, r.avg_pct;
  END LOOP;

  FOR r IN
    WITH e AS (
      SELECT so.order_id, COALESCE(so.marketplace,'?') AS mk, so.asin, so.sold_price,
             round((so.estimated_price / COALESCE(fx.rate,1))::numeric,2) AS est_usd, so.order_date
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND so.price_calc_mode = 'listings_api'
        AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
        AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT * FROM e WHERE est_usd > sold_price * 1.25
    ORDER BY (est_usd - sold_price) DESC LIMIT 10
  LOOP
    RAISE NOTICE '    % % % | est $% vs sold $% | %',
      rpad(r.mk,3), r.order_id, r.asin, lpad(r.est_usd::text,7), lpad(r.sold_price::text,7), r.order_date;
  END LOOP;
END
$p$;
