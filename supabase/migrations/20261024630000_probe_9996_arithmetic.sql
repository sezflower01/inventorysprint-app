-- READ-ONLY. Reconstruct the "5 units / $99.96" figure.
--
-- Nothing stores 99.96, and no row is short by exactly one unit, so the number
-- is produced by the report summing rows. B0H854F7VF on 2026-10-24 has four
-- orders totalling 5 units, which is the only 5-unit grouping that matches.
DO $p$
DECLARE r record; v_uid uuid;
  v_units int := 0; v_sold numeric := 0; v_est numeric := 0; v_mixed numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== B0H854F7VF, order_date 2026-10-24, every row ==';
  FOR r IN
    SELECT order_id, quantity AS q,
           round(COALESCE(sold_price,0),4) AS sold,
           round(COALESCE(total_sale_amount,0),2) AS total,
           round(COALESCE(estimated_price,0),2) AS est,
           COALESCE(order_status,'(null)') AS st, COALESCE(price_source,'(null)') AS src
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B0H854F7VF' AND order_date = DATE '2026-10-24'
    ORDER BY order_id
  LOOP
    RAISE NOTICE '   % | q% | sold % | total % | est % | % | %',
      r.order_id, r.q, lpad(r.sold::text,9), lpad(r.total::text,8),
      lpad(r.est::text,8), rpad(r.st,9), r.src;
    v_units := v_units + r.q;
    v_sold  := v_sold + r.total;
    v_est   := v_est + (r.est * r.q);
    -- how the reader actually behaves: confirmed rows use their stored total,
    -- unpriced rows fall back to the estimate
    v_mixed := v_mixed + CASE WHEN r.sold > 0 THEN r.total ELSE r.est * r.q END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   units (sum of quantity)            : %', v_units;
  RAISE NOTICE '   sum of stored total_sale_amount    : %', round(v_sold,2);
  RAISE NOTICE '   sum of estimated_price * quantity  : %', round(v_est,2);
  RAISE NOTICE '   MIXED (stored total, else estimate): %   <-- the report figure', round(v_mixed,2);
  RAISE NOTICE '';
  RAISE NOTICE '   Amazon truth for 5 units at 24.99  : %', round(5 * 24.99, 2);
  RAISE NOTICE '   shortfall                          : %', round(5*24.99 - v_mixed, 2);
  RAISE NOTICE '   one unit at 24.99                  : 24.99';

  RAISE NOTICE '';
  RAISE NOTICE '== is the shortfall exactly the halved q2 order? ==';
  FOR r IN
    SELECT order_id, quantity AS q, round(total_sale_amount,2) AS stored,
           round(sold_price * 2 * quantity, 2) AS if_unit_price_doubled
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '113-1305212-7465044'
  LOOP
    RAISE NOTICE '   % | q% | stored % | if sold_price were the real unit price: %',
      r.order_id, r.q, r.stored, r.if_unit_price_doubled;
  END LOOP;
END
$p$;
