-- READ-ONLY. Candidate D: the KEEPA price as the CA/MX/BR estimate.
-- This is the test I was asked for and skipped.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== Keepa price coverage by marketplace ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS rows, count(DISTINCT asin) AS asins,
           count(*) FILTER (WHERE price_usd > 0) AS with_price,
           round(min(price_usd)::numeric,2) AS min_p, round(max(price_usd)::numeric,2) AS max_p,
           min(bucket_ts) AS oldest, max(bucket_ts) AS newest,
           count(DISTINCT source) AS sources
    FROM public.keepa_price_cache GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  % | % rows | % ASINs | % priced | $%-$% | % .. % | % sources',
      rpad(COALESCE(r.mk,'?'),4), lpad(r.rows::text,6), lpad(r.asins::text,5),
      lpad(r.with_price::text,5), r.min_p, r.max_p, r.oldest, r.newest, r.sources;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== price history coverage (the series that could anchor to purchase time) ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS rows, count(DISTINCT asin) AS asins,
           min(fetched_at) AS oldest, max(fetched_at) AS newest
    FROM public.keepa_price_history_cache GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  % | % rows | % ASINs | % .. %',
      rpad(COALESCE(r.mk,'?'),4), lpad(r.rows::text,6), lpad(r.asins::text,5), r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== D REPLAY: Keepa price vs what settled CA orders actually sold for ==';
  FOR r IN
    WITH ca AS (
      SELECT so.order_id, so.asin, so.sold_price, so.order_date,
             so.estimated_price / NULLIF(fx.rate,1) AS est_a_usd
      FROM public.sales_orders so
      CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,''))='CA'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false)=false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), withD AS (
      SELECT c.*,
             (SELECT k.price_usd FROM public.keepa_price_cache k
              WHERE k.asin = c.asin AND k.marketplace = 'CA' AND k.price_usd > 0
              ORDER BY abs(EXTRACT(epoch FROM (k.bucket_ts - c.order_date::timestamptz)))
              LIMIT 1) AS est_d_usd
      FROM ca c
    )
    SELECT count(*) AS orders,
           count(*) FILTER (WHERE est_d_usd > 0) AS have_d,
           round((100 * avg(abs(est_d_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE est_d_usd > 0))::numeric,1) AS d_abs_err_pct,
           round((100 * avg((est_d_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE est_d_usd > 0))::numeric,1) AS d_bias_pct
    FROM withD
  LOOP
    RAISE NOTICE '  % settled CA orders | Keepa covered % of them', r.orders, r.have_d;
    IF r.have_d > 0 THEN
      RAISE NOTICE '  D  mean ABSOLUTE error % pct | bias % pct', r.d_abs_err_pct, r.d_bias_pct;
    ELSE
      RAISE NOTICE '  D  no coverage at all -- cannot be scored';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and for the US, where Keepa is supposed to be strong ==';
  FOR r IN
    SELECT count(*) AS cached_us FROM public.keepa_price_cache
    WHERE marketplace = 'US' AND price_usd > 0
  LOOP
    RAISE NOTICE '  % US rows with a price in keepa_price_cache', r.cached_us;
  END LOOP;
END
$p$;
