-- READ-ONLY. "Some CA orders have sold price incorrect for MTD Canada."
-- Separate the two populations before answering: a PENDING order showing an
-- estimate is a different problem from a SETTLED order with a wrong price,
-- and only one of them Keepa can touch.
DO $p$
DECLARE v_uid uuid; r record; v_fx numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_fx FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;
  RAISE NOTICE '== MTD CANADA (Oct 1 - today), USD/CAD = % ==', v_fx;

  RAISE NOTICE '';
  RAISE NOTICE '-- population split --';
  FOR r IN
    SELECT CASE
             WHEN COALESCE(sold_price,0) > 0 THEN 'SETTLED (real price from Amazon)'
             WHEN COALESCE(total_sale_amount,0) > 0 THEN 'SETTLED via total_sale_amount'
             WHEN COALESCE(estimated_price,0) > 0 THEN 'PENDING (showing an ESTIMATE)'
             ELSE 'no price at all'
           END AS bucket,
           count(*) AS orders, sum(quantity) AS units
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= date_trunc('month', current_date)
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders | % units', rpad(r.bucket,34), lpad(r.orders::text,4), r.units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- every MTD CA order, so we can see which prices look wrong --';
  RAISE NOTICE '   sold_price is USD. estimated_price is NATIVE CAD.';
  FOR r IN
    SELECT so.order_id, so.asin, so.quantity AS qty,
           so.sold_price AS sold_usd,
           so.estimated_price AS est_cad,
           round((COALESCE(so.estimated_price,0)/NULLIF(v_fx,0))::numeric,2) AS est_as_usd,
           COALESCE(so.price_source,'-') AS src,
           COALESCE(so.price_confidence,'-') AS conf,
           so.order_date::date AS od
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'')) = 'CA'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date >= date_trunc('month', current_date)
    ORDER BY so.order_date DESC
  LOOP
    RAISE NOTICE '   % % q% | sold US$% | est CA$% (=US$%) | % / %',
      r.od, r.asin, r.qty,
      lpad(COALESCE(r.sold_usd,0)::text,7),
      lpad(COALESCE(r.est_cad,0)::text,7),
      lpad(COALESCE(r.est_as_usd,0)::text,7),
      rpad(r.src,26), r.conf;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- known-bug check on the SETTLED MTD CA rows --';
  FOR r IN
    SELECT count(*) AS settled,
           count(*) FILTER (WHERE sold_price > 0 AND estimated_price > 0
                              AND abs(sold_price - estimated_price) < 0.01) AS sold_equals_native_est,
           count(*) FILTER (WHERE sold_price > 0 AND quantity > 1
                              AND total_sale_amount > 0
                              AND abs(total_sale_amount - sold_price) < 0.01) AS line_total_as_unit,
           count(*) FILTER (WHERE sold_price > 0 AND COALESCE(total_fees,0) = 0) AS zero_fees
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= date_trunc('month', current_date) AND COALESCE(sold_price,0) > 0
  LOOP
    RAISE NOTICE '   % settled | % look like NATIVE stored in the USD column | % line-total-as-unit | % with zero fees',
      r.settled, r.sold_equals_native_est, r.line_total_as_unit, r.zero_fees;
  END LOOP;
END
$p$;
