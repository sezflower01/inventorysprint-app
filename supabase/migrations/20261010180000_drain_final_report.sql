-- READ-ONLY. Final report on the stuck-pending drain.
DO $p$
DECLARE v_uid uuid; r record; n int; v_jobid bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'drain-stuck-pending-5m';
  RAISE NOTICE 'now %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== automatic runs, newest last ==';
  FOR r IN
    WITH runs AS (
      SELECT start_time, status, lead(start_time) OVER (ORDER BY start_time) AS next_start
      FROM cron.job_run_details
      WHERE start_time > '2026-10-10 13:00:00+00'
        AND command ILIKE '%drain_tick%'
    )
    SELECT ru.start_time, ru.status,
           (SELECT count(*) FROM public.stuck_pending_resolution_log l
            WHERE l.resolved_at >= ru.start_time
              AND l.resolved_at < COALESCE(ru.next_start, now())) AS written,
           (SELECT count(DISTINCT l.order_id) FROM public.stuck_pending_resolution_log l
            WHERE l.resolved_at >= ru.start_time
              AND l.resolved_at < COALESCE(ru.next_start, now())) AS distinct_orders
    FROM runs ru ORDER BY ru.start_time
  LOOP
    RAISE NOTICE '  % | % | % written | % distinct | equal %',
      r.start_time, rpad(r.status, 10), lpad(r.written::text, 4),
      lpad(r.distinct_orders::text, 4), (r.written = r.distinct_orders);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none matched)'; END IF;

  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'drain-stuck-pending-5m';
  RAISE NOTICE '';
  RAISE NOTICE 'job still scheduled: % (0 means it stopped itself)', n;
  FOR r IN SELECT last_run_at, last_cohort, consecutive_zero_runs, last_note
           FROM public.stuck_pending_drain_state WHERE id = 1 LOOP
    RAISE NOTICE 'drain state: % | cohort % | zero runs % | %',
      r.last_run_at, COALESCE(r.last_cohort::text, '-'), r.consecutive_zero_runs, r.last_note;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== FINAL BUCKETS (latest row per order, this restart only) ==';
  FOR r IN
    SELECT CASE WHEN new_is_cancelled THEN 'cancelled'
                WHEN price_recovered THEN 'shipped - price recovered'
                ELSE 'shipped - ESTIMATE_UNRECOVERABLE' END AS bucket,
           count(*) AS orders, round(sum(estimated_price)::numeric, 2) AS est
    FROM (SELECT DISTINCT ON (order_id) order_id, new_is_cancelled, price_recovered, estimated_price
          FROM public.stuck_pending_resolution_log
          WHERE resolved_at > '2026-10-10 13:00:00+00'
          ORDER BY order_id, resolved_at DESC) t
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | $% of estimate', rpad(r.bucket, 34), lpad(r.orders::text, 4), r.est;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS cohort, COALESCE(round(sum(estimated_price * quantity)::numeric, 2), 0) AS est
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND COALESCE(so.sold_price, 0) = 0
      AND COALESCE(so.estimated_price, 0) > 0
      AND COALESCE(so.is_cancelled, false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date <= current_date - 90
      AND COALESCE(so.price_confidence, '') <> 'ESTIMATE_UNRECOVERABLE'
      AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                      WHERE a.order_id = so.order_id AND a.attempts >= 3)
  LOOP
    RAISE NOTICE 'eligible cohort remaining: % orders | $% (150 at restart)', r.cohort, r.est;
  END LOOP;

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled,
             so.estimated_price * GREATEST(so.quantity, 1) / COALESCE(fx.rate, 1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base = 'USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace, 'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price, 0) = 0
        AND COALESCE(so.estimated_price, 0) > 0 AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled, false) = false)::numeric, 2) AS a
    FROM base
  LOOP
    RAISE NOTICE 'Live Sales estimated revenue: $%', r.a;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== were the 149 the loop never reached all asked? ==';
  FOR r IN
    SELECT count(*) AS never_asked
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND COALESCE(so.sold_price, 0) = 0
      AND COALESCE(so.estimated_price, 0) > 0
      AND COALESCE(so.is_cancelled, false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date <= current_date - 90
      AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a WHERE a.order_id = so.order_id)
  LOOP
    RAISE NOTICE '  old orders never asked of Amazon at all: % (want 0)', r.never_asked;
  END LOOP;

  FOR r IN SELECT count(*) AS rows, round(sum(sales)::numeric, 2) AS sales
           FROM public.financial_events_cache WHERE user_id = v_uid LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'P&L: % rows | sales $%', r.rows, r.sales;
  END LOOP;
END
$p$;
