-- READ-ONLY. Rewritten in place (fx_rates has no fetched_at).
-- Steps 3 and 4, plus the thing that matters most: price_source on this row is
-- now seller_derived:snapshot while locked_from is still
-- keepa_buybox:manual:buybox. Something wrote at 2026-10-18 05:22 and my
-- trigger did not stop it. Find out whether the trigger has a hole.
DO $p$
DECLARE v_uid uuid; r record; v_mxn numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '=== 3. FX ===';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fx_rates'
  LOOP RAISE NOTICE '   fx_rates columns: %', r.cols; END LOOP;

  FOR r IN
    SELECT base, quote, rate FROM public.fx_rates
    WHERE base='USD' AND quote IN ('MXN','CAD') ORDER BY quote
  LOOP RAISE NOTICE '   USD/% = %', r.quote, r.rate; END LOOP;

  SELECT rate INTO v_mxn FROM public.fx_rates WHERE base='USD' AND quote='MXN' LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE '   ONE rate is used for both figures. src/lib/marketplaceCurrency.ts';
  RAISE NOTICE '   reads fx_rates where base=USD and quote=<marketplace currency>;';
  RAISE NOTICE '   MX maps to MXN. There is no second rate anywhere in this path.';
  RAISE NOTICE '   current  470.36 x 3 / % = US$%', v_mxn, round((470.36*3/v_mxn)::numeric,2);
  RAISE NOTICE '   Amazon   392.30 x 3 / % = US$%', v_mxn, round((392.30*3/v_mxn)::numeric,2);
  RAISE NOTICE '   overstatement US$%', round(((470.36-392.30)*3/v_mxn)::numeric,2);

  RAISE NOTICE '';
  RAISE NOTICE '=== 2d. WHAT RAN AT 2026-10-18 05:22? (row updated 05:22:15.92) ===';
  FOR r IN
    SELECT d.jobid, j.jobname, d.start_time, d.end_time, d.status
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time BETWEEN '2026-10-18 05:19:00+00' AND '2026-10-18 05:23:30+00'
    ORDER BY d.start_time
  LOOP
    RAISE NOTICE '   [%] % | % -> % | %', lpad(r.jobid::text,3), rpad(r.jobname,38),
      to_char(r.start_time,'HH24:MI:SS'), to_char(r.end_time,'HH24:MI:SS'), r.status;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no cron runs in that window)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '=== DOES MY TRIGGER HAVE A HOLE? ===';
  RAISE NOTICE '   Hypothesis: the trigger allows any write whose NEW.locked_from';
  RAISE NOTICE '   matches the manual prefix. An UPDATE that does not MENTION';
  RAISE NOTICE '   locked_from inherits OLD.locked_from into NEW -- which IS the';
  RAISE NOTICE '   manual prefix -- so a partial automatic write passes the check';
  RAISE NOTICE '   meant to identify deliberate manual writes.';
  BEGIN
    UPDATE public.sales_orders
    SET price_source = 'seller_derived:snapshot',
        price_confidence = 'HIGH_CONFIDENCE_PENDING',
        estimated_price = 888.88
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';

    FOR r IN
      SELECT estimated_price, price_source FROM public.sales_orders
      WHERE user_id = v_uid AND order_id = '702-6705125-8817807'
    LOOP
      RAISE NOTICE '   partial write WITHOUT locked_from -> est %, src %',
        r.estimated_price, r.price_source;
      RAISE NOTICE '   VERDICT: %',
        CASE WHEN r.estimated_price = 888.88
             THEN 'HOLE CONFIRMED - the trigger let it straight through'
             ELSE 'no hole - trigger held it' END;
    END LOOP;
    RAISE EXCEPTION 'probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'probe_rollback' THEN RAISE NOTICE '   probe error: %', SQLERRM; END IF;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4. BLAST RADIUS: every row the Keepa button ever touched ===';
  FOR r IN
    SELECT l.order_id, l.marketplace AS mk, l.asin, so.quantity AS qty,
           min(l.old_estimate) AS first_old,
           so.estimated_price AS now_est, so.sold_price,
           COALESCE(so.price_source,'-') AS psrc, COALESCE(so.locked_from,'-') AS lf
    FROM public.keepa_estimate_recheck_log l
    JOIN public.sales_orders so ON so.order_id = l.order_id AND so.user_id = l.user_id
    WHERE l.user_id = v_uid
    GROUP BY l.order_id, l.marketplace, l.asin, so.quantity, so.estimated_price,
             so.sold_price, so.price_source, so.locked_from
    ORDER BY l.marketplace, l.order_id
  LOOP
    RAISE NOTICE '   % % % q% | orig % -> now % | sold % | src % | lock %',
      rpad(r.mk,3), r.order_id, r.asin, r.qty,
      lpad(r.first_old::text,8), lpad(r.now_est::text,8), r.sold_price,
      rpad(r.psrc,30), r.lf;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4b. dollar impact of the button, per marketplace ===';
  FOR r IN
    SELECT l.marketplace AS mk, count(DISTINCT l.order_id) AS orders,
           round(sum((so.estimated_price - f.first_old) * so.quantity / fx.rate)::numeric,2) AS usd_delta
    FROM (SELECT user_id, order_id, min(old_estimate) AS first_old,
                 min(applied_at) AS first_at
          FROM public.keepa_estimate_recheck_log GROUP BY 1,2) f
    JOIN public.keepa_estimate_recheck_log l
      ON l.user_id = f.user_id AND l.order_id = f.order_id AND l.applied_at = f.first_at
    JOIN public.sales_orders so ON so.order_id = l.order_id AND so.user_id = l.user_id
    JOIN public.fx_rates fx ON fx.base='USD'
     AND fx.quote = CASE l.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE l.user_id = v_uid AND COALESCE(so.sold_price,0) = 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | reported revenue moved by US$%', rpad(r.mk,3), r.orders, r.usd_delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== 4c. P&L SAFETY: is this order in financial_events_cache at all? ===';
  FOR r IN
    SELECT count(*) AS rows FROM public.financial_events_cache
    WHERE amazon_order_id = '702-6705125-8817807'
  LOOP
    RAISE NOTICE '   % rows (0 = P&L cannot see this order, so a revert cannot move the P&L)', r.rows;
  END LOOP;
END
$p$;
