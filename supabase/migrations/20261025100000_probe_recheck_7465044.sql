-- READ-ONLY. Has 113-1305212-7465044 corrected itself in 24 hours?
--
-- The claim being tested is mine: reconcile-pending-prices sets
-- needs_price_enrich = false and wipes estimated_price, so nothing re-checks
-- the row. If that is right, 24 hours later it still reads 24.99 for 2 units
-- and nothing has touched it.
DO $p$
DECLARE r record; v_uid uuid; v_units int := 0; v_mixed numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== the order, now ==';
  FOR r IN
    SELECT quantity AS q, round(sold_price,4) AS unit_px,
           round(total_sale_amount,2) AS total,
           CASE WHEN estimated_price IS NULL THEN 'NULL'
                ELSE round(estimated_price,2)::text END AS est,
           COALESCE(price_source,'(null)') AS src,
           COALESCE(price_confidence,'(null)') AS conf,
           COALESCE(order_status,'(null)') AS st,
           needs_price_enrich, enrich_attempts,
           COALESCE(last_enrich_at::text,'never') AS last_enrich,
           updated_at, round(roi,1) AS roi, round(unit_cost,2) AS cost
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP
    RAISE NOTICE '   qty % | unit % | total % | est %', r.q, r.unit_px, r.total, r.est;
    RAISE NOTICE '   source % | confidence % | status %', r.src, r.conf, r.st;
    RAISE NOTICE '   needs_price_enrich % | attempts % | last_enrich %',
      r.needs_price_enrich, r.enrich_attempts, r.last_enrich;
    RAISE NOTICE '   updated_at % | roi % | unit_cost %', r.updated_at, r.roi, r.cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== Seller Central says 2 x $24.99. Correct values would be ==';
  RAISE NOTICE '   sold_price 24.99 | total_sale_amount 49.98 | shortfall 24.99';

  RAISE NOTICE '';
  RAISE NOTICE '== the B0H854F7VF 2026-10-24 group, as the report sums it today ==';
  FOR r IN
    SELECT order_id, quantity AS q, round(COALESCE(sold_price,0),4) AS sold,
           round(COALESCE(total_sale_amount,0),2) AS total,
           round(COALESCE(estimated_price,0),2) AS est,
           COALESCE(order_status,'(null)') AS st
    FROM public.sales_orders
    WHERE user_id=v_uid AND asin='B0H854F7VF' AND order_date=DATE '2026-10-24'
    ORDER BY order_id
  LOOP
    RAISE NOTICE '   % | q% | sold % | total % | est % | %',
      r.order_id, r.q, lpad(r.sold::text,9), lpad(r.total::text,8), lpad(r.est::text,7), r.st;
    v_units := v_units + r.q;
    v_mixed := v_mixed + CASE WHEN r.sold > 0 THEN r.total ELSE r.est * r.q END;
  END LOOP;
  RAISE NOTICE '   units % | report total % | Amazon truth % | short by %',
    v_units, round(v_mixed,2), round(5*24.99,2), round(5*24.99 - v_mixed,2);

  RAISE NOTICE '';
  RAISE NOTICE '== and the other suspect, 114-8141058-0108255 ==';
  FOR r IN
    SELECT quantity AS q, round(sold_price,4) AS unit_px, round(total_sale_amount,2) AS total,
           round(COALESCE(estimated_price,0),2) AS est, COALESCE(order_status,'(null)') AS st,
           COALESCE(price_source,'(null)') AS src, updated_at
    FROM public.sales_orders WHERE order_id='114-8141058-0108255'
  LOOP
    RAISE NOTICE '   qty % | unit % | total % | est % | % | % | updated %',
      r.q, r.unit_px, r.total, r.est, r.st, r.src, r.updated_at;
  END LOOP;
END
$p$;
