-- READ-ONLY PROBE. The corrected rates the previous probe printed past the
-- output cut, including the two ASINs this week's buying advice rests on.

DO $p$
DECLARE v_uid uuid; r record; v_start date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  v_start := (date_trunc('day', current_date) - interval '12 months')::date;

  RAISE NOTICE '== is B0CKJNCZLY affected at all? ==';
  FOR r IN SELECT order_id, order_date, quantity, refund_quantity, refund_amount, price_source
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND order_id LIKE '%-REFUND' AND COALESCE(refund_quantity, 0) > quantity
           ORDER BY refund_quantity DESC LIMIT 5 LOOP
    RAISE NOTICE '  % | % | qty % refund_qty % | $% | %',
      r.order_id, r.order_date, r.quantity, r.refund_quantity, r.refund_amount, r.price_source;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NO phantom rows — its returns are genuine'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== corrected rates, the rest of the list ==';
  FOR r IN
    WITH sold AS (
      SELECT asin, sum(quantity) AS u FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= v_start
        AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
      GROUP BY asin),
    ret AS (
      SELECT asin,
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS as_recorded,
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN LEAST(COALESCE(NULLIF(refund_quantity, 0), quantity), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS corrected
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= v_start
        AND COALESCE(is_cancelled, false) = false
      GROUP BY asin)
    SELECT s.asin, s.u AS sold, t.as_recorded, t.corrected,
           round((100.0 * t.as_recorded / NULLIF(s.u, 0))::numeric, 1) AS rate_now,
           round((100.0 * t.corrected / NULLIF(s.u, 0))::numeric, 1) AS rate_fixed
    FROM sold s JOIN ret t ON t.asin = s.asin
    WHERE s.asin IN ('B0CKJNCZLY','B077DY3DRM','B09WJHD19B','B0B1MXD5ZN',
                     'B000GWG14Q','B077ZYJ3TB','B00ZQFTTJC','B0002KR11O',
                     'B07RQ9QB6K','B08YJW5G1R','B09N1RG7JC')
    ORDER BY (t.as_recorded - t.corrected) DESC
  LOOP
    RAISE NOTICE '  % | % sold | recorded % (% pct) -> corrected % (% pct)',
      r.asin, r.sold, r.as_recorded, r.rate_now, r.corrected, r.rate_fixed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== account-wide, rolling 12 months ==';
  FOR r IN
    SELECT sum(quantity) FILTER (WHERE order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price,0) > 0) AS sold,
           sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) AS recorded,
           sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN LEAST(COALESCE(NULLIF(refund_quantity, 0), quantity), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) AS corrected
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= v_start
      AND COALESCE(is_cancelled, false) = false
  LOOP
    RAISE NOTICE '  % sold | recorded % (% pct) -> corrected % (% pct)',
      r.sold, r.recorded, round((100.0 * r.recorded / NULLIF(r.sold, 0))::numeric, 2),
      r.corrected, round((100.0 * r.corrected / NULLIF(r.sold, 0))::numeric, 2);
  END LOOP;
END
$p$;
