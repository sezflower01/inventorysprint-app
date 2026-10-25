-- READ-ONLY. How many multi-unit rows carry a LINE TOTAL equal to one unit?
--
-- That is the halving signature: total_sale_amount ~ one unit's price, so
-- sold_price comes out as total/quantity. On 113-1305212-7465044 the stored
-- total is 24.99 for 2 units, and 24.99 is what a single unit sells for.
--
-- estimated_price is the independent reference for "what one unit sells for",
-- which is why rows with no estimate cannot be judged this way -- and the
-- example order is exactly such a row, so it is counted separately.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== multi-unit rows, last 60d, where the LINE TOTAL ~= ONE unit price ==';
  FOR r IN
    SELECT COALESCE(order_status,'(null)') AS st,
           COALESCE(price_source,'(null)') AS src,
           count(*) AS n
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 60
      AND quantity > 1 AND total_sale_amount > 0 AND estimated_price > 0
      AND abs(total_sale_amount - estimated_price) < greatest(0.05, estimated_price * 0.03)
    GROUP BY 1,2 ORDER BY n DESC LIMIT 10
  LOOP RAISE NOTICE '   % | % | % rows', rpad(r.st,10), rpad(r.src,26), r.n; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE -- no other row shows the halving signature'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== every multi-unit row sourced from orders_itemprice, last 60d ==';
  FOR r IN
    SELECT order_id, asin, quantity AS q,
           round(sold_price,4) AS unit_px, round(total_sale_amount,2) AS total,
           CASE WHEN estimated_price IS NULL THEN 'NULL'
                ELSE round(estimated_price,2)::text END AS est,
           COALESCE(order_status,'(null)') AS st, order_date,
           COALESCE(price_confidence,'(null)') AS conf
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 60
      AND quantity > 1 AND price_source LIKE 'orders_itemprice%'
    ORDER BY order_date DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | q% | unit % | total % | est % | % | % | %',
      r.order_id, r.asin, r.q, lpad(r.unit_px::text,9), lpad(r.total::text,8),
      lpad(r.est,8), rpad(r.st,9), r.conf, r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== will it ever be re-checked? the enrichment flags on the example ==';
  FOR r IN
    SELECT needs_price_enrich, needs_fee_enrich, enrich_attempts,
           COALESCE(price_confidence,'(null)') AS conf,
           COALESCE(next_enrich_after::text,'(null)') AS next_after,
           COALESCE(last_enrich_at::text,'(null)') AS last_at
    FROM public.sales_orders WHERE order_id = '113-1305212-7465044'
  LOOP
    RAISE NOTICE '   needs_price_enrich % | needs_fee_enrich % | attempts % | confidence %',
      r.needs_price_enrich, r.needs_fee_enrich, r.enrich_attempts, r.conf;
    RAISE NOTICE '   next_enrich_after % | last_enrich_at %', r.next_after, r.last_at;
  END LOOP;
END
$p$;
