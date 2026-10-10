-- READ-ONLY. Per automatic run: selected, distinct, written, throttles, cohort.
-- Log rows are attributed to a run by falling inside its window, since the
-- resolver writes them as it goes.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE 'now %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== automatic runs of job 195 ==';
  FOR r IN
    WITH runs AS (
      SELECT start_time, status,
             lead(start_time) OVER (ORDER BY start_time) AS next_start
      FROM cron.job_run_details
      WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='drain-stuck-pending-5m')
        AND start_time IS NOT NULL
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
    RAISE NOTICE '  % | % | % written | % distinct | equal: %',
      r.start_time, rpad(r.status,10), lpad(r.written::text,4),
      lpad(r.distinct_orders::text,4), (r.written = r.distinct_orders);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== throttles and tripwires in the resolver replies ==';
  FOR r IN SELECT id, created, left(COALESCE(content,''),210) AS body
           FROM net._http_response
           WHERE created > '2026-10-10 13:05:00+00'
             AND (content LIKE '%ordersAsked%' OR content LIKE '%tripwire%')
           ORDER BY id LOOP
    RAISE NOTICE '  % | % | %', r.id, r.created, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no resolver replies recorded yet)'; END IF;

  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS cohort, round(sum(estimated_price*quantity)::numeric,2) AS est
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0 AND COALESCE(so.estimated_price,0)>0
      AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date <= current_date - 90
      AND COALESCE(so.price_confidence,'') <> 'ESTIMATE_UNRECOVERABLE'
      AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                      WHERE a.order_id = so.order_id AND a.attempts >= 3)
  LOOP
    RAISE NOTICE 'cohort now: % orders | $% (150 at restart)', r.cohort, r.est;
  END LOOP;

  SELECT count(*) INTO n FROM cron.job WHERE jobname='drain-stuck-pending-5m';
  RAISE NOTICE 'job still scheduled: % (0 means it stopped itself)', n;
END
$p$;
