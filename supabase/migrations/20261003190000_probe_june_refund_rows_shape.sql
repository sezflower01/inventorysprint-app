-- READ-ONLY PROBE. June 2026 holds 975 returns across 105 ASINs (16.4%) against
-- a 4-6% baseline, July holds 10 (0.2%), and 674 of June's units landed on four
-- days -- 24 to 27 June -- in just 35 rows. Ten rows carrying 283 units is not
-- what customer returns look like.
--
-- So: are these aggregated rows from an import rather than individual returns?
-- If they are, then every "June spike" attributed to a product this week --
-- B0CKJNCZLY's 47, B077DY3DRM's 37 -- is an ingestion artefact, the 12-month
-- return rates on those ASINs are overstated, and the buying maths built on
-- them is too pessimistic.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the big June rows, in full ==';
  FOR r IN SELECT order_id, order_date, asin, quantity, refund_quantity, refund_amount,
                  sold_price, total_sale_amount, price_source, fees_source, created_at
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id LIKE '%-REFUND'
             AND order_date >= '2026-06-24' AND order_date < '2026-06-28'
           ORDER BY GREATEST(COALESCE(refund_quantity, 0), quantity) DESC LIMIT 12 LOOP
    RAISE NOTICE '  % | % | % | qty % refund_qty % | amount $% | price $% | % / % | created %',
      r.order_id, r.order_date, r.asin, r.quantity, r.refund_quantity, r.refund_amount,
      r.sold_price, COALESCE(r.price_source, ''), COALESCE(r.fees_source, ''), r.created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== row-quantity distribution: June vs a normal month ==';
  FOR r IN
    SELECT CASE WHEN order_date >= '2026-06-01' AND order_date < '2026-07-01' THEN 'June 2026'
                ELSE 'other months' END AS period,
           count(*) AS rows,
           round(avg(GREATEST(COALESCE(refund_quantity, 0), quantity))::numeric, 1) AS avg_units_per_row,
           max(GREATEST(COALESCE(refund_quantity, 0), quantity)) AS max_units_per_row,
           count(*) FILTER (WHERE GREATEST(COALESCE(refund_quantity, 0), quantity) > 5) AS rows_over_5
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id LIKE '%-REFUND' AND order_date >= '2025-10-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % rows | avg %/row | max %/row | % rows above 5 units',
      r.period, r.rows, r.avg_units_per_row, r.max_units_per_row, r.rows_over_5;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== when were those June rows WRITTEN (created_at), vs their order_date? ==';
  FOR r IN SELECT date_trunc('day', created_at)::date AS written, count(*) AS rows,
                  sum(GREATEST(COALESCE(refund_quantity, 0), quantity)) AS units,
                  min(order_date) AS earliest_dated, max(order_date) AS latest_dated
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id LIKE '%-REFUND'
             AND order_date >= '2026-06-01' AND order_date < '2026-07-01'
           GROUP BY 1 ORDER BY 3 DESC LIMIT 8 LOOP
    RAISE NOTICE '  written % | % rows | % units | dated % .. %',
      r.written, r.rows, r.units, r.earliest_dated, r.latest_dated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do those order_ids match a real parent order? ==';
  FOR r IN
    SELECT count(*) AS refund_rows,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.sales_orders p
             WHERE p.user_id = rr.user_id
               AND p.order_id = replace(rr.order_id, '-REFUND', ''))) AS with_parent
    FROM public.sales_orders rr
    WHERE rr.user_id = v_uid AND rr.order_id LIKE '%-REFUND'
      AND rr.order_date >= '2026-06-24' AND rr.order_date < '2026-06-28'
  LOOP
    RAISE NOTICE '  % refund rows, % of them have a matching parent order', r.refund_rows, r.with_parent;
  END LOOP;
END
$p$;
