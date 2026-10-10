-- The check the seller asked for after the first runs.
-- "Distinct orders should equal rows written" is the loop test: if a run
-- writes an order twice, the exit condition has failed again.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== drain state ==';
  FOR r IN SELECT last_run_at, last_cohort, consecutive_zero_runs, last_note
           FROM public.stuck_pending_drain_state WHERE id = 1 LOOP
    RAISE NOTICE '  last run % | cohort then % | runs without progress % | %',
      r.last_run_at, COALESCE(r.last_cohort::text,'-'), r.consecutive_zero_runs, r.last_note;
  END LOOP;

  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'drain-stuck-pending-5m';
  RAISE NOTICE '  job still scheduled: %', n;

  RAISE NOTICE '';
  RAISE NOTICE '== SINCE THE RESTART: distinct orders vs rows written ==';
  FOR r IN
    SELECT count(*) AS rows_written, count(DISTINCT order_id) AS distinct_orders
    FROM public.stuck_pending_resolution_log WHERE resolved_at > '2026-10-10 12:50:00+00'
  LOOP
    RAISE NOTICE '  % rows written | % distinct orders | equal: %',
      r.rows_written, r.distinct_orders, (r.rows_written = r.distinct_orders);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== attempts distribution (cap is 3) ==';
  FOR r IN SELECT attempts, count(*) AS orders FROM public.stuck_pending_attempts
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % attempts | % orders', lpad(r.attempts::text,3), r.orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cohort now ==';
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
    RAISE NOTICE '  % orders | $% (was 150 eligible at restart)', r.cohort, r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== run replies: ordersAsked, tally, any 429s or tripwire ==';
  FOR r IN SELECT id, left(COALESCE(content,''),200) AS body FROM net._http_response
           WHERE created > '2026-10-10 12:50:00+00' AND content LIKE '%ordersAsked%' OR content LIKE '%tripwire%'
           ORDER BY id DESC LIMIT 5 LOOP
    RAISE NOTICE '  % | %', r.id, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no resolver replies yet)'; END IF;
END
$p$;
