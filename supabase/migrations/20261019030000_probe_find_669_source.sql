-- READ-ONLY. The report shows $669.62. Every revenue path I have read takes
-- total_sale_amount (36.43 USD) first, so a path returning 669.62 must be
-- reading a row where total_sale_amount and sold_price are BOTH zero. Look for
-- a second row for this order, and for any non-US row that would surface a
-- native figure.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. how many ROWS exist for this order id? ==';
  SELECT count(*) INTO n FROM public.sales_orders WHERE order_id = '701-8676794-7473022';
  RAISE NOTICE '   % row(s)', n;
  FOR r IN
    SELECT id, user_id = v_uid AS mine, asin, COALESCE(sku,'-') AS sku, quantity AS qty,
           COALESCE(marketplace,'(NULL)') AS mk,
           sold_price, total_sale_amount AS tsa, estimated_price AS est,
           COALESCE(price_source,'(none)') AS psrc, COALESCE(is_cancelled::text,'-') AS canc,
           order_status, created_at
    FROM public.sales_orders WHERE order_id = '701-8676794-7473022'
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   id % mine % | % % q% | mk % | sold % tsa % est % | % | % | %',
      r.id, r.mine, r.asin, r.sku, r.qty, r.mk, r.sold_price, r.tsa,
      COALESCE(r.est::text,'NULL'), r.psrc, r.order_status, r.created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. ANY non-US row that a non-converting path would show native ==';
  RAISE NOTICE '   (total_sale_amount = 0 AND sold_price = 0 AND estimated_price > 0)';
  RAISE NOTICE '   These are the rows where getStrictLineRevenue and the two';
  RAISE NOTICE '   PeriodStatsBlocks helpers return estimated_price x qty with NO';
  RAISE NOTICE '   conversion, so a native amount lands in a USD total.';
  FOR r IN
    SELECT so.order_date AS od, so.marketplace AS mk, so.order_id, so.asin, so.quantity AS qty,
           so.estimated_price AS est, (so.estimated_price * so.quantity) AS native_contrib,
           round((so.estimated_price * so.quantity / fx.rate)::numeric,2) AS should_be_usd,
           COALESCE(so.price_source,'(none)') AS psrc
    FROM public.sales_orders so
    JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.total_sale_amount,0) = 0 AND COALESCE(so.sold_price,0) = 0
      AND COALESCE(so.estimated_price,0) > 0
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY (so.estimated_price * so.quantity) DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % % % % q% | est % -> shows % but should show %',
      r.od, rpad(r.mk,3), r.order_id, r.asin, r.qty, r.est,
      lpad(r.native_contrib::text,9), lpad(r.should_be_usd::text,8);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. total overstatement these rows cause in a USD report ==';
  FOR r IN
    SELECT so.marketplace AS mk, count(*) AS rows,
           round(sum(so.estimated_price * so.quantity)::numeric,2) AS shown_native,
           round(sum(so.estimated_price * so.quantity / fx.rate)::numeric,2) AS correct_usd,
           round(sum(so.estimated_price * so.quantity
                     - so.estimated_price * so.quantity / fx.rate)::numeric,2) AS overstated_by
    FROM public.sales_orders so
    JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.total_sale_amount,0) = 0 AND COALESCE(so.sold_price,0) = 0
      AND COALESCE(so.estimated_price,0) > 0
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | shown % | correct % | OVERSTATED BY %',
      rpad(r.mk,3), lpad(r.rows::text,3), lpad(r.shown_native::text,10),
      lpad(r.correct_usd::text,9), r.overstated_by;
  END LOOP;
END
$p$;
