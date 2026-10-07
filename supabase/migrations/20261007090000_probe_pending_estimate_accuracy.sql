-- READ-ONLY PROBE, following 20261007080000.
--
-- The CA order is NOT an FX bug. The row says:
--   sold_price 0, item_price 0, total_sale_amount 0
--   estimated_price 20.75
--   price_source   seller_derived:snapshot
--   price_confidence HIGH_CONFIDENCE_PENDING
--   bb_estimate_price NULL, bb_estimate_qualified FALSE
--
-- Amazon's own screen says CA$34.13, about US$24. The screen shows $14.56, and
-- 20.75 x ~0.70 is 14.56 -- so the CAD->USD conversion is being applied
-- correctly to an estimate of CA$20.75 for an order that actually sold at
-- CA$34.13. The estimate is 39% low, and it is labelled HIGH_CONFIDENCE.
--
-- Two questions worth answering before changing anything:
--   1. where did CA$20.75 come from -- is it our own listing price?
--   2. how wrong are these estimates generally? Orders estimated while pending
--      and later settled give an exact answer, because both numbers survive.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== our own prices for B002HJ4HSS ==';
  FOR r IN SELECT sku, COALESCE(price::text,'-') AS p, COALESCE(my_price::text,'-') AS mp,
                  COALESCE(cost::text,'-') AS c, COALESCE(listing_status,'-') AS ls, updated_at
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B002HJ4HSS' LOOP
    RAISE NOTICE '  inventory sku % | price % | my_price % | cost % | % | %',
      rpad(r.sku, 14), lpad(r.p, 9), lpad(r.mp, 9), lpad(r.c, 8), rpad(r.ls, 12), r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no inventory row)'; END IF;

  FOR r IN SELECT sku, COALESCE(price::text,'-') AS p, COALESCE(amount::text,'-') AS a, updated_at
           FROM public.created_listings WHERE user_id = v_uid AND asin = 'B002HJ4HSS' LOOP
    RAISE NOTICE '  created_listings sku % | price % | cog % | %',
      rpad(r.sku, 14), lpad(r.p, 9), lpad(r.a, 8), r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the accuracy of pending estimates that later SETTLED ==';
  RAISE NOTICE '   (both numbers survive on the row, so this is exact)';
  FOR r IN
    SELECT COALESCE(price_calc_mode, '(null)') AS mode,
           count(*) AS orders,
           round(avg(estimated_price)::numeric, 2)  AS avg_est,
           round(avg(sold_price)::numeric, 2)       AS avg_actual,
           round(avg(estimated_price - sold_price)::numeric, 2) AS avg_err,
           round((100 * avg((estimated_price - sold_price) / NULLIF(sold_price, 0)))::numeric, 1) AS avg_err_pct,
           count(*) FILTER (WHERE estimated_price < sold_price * 0.9) AS too_low,
           count(*) FILTER (WHERE estimated_price > sold_price * 1.1) AS too_high
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(sold_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false
      AND order_id NOT LIKE '%-REFUND'
      AND order_date > current_date - 180
    GROUP BY 1 ORDER BY orders DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % orders | est $% vs sold $% | err $% (% pct) | % too low | % too high',
      rpad(r.mode, 26), lpad(r.orders::text, 6), lpad(r.avg_est::text, 8),
      lpad(r.avg_actual::text, 8), lpad(r.avg_err::text, 7),
      lpad(r.avg_err_pct::text, 6), lpad(r.too_low::text, 5), r.too_high;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no settled order kept its estimate)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== same, split by marketplace: is CA worse than US? ==';
  FOR r IN
    SELECT COALESCE(marketplace, '?') AS mk, count(*) AS orders,
           round(avg(estimated_price)::numeric, 2) AS avg_est,
           round(avg(sold_price)::numeric, 2) AS avg_actual,
           round((100 * avg((estimated_price - sold_price) / NULLIF(sold_price, 0)))::numeric, 1) AS err_pct,
           count(*) FILTER (WHERE estimated_price < sold_price * 0.9) AS too_low
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(estimated_price, 0) > 0 AND COALESCE(sold_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date > current_date - 180
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders | est $% vs sold $% | % pct | % more than 10 pct low',
      rpad(r.mk, 4), lpad(r.orders::text, 6), lpad(r.avg_est::text, 8),
      lpad(r.avg_actual::text, 8), lpad(r.err_pct::text, 7), r.too_low;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how much money is sitting in UNSETTLED estimates right now? ==';
  FOR r IN
    SELECT COALESCE(marketplace, '?') AS mk,
           COALESCE(price_calc_mode, '(null)') AS mode,
           count(*) AS orders, sum(quantity) AS units,
           round(sum(estimated_price * quantity)::numeric, 2) AS est_revenue
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price, 0) = 0 AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    GROUP BY 1, 2 ORDER BY est_revenue DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % | % orders | % units | $% of estimated revenue',
      rpad(r.mk, 4), rpad(r.mode, 26), lpad(r.orders::text, 6),
      lpad(r.units::text, 6), r.est_revenue;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what does HIGH_CONFIDENCE_PENDING actually mean in practice? ==';
  FOR r IN
    SELECT COALESCE(price_confidence, '(null)') AS conf, count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(sold_price,0) > 0) AS settled,
           round((100 * avg((estimated_price - sold_price) / NULLIF(sold_price, 0))
                  FILTER (WHERE COALESCE(sold_price,0) > 0))::numeric, 1) AS err_pct
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date > current_date - 180
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders | % later settled | avg error % pct',
      rpad(r.conf, 26), lpad(r.orders::text, 6), lpad(r.settled::text, 6),
      COALESCE(r.err_pct::text, 'n/a');
  END LOOP;
END
$p$;
