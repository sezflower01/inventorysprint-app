-- READ-ONLY PROBE. repricer-unified-dispatch skips a user outright when
-- scheduler_enabled is false, queue_paused is true, or safe mode is active, and
-- it reports that only to its own logs -- so the cron still records success.
-- An hour of failing SP-API calls is exactly what a circuit breaker exists to
-- notice, so check whether the outage tripped one.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT scheduler_enabled, queue_paused, safe_mode_active, safe_mode_reason,
                  safe_mode_auto_resume_at, circuit_breaker_error_count,
                  circuit_breaker_window_start, sp_api_calls_this_window,
                  sp_api_window_start, sp_api_calls_per_minute_cap,
                  primary_marketplace, dispatch_worker_shard, updated_at
           FROM public.repricer_settings WHERE user_id = v_uid LOOP
    RAISE NOTICE 'scheduler_enabled % | queue_paused % | safe_mode %',
      r.scheduler_enabled, r.queue_paused, r.safe_mode_active;
    RAISE NOTICE 'safe mode reason: %', COALESCE(r.safe_mode_reason, '(none)');
    RAISE NOTICE 'safe mode auto-resume at: %', r.safe_mode_auto_resume_at;
    RAISE NOTICE 'circuit breaker: % errors since %', r.circuit_breaker_error_count, r.circuit_breaker_window_start;
    RAISE NOTICE 'sp-api window: % calls since % (cap %/min)',
      r.sp_api_calls_this_window, r.sp_api_window_start, r.sp_api_calls_per_minute_cap;
    RAISE NOTICE 'marketplace % | shard % | row updated %',
      r.primary_marketplace, r.dispatch_worker_shard, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '(no repricer_settings row — dispatch would skip this user entirely)'; END IF;
END
$p$;
