-- READ-ONLY. Rule 2 scored 216.4 pct overall but 16.1 pct on CA and 704.1 pct
-- on MX. A per-marketplace spread that large is the signature of a currency
-- fault, not of a bad rule. Check fx_rate in asin_price_history before
-- quoting 216 pct as "Rule 2's error".
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== fx_rate stored in asin_price_history, by marketplace ==';
  RAISE NOTICE '   expected native-per-USD: CA ~1.4, MX ~18.4, BR ~5.0, US 1';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mk, count(*) AS rows,
           count(*) FILTER (WHERE COALESCE(fx_rate,0) = 0) AS fx_zero_or_null,
           count(*) FILTER (WHERE fx_rate = 1) AS fx_exactly_one,
           round(min(fx_rate)::numeric,4) AS fx_min,
           round(max(fx_rate)::numeric,4) AS fx_max,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY fx_rate))::numeric,4) AS fx_median,
           COALESCE(string_agg(DISTINCT currency_code, ',' ORDER BY currency_code), '-') AS ccys
    FROM public.asin_price_history WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | fx null/0 % | fx=1 % | min % max % median % | ccy %',
      rpad(r.mk,4), lpad(r.rows::text,6), lpad(r.fx_zero_or_null::text,5),
      lpad(r.fx_exactly_one::text,5), r.fx_min, r.fx_max, r.fx_median, r.ccys;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does listing_price look native or USD, per marketplace? ==';
  RAISE NOTICE '   compare median listing_price against median sold_price (USD)';
  FOR r IN
    SELECT h.marketplace AS mk,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY h.listing_price))::numeric,2) AS med_listing,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY h.price_usd))::numeric,2) AS med_price_usd
    FROM public.asin_price_history h
    WHERE h.user_id = v_uid AND COALESCE(h.listing_price,0) > 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | median listing_price % | median price_usd %',
      rpad(r.mk,4), lpad(r.med_listing::text,9), lpad(COALESCE(r.med_price_usd::text,'-'),9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== RULE 2 rescored using price_usd DIRECTLY where it is present ==';
  RAISE NOTICE '   (price_usd is the history table''s own USD column, so it';
  RAISE NOTICE '    sidesteps whatever is wrong with fx_rate)';
  FOR r IN
    WITH settled AS (
      SELECT so.asin, so.marketplace, so.sold_price,
             COALESCE(so.purchase_timestamp_utc, so.order_date::timestamptz) AS bought
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), scored AS (
      SELECT s.*,
        (SELECT h.price_usd FROM public.asin_price_history h
         WHERE h.user_id = v_uid AND h.asin = s.asin AND h.marketplace = s.marketplace
           AND COALESCE(h.price_usd,0) > 0 AND h.captured_at <= s.bought
         ORDER BY h.captured_at DESC LIMIT 1) AS r2_usd
      FROM settled s
    )
    SELECT marketplace AS mk, count(*) FILTER (WHERE r2_usd > 0) AS covered,
           round((100*avg(abs(r2_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r2_usd > 0))::numeric,1) AS abs_err,
           round((100*avg((r2_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r2_usd > 0))::numeric,1) AS bias
    FROM scored GROUP BY 1
    UNION ALL
    SELECT 'ALL', count(*) FILTER (WHERE r2_usd > 0),
           round((100*avg(abs(r2_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r2_usd > 0))::numeric,1),
           round((100*avg((r2_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r2_usd > 0))::numeric,1)
    FROM scored ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % covered | abs err % pct | bias % pct',
      rpad(r.mk,4), lpad(r.covered::text,4),
      lpad(COALESCE(r.abs_err::text,'-'),6), COALESCE(r.bias::text,'-');
  END LOOP;
END
$p$;
