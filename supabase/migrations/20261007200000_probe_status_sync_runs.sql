-- READ-ONLY PROBE, step 3: why the hourly status sync never reached these.
--
-- cron job 170 sync-order-status-updates-hourly, schedule 22 * * * *, active.
-- It has touched 15,464 of 75,805 orders, most recently 2026-10-07 05:15 -- so
-- it RUNS. Yet 415 of the 449 have last_status_sync_at NULL.
--
-- The function queries Amazon with LastUpdatedAfter, which returns orders
-- AMAZON has touched recently. An order Amazon settled months ago and has not
-- touched since is invisible to that query no matter how often it runs, so
-- "the job is healthy" and "these orders are unreachable" are both true.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== runs of the status + cancellation jobs ==';
  FOR r IN
    SELECT job_name, status, started_at, COALESCE(duration_ms::text,'-') AS ms,
           COALESCE(items_processed::text,'-') AS items,
           COALESCE(left(error, 60),'-') AS err
    FROM public.cron_run_history
    WHERE job_name ILIKE '%status%' OR job_name ILIKE '%cancel%'
    ORDER BY started_at DESC LIMIT 15
  LOOP
    RAISE NOTICE '  % | % | % | %ms | % items | %',
      rpad(r.job_name, 32), rpad(r.status, 9), r.started_at, lpad(r.ms, 7), lpad(r.items, 6), r.err;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no runs recorded for either job)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== which orders DOES the sync reach? age at last status sync ==';
  FOR r IN
    SELECT CASE
             WHEN last_status_sync_at IS NULL THEN 'never synced'
             ELSE 'synced'
           END AS seen,
           CASE
             WHEN order_date > current_date - 30  THEN '1. under 30d old'
             WHEN order_date > current_date - 90  THEN '2. 30-90d'
             WHEN order_date > current_date - 365 THEN '3. 90-365d'
             ELSE                                      '4. over a year'
           END AS age,
           count(*) AS orders
    FROM public.sales_orders WHERE user_id = v_uid
    GROUP BY 1,2 ORDER BY 2,1
  LOOP
    RAISE NOTICE '  % | % | % orders', rpad(r.age, 18), rpad(r.seen, 13), r.orders;
  END LOOP;

  -- The settled-but-unlinked bucket is the one with real money in it, so size
  -- it precisely and show what the link WOULD be worth.
  RAISE NOTICE '';
  RAISE NOTICE '== the settled-but-unlinked bucket, priced ==';
  FOR r IN
    WITH cohort AS (
      SELECT order_id, quantity, estimated_price, order_status
      FROM public.sales_orders
      WHERE user_id = v_uid
        AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
        AND order_date <= current_date - 90
    ), joined AS (
      SELECT c.order_id, c.quantity, c.estimated_price,
             sum(f.sales) AS fe_sales, sum(f.refunds) AS fe_refunds
      FROM cohort c
      JOIN public.financial_events_cache f
        ON f.user_id = v_uid AND f.amazon_order_id = c.order_id
      GROUP BY 1,2,3
    )
    SELECT CASE WHEN COALESCE(fe_sales,0) > 0 THEN 'event WITH money'
                ELSE 'event with 0.00 sales' END AS kind,
           count(*) AS orders,
           round(sum(estimated_price * quantity)::numeric, 2) AS est_revenue,
           round(sum(COALESCE(fe_sales,0))::numeric, 2) AS real_revenue,
           round(sum(COALESCE(fe_sales,0) - estimated_price * quantity)::numeric, 2) AS delta
    FROM joined GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | estimated $% | actually $% | difference $%',
      rpad(r.kind, 22), lpad(r.orders::text, 4), lpad(r.est_revenue::text, 9),
      lpad(r.real_revenue::text, 9), r.delta;
  END LOOP;

  -- And the cancelled bucket: is_cancelled is the column Live Sales filters on,
  -- and it disagrees with order_status on every one of these rows.
  RAISE NOTICE '';
  RAISE NOTICE '== is_cancelled vs order_status across ALL orders, not just the 449 ==';
  FOR r IN
    SELECT COALESCE(order_status,'(null)') AS st, is_cancelled,
           count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(sold_price,0) = 0
                              AND COALESCE(estimated_price,0) > 0) AS still_estimated,
           round(sum(estimated_price * quantity) FILTER (WHERE COALESCE(sold_price,0) = 0
                              AND COALESCE(estimated_price,0) > 0)::numeric, 2) AS est_money
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND'
    GROUP BY 1,2 ORDER BY orders DESC LIMIT 12
  LOOP
    RAISE NOTICE '  status % | is_cancelled % | % orders | % still estimated | $%',
      rpad(r.st, 12), rpad(r.is_cancelled::text, 5), lpad(r.orders::text, 7),
      lpad(r.still_estimated::text, 5), COALESCE(r.est_money::text, '0');
  END LOOP;
END
$p$;
