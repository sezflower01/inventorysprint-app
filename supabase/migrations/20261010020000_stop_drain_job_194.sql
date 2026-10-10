-- STOP job 194 now.
--
-- The cohort was 272 orders. The resolution log has 18,297 rows. The drain has
-- been re-processing the same orders every five minutes for three days.
--
-- The cause is mine: for a Shipped order whose price Amazon will not return,
-- the resolver sets price_confidence = 'ESTIMATE_UNRECOVERABLE' and leaves
-- sold_price at 0 and estimated_price > 0 -- which is exactly the cohort
-- query's definition of an unresolved row. So it selected them again, asked
-- Amazon again, wrote them again, and logged them again, 288 times a day.
-- There was no exit condition for the one outcome I knew in advance would be
-- the common case.
--
-- Unschedule first, diagnose second.
SELECT cron.unschedule('drain-stuck-pending-5m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');

DO $p$
DECLARE r record; n int;
BEGIN
  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'drain-stuck-pending-5m';
  RAISE NOTICE 'job 194 still scheduled: % (must be 0)', n;

  RAISE NOTICE '';
  RAISE NOTICE '== how much of the log is repeats? ==';
  FOR r IN
    SELECT count(*) AS log_rows,
           count(DISTINCT order_id) AS distinct_orders,
           round((count(*)::numeric / NULLIF(count(DISTINCT order_id),0)), 1) AS times_each
    FROM public.stuck_pending_resolution_log
  LOOP
    RAISE NOTICE '  % log rows | % distinct orders | each written % times on average',
      r.log_rows, r.distinct_orders, r.times_each;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the worst repeaters ==';
  FOR r IN
    SELECT order_id, asin, count(*) AS times, min(resolved_at) AS first_seen, max(resolved_at) AS last_seen
    FROM public.stuck_pending_resolution_log
    GROUP BY 1,2 ORDER BY times DESC LIMIT 8
  LOOP
    RAISE NOTICE '  % | % | % times | % .. %', r.order_id, r.asin, r.times, r.first_seen, r.last_seen;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== outcomes, deduplicated to the LATEST row per order ==';
  FOR r IN
    SELECT new_status, price_recovered, count(*) AS orders
    FROM (
      SELECT DISTINCT ON (order_id) order_id, new_status, price_recovered
      FROM public.stuck_pending_resolution_log ORDER BY order_id, resolved_at DESC
    ) t GROUP BY 1,2 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | price recovered % | % orders', rpad(r.new_status,10), r.price_recovered, r.orders;
  END LOOP;
END
$p$;
