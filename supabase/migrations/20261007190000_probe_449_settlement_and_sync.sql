-- READ-ONLY PROBE, step 2. No writes.
--
-- The cohort (449 orders, 506 units, $11,702.14, purchased 2024-11-06 to
-- 2026-07-09) already answered one question by itself:
--
--   US | Pending  | 197 orders | $5,508.99
--   US | Canceled | 155 orders | $3,813.93   <-- our OWN data says cancelled
--   US | Shipped  |  29 orders |   $659.16
--   US | (null)   |  28 orders |   $743.60
--   US | Shipped  (detect_cancelled_job) | 25 | $616.06
--   US | Canceled (detect_cancelled_job) |  5 | $110.90
--   CA | Pending 3, Canceled 5 | MX | Pending 1
--
-- 160 of the 449 are already marked Canceled and still counted, and 54 are
-- marked Shipped. And 415 of 449 have last_status_sync_at NULL -- the status
-- sync has never looked at them at all.
--
-- Remaining questions for the database: does settled money already exist for
-- any of them (financial_events_cache keys on amazon_order_id, not order_id),
-- and why does the status sync not see them.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== C. settled money already on record for the cohort ==';
  FOR r IN
    WITH cohort AS (
      SELECT order_id, quantity, estimated_price, order_status
      FROM public.sales_orders
      WHERE user_id = v_uid
        AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
        AND order_date <= current_date - 90
    )
    SELECT COALESCE(c.order_status, '(null)') AS st,
           CASE WHEN EXISTS (SELECT 1 FROM public.financial_events_cache f
                             WHERE f.user_id = v_uid AND f.amazon_order_id = c.order_id)
                THEN 'HAS a financial event' ELSE 'none' END AS has_fe,
           count(*) AS orders,
           round(sum(c.estimated_price * c.quantity)::numeric, 2) AS est
    FROM cohort c GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '  status % | % | % orders | $%',
      rpad(r.st, 12), rpad(r.has_fe, 22), lpad(r.orders::text, 5), r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== C2. for those WITH an event, what does the money say? ==';
  FOR r IN
    WITH cohort AS (
      SELECT order_id, quantity, estimated_price
      FROM public.sales_orders
      WHERE user_id = v_uid
        AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
        AND order_date <= current_date - 90
    )
    SELECT c.order_id, c.estimated_price, c.quantity,
           round(sum(f.sales)::numeric, 2) AS fe_sales,
           round(sum(f.refunds)::numeric, 2) AS fe_refunds,
           count(*) AS events, min(f.event_type) AS a_type
    FROM cohort c
    JOIN public.financial_events_cache f
      ON f.user_id = v_uid AND f.amazon_order_id = c.order_id
    GROUP BY 1,2,3 ORDER BY fe_sales DESC NULLS LAST LIMIT 20
  LOOP
    RAISE NOTICE '  % | est % x% | fe sales % | refunds % | % events | %',
      r.order_id, lpad(r.estimated_price::text, 8), r.quantity,
      lpad(COALESCE(r.fe_sales::text,'-'), 9), lpad(COALESCE(r.fe_refunds::text,'-'), 8),
      r.events, r.a_type;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (not one of the 449 has a financial event)'; END IF;

  -- ─────────────────────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== B2. is the status sync even scheduled, and does it run? ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active,
           substring(command from 'functions/v1/([a-z0-9-]+)') AS fn
    FROM cron.job
    WHERE command ILIKE '%order-status%' OR command ILIKE '%detect-cancelled%'
       OR jobname ILIKE '%status%' OR jobname ILIKE '%cancel%'
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  job % | % | % | active % | %',
      r.jobid, rpad(COALESCE(r.jobname,''), 34), rpad(r.schedule, 14), r.active, COALESCE(r.fn,'');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NO cron job touches order status at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== B3. cron_run_history columns ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'cron_run_history' LOOP
    RAISE NOTICE '  %', r.cols;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B4. how recently did ANY order get a status sync? ==';
  FOR r IN
    SELECT count(*) FILTER (WHERE last_status_sync_at IS NOT NULL) AS ever_synced,
           count(*) AS total,
           max(last_status_sync_at) AS newest_sync
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  % of % orders have ever been status-synced | newest %',
      r.ever_synced, r.total, COALESCE(r.newest_sync::text, 'never');
  END LOOP;
END
$p$;
