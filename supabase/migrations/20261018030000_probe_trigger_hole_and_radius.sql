-- READ-ONLY. The sections truncated out of the previous probe's output.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '=== DOES MY TRIGGER HAVE A HOLE? ===';
  BEGIN
    UPDATE public.sales_orders
    SET price_source = 'seller_derived:snapshot', estimated_price = 888.88
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    FOR r IN
      SELECT estimated_price, price_source FROM public.sales_orders
      WHERE user_id = v_uid AND order_id = '702-6705125-8817807'
    LOOP
      RAISE NOTICE '   partial UPDATE that never mentions locked_from -> est %, src %',
        r.estimated_price, r.price_source;
      RAISE NOTICE '   VERDICT: %', CASE WHEN r.estimated_price = 888.88
        THEN 'HOLE CONFIRMED -- trigger let it straight through'
        ELSE 'no hole -- trigger held it' END;
    END LOOP;
    RAISE EXCEPTION 'probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'probe_rollback' THEN RAISE NOTICE '   probe error: %', SQLERRM; END IF;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4. BLAST RADIUS: every row the button touched ===';
  FOR r IN
    SELECT l.order_id, l.marketplace AS mk, l.asin, so.quantity AS qty,
           min(l.old_estimate) AS first_old, so.estimated_price AS now_est,
           so.sold_price, COALESCE(so.price_source,'-') AS psrc,
           COALESCE(so.locked_from,'-') AS lf
    FROM public.keepa_estimate_recheck_log l
    JOIN public.sales_orders so ON so.order_id = l.order_id AND so.user_id = l.user_id
    WHERE l.user_id = v_uid
    GROUP BY l.order_id, l.marketplace, l.asin, so.quantity, so.estimated_price,
             so.sold_price, so.price_source, so.locked_from
    ORDER BY l.marketplace, l.order_id
  LOOP
    RAISE NOTICE '   % % % q% | orig % -> now % | sold %',
      rpad(r.mk,3), r.order_id, r.asin, r.qty,
      lpad(r.first_old::text,8), lpad(r.now_est::text,8), r.sold_price;
    RAISE NOTICE '        src % | lock %', rpad(r.psrc,32), r.lf;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4b. USD impact, per marketplace, unsettled rows only ===';
  FOR r IN
    WITH firsts AS (
      SELECT user_id, order_id, marketplace,
             (array_agg(old_estimate ORDER BY applied_at))[1] AS orig
      FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid
      GROUP BY 1,2,3
    )
    SELECT f.marketplace AS mk, count(*) AS orders,
           round(sum(f.orig * so.quantity / fx.rate)::numeric,2) AS usd_orig,
           round(sum(so.estimated_price * so.quantity / fx.rate)::numeric,2) AS usd_now,
           round(sum((so.estimated_price - f.orig) * so.quantity / fx.rate)::numeric,2) AS usd_delta
    FROM firsts f
    JOIN public.sales_orders so ON so.order_id = f.order_id AND so.user_id = f.user_id
    JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE f.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE COALESCE(so.sold_price,0) = 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | was US$% -> now US$% | delta US$%',
      rpad(r.mk,3), r.orders, r.usd_orig, r.usd_now, r.usd_delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4c. P&L SAFETY ===';
  FOR r IN
    SELECT count(*) AS n FROM public.financial_events_cache
    WHERE amazon_order_id IN (SELECT DISTINCT order_id FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid)
  LOOP
    RAISE NOTICE '   financial_events_cache rows for ANY button-touched order: %', r.n;
    RAISE NOTICE '   (0 = the P&L cannot see these orders, so no revert can move it)';
  END LOOP;
END
$p$;
