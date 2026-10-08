-- READ-ONLY PROBE, and a check on my own arithmetic.
--
-- The listings_api breakdown overturns the framing:
--
--   median error 0.0 pct, mean 49.7 pct
--   US  1,307 orders  -0.2 pct   ($137.86 UNDER in total)
--   CA    209 orders  +6.5 pct   ($357.73)
--   MX     76 orders  +967.9 pct ($20,486.49)
--   BR     27 orders  +214.3 pct ($1,773.16)
--
-- MX alone is 91 pct of the whole overstatement. listings_api is not 55 pct
-- high; it is accurate on US and broken on non-US -- which is the signature of
-- a currency problem, not a pricing one.
--
-- BUT THE RATIOS DO NOT FIT A SIMPLE MISLABEL EITHER. MX estimated 297.97
-- against 28.41 settled is a ratio of 10.5, and USD->MXN is 17.9. BR is 3.1
-- against a rate of 4.97. Both are BELOW their exchange rate, which is what
-- you would see if estimated_price is NATIVE (as its contract says) while
-- sold_price is USD -- in which case I have been comparing pesos to dollars
-- and the "+967.9 pct" is partly my own error, not the app's.
--
-- That also puts the +1630 pct MX figure I reported earlier in doubt. Settle
-- it: what currency is sold_price actually in for a non-US order? Financial
-- events are the independent witness.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== sold_price against the financial event for the SAME order ==';
  RAISE NOTICE '   if sold_price is native, the ratio to fe.sales is the FX rate;';
  RAISE NOTICE '   if both are USD, the ratio is 1.';
  FOR r IN
    SELECT COALESCE(so.marketplace,'?') AS mk, count(*) AS orders,
           round(avg(so.sold_price)::numeric,2) AS avg_sold,
           round(avg(f.sales)::numeric,2) AS avg_fe_sales,
           round(avg(f.sales / NULLIF(so.sold_price * GREATEST(so.quantity,1),0))::numeric,3) AS fe_over_sold,
           round(max(fx.rate)::numeric,3) AS usd_to_native
    FROM public.sales_orders so
    JOIN public.financial_events_cache f
      ON f.user_id = so.user_id AND f.amazon_order_id = so.order_id AND f.sales > 0
    LEFT JOIN public.fx_rates fx ON fx.base='USD'
      AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
            WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' ELSE 'USD' END
    WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0) > 0
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | sold_price % | fe.sales % | ratio % | USD->native %',
      rpad(r.mk,4), lpad(r.orders::text,6), lpad(r.avg_sold::text,9),
      lpad(r.avg_fe_sales::text,9), lpad(r.fe_over_sold::text,7), r.usd_to_native;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the MX listings_api orders, one by one ==';
  FOR r IN
    SELECT so.order_id, so.asin, so.quantity, so.estimated_price, so.sold_price,
           round((so.estimated_price / NULLIF(so.sold_price,0))::numeric,2) AS ratio,
           so.order_date, COALESCE(so.price_source,'?') AS psrc
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.price_calc_mode = 'listings_api'
      AND upper(COALESCE(so.marketplace,'')) = 'MX'
      AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY (so.estimated_price - so.sold_price) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % | q% | est % | sold % | ratio % | % | %',
      r.order_id, r.asin, r.quantity, lpad(r.estimated_price::text,9),
      lpad(r.sold_price::text,8), lpad(r.ratio::text,7), r.order_date, r.psrc;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the 10 worst overall, with every input that produced them ==';
  FOR r IN
    SELECT so.order_id, COALESCE(so.marketplace,'?') AS mk, so.asin, so.sku,
           so.estimated_price AS est, so.sold_price AS sold,
           COALESCE(amc.my_price::text,'-') AS cache_price,
           COALESCE(amc.currency,'-') AS cache_cur,
           COALESCE(inv.price::text,'-') AS inv_price,
           so.order_date
    FROM public.sales_orders so
    LEFT JOIN public.asin_my_price_cache amc
      ON amc.user_id = so.user_id AND amc.asin = so.asin
     AND amc.marketplace_id = CASE upper(COALESCE(so.marketplace,'US'))
           WHEN 'CA' THEN 'A2EUQ1WTGCTBG2' WHEN 'MX' THEN 'A1AM78C64UM0Y8'
           WHEN 'BR' THEN 'A2Q3Y263D00KWC' ELSE 'ATVPDKIKX0DER' END
    LEFT JOIN public.inventory inv ON inv.user_id = so.user_id AND inv.sku = so.sku
    WHERE so.user_id = v_uid AND so.price_calc_mode = 'listings_api'
      AND COALESCE(so.estimated_price,0)>0 AND COALESCE(so.sold_price,0)>0
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY (so.estimated_price - so.sold_price) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % % % | est % sold % | my_price_cache % % | inventory.price % | %',
      rpad(r.mk,3), r.order_id, r.asin, lpad(r.est::text,8), lpad(r.sold::text,7),
      lpad(r.cache_price,9), rpad(r.cache_cur,4), lpad(r.inv_price,8), r.order_date;
  END LOOP;
END
$p$;
