-- READ-ONLY. enrich_attempts = 0 and last_enrich_attempt_at = never, 80+
-- minutes after insert, with needs_price_enrich = true and next_enrich_after
-- NULL (eligible immediately). So the order was never ATTEMPTED. Did the
-- enrichment workers run at all?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the price-enrichment workers since this order was created (16:52) ==';
  FOR r IN
    SELECT j.jobid, j.jobname, d.start_time, d.end_time, d.status
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= '2026-10-18 16:52:00+00'
      AND (j.jobname ILIKE '%pending-price%' OR j.jobname ILIKE '%self-heal%'
           OR j.jobname ILIKE '%repair%' OR j.jobname ILIKE '%enrich%')
    ORDER BY d.start_time
  LOOP
    RAISE NOTICE '   [%] % | % -> % | %', lpad(r.jobid::text,3), rpad(r.jobname,40),
      to_char(r.start_time,'HH24:MI:SS'), to_char(r.end_time,'HH24:MI:SS'), r.status;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE RAN -- that is the answer'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how stale is enrichment across ALL pending non-US orders? ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS pending,
           count(*) FILTER (WHERE COALESCE(enrich_attempts,0) = 0) AS never_attempted,
           count(*) FILTER (WHERE needs_price_enrich) AS flagged,
           max(EXTRACT(epoch FROM (now() - created_at))/3600)::int AS oldest_hours
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND COALESCE(sold_price,0) = 0 AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % pending | % NEVER attempted | % flagged | oldest % h',
      rpad(r.mk,3), lpad(r.pending::text,3), lpad(r.never_attempted::text,3),
      lpad(r.flagged::text,3), r.oldest_hours;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and for US pending orders, for comparison ==';
  FOR r IN
    SELECT count(*) AS pending,
           count(*) FILTER (WHERE COALESCE(enrich_attempts,0) = 0) AS never_attempted
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) = 'US'
      AND COALESCE(sold_price,0) = 0 AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%' AND order_date >= current_date - 7
  LOOP
    RAISE NOTICE '   US | % pending (7d) | % never attempted', r.pending, r.never_attempted;
  END LOOP;
END
$p$;
