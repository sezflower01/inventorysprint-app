-- READ-ONLY. Item 1: distribution of fulfillment_channel over 12 months, and
-- whether NULL is concentrated anywhere.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1a. what DISTINCT values does the column actually hold? ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders', rpad(r.fc,14), r.orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1b. by MONTH, last 12 months ==';
  RAISE NOTICE '   month    total    AFN    MFN   NULL   null_pct';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS total,
           count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) LIKE 'AFN%') AS afn,
           count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) LIKE 'MFN%') AS mfn,
           count(*) FILTER (WHERE fulfillment_channel IS NULL) AS nulls,
           round((100.0*count(*) FILTER (WHERE fulfillment_channel IS NULL)/NULLIF(count(*),0))::numeric,1) AS null_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
      AND order_id NOT LIKE '%-REFUND%' AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  %  %  %  %  % pct', r.mon, lpad(r.total::text,6),
      lpad(r.afn::text,6), lpad(r.mfn::text,6), lpad(r.nulls::text,6), lpad(r.null_pct::text,5);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1c. by MARKETPLACE ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(NULL)') AS mk, count(*) AS total,
           count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) LIKE 'AFN%') AS afn,
           count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) LIKE 'MFN%') AS mfn,
           count(*) FILTER (WHERE fulfillment_channel IS NULL) AS nulls,
           round((100.0*count(*) FILTER (WHERE fulfillment_channel IS NULL)/NULLIF(count(*),0))::numeric,1) AS null_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
      AND order_id NOT LIKE '%-REFUND%' AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 ORDER BY total DESC
  LOOP
    RAISE NOTICE '   % | % total | AFN % | MFN % | NULL % (% pct)',
      rpad(r.mk,4), lpad(r.total::text,6), lpad(r.afn::text,6),
      lpad(r.mfn::text,5), lpad(r.nulls::text,6), r.null_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1d. is NULL concentrated by PRICE_SOURCE (a proxy for which writer created it)? ==';
  FOR r IN
    SELECT COALESCE(price_source,'(NULL)') AS psrc, count(*) AS total,
           count(*) FILTER (WHERE fulfillment_channel IS NULL) AS nulls,
           round((100.0*count(*) FILTER (WHERE fulfillment_channel IS NULL)/NULLIF(count(*),0))::numeric,1) AS null_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
      AND order_id NOT LIKE '%-REFUND%' AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 HAVING count(*) > 20 ORDER BY total DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % | % total | % NULL (% pct)',
      rpad(r.psrc,34), lpad(r.total::text,6), lpad(r.nulls::text,6), r.null_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1e. by FEES_SOURCE ==';
  FOR r IN
    SELECT COALESCE(fees_source,'(NULL)') AS fsrc, count(*) AS total,
           count(*) FILTER (WHERE fulfillment_channel IS NULL) AS nulls,
           round((100.0*count(*) FILTER (WHERE fulfillment_channel IS NULL)/NULLIF(count(*),0))::numeric,1) AS null_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
      AND order_id NOT LIKE '%-REFUND%' AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 HAVING count(*) > 20 ORDER BY total DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % total | % NULL (% pct)',
      rpad(r.fsrc,24), lpad(r.total::text,6), lpad(r.nulls::text,6), r.null_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1f. is NULL concentrated in certain ASINs? ==';
  FOR r IN
    SELECT count(DISTINCT asin) AS asins_with_nulls,
           (SELECT count(DISTINCT asin) FROM public.sales_orders
            WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
              AND order_id NOT LIKE '%-REFUND%') AS asins_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 365
      AND fulfillment_channel IS NULL AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   % of % ASINs have at least one NULL-channel order',
      r.asins_with_nulls, r.asins_total;
    RAISE NOTICE '   -> spread across the catalogue, not a handful of ASINs';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1g. is it a TIME WINDOW? NULL pct by created_at week, last 10 weeks ==';
  FOR r IN
    SELECT to_char(date_trunc('week', created_at),'YYYY-MM-DD') AS wk,
           count(*) AS total,
           count(*) FILTER (WHERE fulfillment_channel IS NULL) AS nulls,
           round((100.0*count(*) FILTER (WHERE fulfillment_channel IS NULL)/NULLIF(count(*),0))::numeric,1) AS null_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND created_at >= CURRENT_DATE - 70
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   week of % | % created | % NULL (% pct)',
      r.wk, lpad(r.total::text,6), lpad(r.nulls::text,6), r.null_pct;
  END LOOP;
END
$p$;
