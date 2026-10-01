-- READ-ONLY PROBE, corrected columns. sp_api_rate_limit_state holds only
-- (user_id, operation, last_called_at) -- the gate is an atomic claim on
-- last_called_at, not a request counter -- and the throttle tally lives in
-- keepa_daily_usage.sp_api_throttled_count.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== SP-API gate, per operation ==';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since_last
           FROM public.sp_api_rate_limit_state
           WHERE user_id = v_uid ORDER BY last_called_at DESC NULLS LAST LIMIT 15 LOOP
    RAISE NOTICE '  % | last called % (% ago)', r.operation, r.last_called_at, r.since_last;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== throttles and Keepa budget, last 3 days ==';
  FOR r IN SELECT usage_date, call_count, keepa_success_count, keepa_429_count,
                  sp_api_throttled_count, cache_fallback_count,
                  keepa_skipped_token_budget, last_called_at
           FROM public.keepa_daily_usage ORDER BY usage_date DESC LIMIT 3 LOOP
    RAISE NOTICE '  % | calls % | keepa ok % / 429 % | SP-API throttled % | cache fallback % | skipped(budget) % | last %',
      r.usage_date, r.call_count, r.keepa_success_count, r.keepa_429_count,
      r.sp_api_throttled_count, r.cache_fallback_count, r.keepa_skipped_token_budget, r.last_called_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== assignments throttled, by hour (last 12 h) ==';
  FOR r IN SELECT date_trunc('hour', last_throttle_at) AS hr, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_throttle_at > now() - interval '12 hours'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 12 LOOP
    RAISE NOTICE '  % : % throttled', r.hr, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no throttles in 12 h)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== repricer failures in the last 2 h ==';
  FOR r IN SELECT COALESCE(last_error_type, '(none)') AS et, count(*) AS n,
                  max(last_failure_at) AS newest, left(min(last_error_message), 140) AS sample
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_failure_at > now() - interval '2 hours'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % | newest % | %', r.et, r.n, r.newest, r.sample;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no failures in 2 h)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== dispatch load, last 20 minutes ==';
  FOR r IN SELECT date_trunc('minute', last_dispatch_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_dispatch_at > now() - interval '20 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 20 LOOP
    RAISE NOTICE '  % : % dispatched', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (nothing dispatched in 20 min)'; END IF;
END
$p$;
