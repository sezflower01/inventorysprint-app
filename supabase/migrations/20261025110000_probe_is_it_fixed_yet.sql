-- READ-ONLY. Is 113-1305212-7465044 fixed yet? Nothing has been applied, so
-- the expected answer is no -- but the row has been touched twice without the
-- price changing, so it is worth checking rather than asserting.
DO $p$
DECLARE r record; v_uid uuid; v_units int := 0; v_total numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  FOR r IN
    SELECT quantity AS q, round(sold_price,4) AS unit_px,
           round(total_sale_amount,2) AS total,
           COALESCE(order_status,'(null)') AS st,
           COALESCE(price_source,'(null)') AS src,
           COALESCE(price_confidence,'(null)') AS conf,
           updated_at
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP
    RAISE NOTICE '== 113-1305212-7465044 ==';
    RAISE NOTICE '   qty % | unit % | TOTAL % | % | % | %',
      r.q, r.unit_px, r.total, r.st, r.src, r.conf;
    RAISE NOTICE '   updated_at %', r.updated_at;
    IF round(r.total,2) = 49.98 THEN
      RAISE NOTICE '   FIXED';
    ELSE
      RAISE NOTICE '   NOT FIXED -- still %, should be 49.98, short by %',
        r.total, round(49.98 - r.total, 2);
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what mobile and the report sum for B0H854F7VF on 2026-10-24 ==';
  FOR r IN
    SELECT quantity AS q, COALESCE(sold_price,0) AS sold,
           COALESCE(total_sale_amount,0) AS total, COALESCE(estimated_price,0) AS est
    FROM public.sales_orders
    WHERE user_id=v_uid AND asin='B0H854F7VF' AND order_date=DATE '2026-10-24'
  LOOP
    v_units := v_units + r.q;
    v_total := v_total + CASE WHEN r.sold > 0 THEN r.total ELSE r.est * r.q END;
  END LOOP;
  RAISE NOTICE '   units % | shown % | Amazon truth % | short by %',
    v_units, round(v_total,2), round(v_units * 24.99,2),
    round(v_units * 24.99 - v_total, 2);
END
$p$;
