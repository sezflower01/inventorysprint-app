-- READ-ONLY. getLineRevenue returns 0 for the CA order (no estimate), so the
-- US$9.90 on screen cannot be coming from it. The mobile view aggregates by
-- ASIN, so check whether another sale of B07KY25WY7 is in the same period.
DO $p$
DECLARE v_uid uuid; r record; v_cad numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  RAISE NOTICE '== EVERY order for B07KY25WY7 in the last 3 days ==';
  FOR r IN
    SELECT so.order_id, COALESCE(so.marketplace,'(null)') AS mk, so.quantity AS qty,
           so.sold_price, so.total_sale_amount, so.estimated_price,
           COALESCE(so.price_source,'(none)') AS psrc,
           so.order_status, so.order_date, so.purchase_timestamp_utc AS bought,
           COALESCE(so.is_cancelled::text,'-') AS canc
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B07KY25WY7'
      AND so.order_date >= current_date - 3
    ORDER BY so.purchase_timestamp_utc DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % % q% | sold % | total_sale % | est % | % | % | %',
      rpad(r.mk,3), r.order_id, r.qty,
      lpad(COALESCE(r.sold_price::text,'NULL'),7),
      lpad(COALESCE(r.total_sale_amount::text,'NULL'),7),
      lpad(COALESCE(r.estimated_price::text,'NULL'),7),
      rpad(r.psrc,26), r.order_status, r.bought;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what each of those contributes to the mobile ASIN record ==';
  RAISE NOTICE '   getLineRevenue: total_sale_amount, else sold_price x qty,';
  RAISE NOTICE '   else estimated_price x qty, else ZERO.';
  FOR r IN
    SELECT so.order_id, COALESCE(so.marketplace,'(null)') AS mk,
           CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN so.total_sale_amount
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * so.quantity
             WHEN COALESCE(so.estimated_price,0) > 0 THEN so.estimated_price * so.quantity
             ELSE 0
           END AS contributes,
           CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN 'total_sale_amount'
             WHEN COALESCE(so.sold_price,0) > 0 THEN 'sold_price x qty'
             WHEN COALESCE(so.estimated_price,0) > 0 THEN 'estimated x qty'
             ELSE 'ZERO (no price of any kind)'
           END AS via
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B07KY25WY7'
      AND so.order_date >= current_date - 3 AND COALESCE(so.is_cancelled,false) = false
    ORDER BY so.purchase_timestamp_utc DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % % | contributes % via %',
      rpad(r.mk,3), r.order_id, lpad(round(r.contributes::numeric,2)::text,8), r.via;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is there a US sale at exactly 9.90? ==';
  FOR r IN
    SELECT so.order_id, COALESCE(so.marketplace,'(null)') AS mk, so.sold_price,
           so.total_sale_amount, so.quantity AS qty, so.order_date
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B07KY25WY7'
      AND (so.sold_price BETWEEN 9.80 AND 10.00
           OR so.total_sale_amount BETWEEN 9.80 AND 10.00
           OR so.estimated_price BETWEEN 9.80 AND 10.00)
    ORDER BY so.order_date DESC LIMIT 5
  LOOP
    RAISE NOTICE '   % % | sold % | total % | q% | %',
      rpad(r.mk,3), r.order_id, r.sold_price, r.total_sale_amount, r.qty, r.order_date;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO order for this ASIN has a price anywhere near 9.90.';
    RAISE NOTICE '   inventory.my_price IS 9.90 for sku NQN-BBR-MLDM, and';
    RAISE NOTICE '   inventory is ONE USD pool shared by all four marketplaces --';
    RAISE NOTICE '   so a US list price is standing in for a CA sale.';
  END IF;
END
$p$;
