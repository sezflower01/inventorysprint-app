-- READ-ONLY PROBE 3 of 3. fees_api_fbm and the 9.95 pct referral rate.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== orders stamped fees_api_fbm ==';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(avg(sold_price)::numeric,2) AS avg_price,
           round(avg(referral_fee / NULLIF(sold_price*GREATEST(quantity,1),0) * 100)::numeric,2) AS implied_rate_pct,
           round(sum(referral_fee)::numeric,2) AS referral_total,
           min(order_date) AS oldest, max(order_date) AS newest
    FROM public.sales_orders
    WHERE user_id = v_uid AND fees_source = 'fees_api_fbm'
      AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
      AND COALESCE(sold_price,0) > 0
  LOOP
    RAISE NOTICE '  % orders | % units | avg $% | implied referral % pct | $% total | % .. %',
      r.orders, r.units, r.avg_price, r.implied_rate_pct, r.referral_total, r.oldest, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no orders carry fees_source = fees_api_fbm)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what rate do these ASINs get from the fee cache? ==';
  FOR r IN
    SELECT so.asin, so.quantity, so.sold_price,
           round(so.referral_fee::numeric,2) AS billed_referral,
           round((so.referral_fee / NULLIF(so.sold_price*GREATEST(so.quantity,1),0) * 100)::numeric,2) AS implied_pct,
           round((fc.referral_rate*100)::numeric,2) AS cache_pct,
           so.order_date
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = 'US'
    WHERE so.user_id = v_uid AND so.fees_source = 'fees_api_fbm'
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
      AND COALESCE(so.sold_price,0) > 0
    ORDER BY so.order_date DESC LIMIT 15
  LOOP
    RAISE NOTICE '  % | q% | $% | referral $% = % pct | cache says % pct | %',
      r.asin, r.quantity, lpad(r.sold_price::text,8), lpad(r.billed_referral::text,7),
      lpad(r.implied_pct::text,6), lpad(COALESCE(r.cache_pct::text,'-'),6), r.order_date;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what does Amazon ACTUALLY bill on these orders? ==';
  FOR r IN
    SELECT count(*) AS matched,
           round(sum(so.referral_fee)::numeric,2) AS we_recorded,
           round(sum(abs(fe.referral))::numeric,2) AS amazon_billed,
           round((100*sum(abs(fe.referral))/NULLIF(sum(so.sold_price*GREATEST(so.quantity,1)),0))::numeric,2) AS real_rate_pct
    FROM public.sales_orders so
    JOIN (SELECT amazon_order_id, sum(referral_fees) AS referral
          FROM public.financial_events_cache WHERE user_id = v_uid GROUP BY 1) fe
      ON fe.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid AND so.fees_source = 'fees_api_fbm'
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '  % matched to a financial event', r.matched;
    RAISE NOTICE '  we recorded $% | Amazon billed $% | real rate % pct',
      r.we_recorded, r.amazon_billed, r.real_rate_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== referral rates in the fee cache overall, for context ==';
  FOR r IN
    SELECT round((referral_rate*100)::numeric,2) AS pct, count(*) AS asins
    FROM public.asin_fee_cache WHERE user_id = v_uid AND marketplace='US' AND referral_rate > 0
    GROUP BY 1 ORDER BY asins DESC LIMIT 8
  LOOP
    RAISE NOTICE '  % pct | % ASINs', lpad(r.pct::text,6), r.asins;
  END LOOP;
END
$p$;
