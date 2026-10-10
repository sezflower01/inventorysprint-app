-- Make the stall detector actually detect. drain_tick read
-- consecutive_zero_runs but nothing ever incremented it, so stop condition 2
-- could never fire -- a guardrail that reads a counter nobody writes is
-- decoration.
--
-- Progress is measured as the cohort SHRINKING. That is the outcome being
-- asked for, and unlike "did the edge function report success" it cannot be
-- satisfied by a run that writes the same rows again.
ALTER TABLE public.stuck_pending_drain_state
  ADD COLUMN IF NOT EXISTS last_cohort int;

CREATE OR REPLACE FUNCTION public.drain_tick()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid; v_cohort int; v_prev int; v_zero int; v_secret text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_cohort
  FROM public.sales_orders so
  WHERE so.user_id = v_uid
    AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.estimated_price,0) > 0
    AND COALESCE(so.is_cancelled,false) = false
    AND so.order_id NOT LIKE '%-REFUND%'
    AND so.order_date <= current_date - 90
    AND COALESCE(so.price_confidence,'') <> 'ESTIMATE_UNRECOVERABLE'
    AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                    WHERE a.order_id = so.order_id AND a.attempts >= 3);

  SELECT consecutive_zero_runs, last_cohort INTO v_zero, v_prev
  FROM public.stuck_pending_drain_state WHERE id = 1;

  -- Did the last dispatch move anything?
  IF v_prev IS NOT NULL AND v_cohort >= v_prev THEN
    v_zero := COALESCE(v_zero,0) + 1;
  ELSE
    v_zero := 0;
  END IF;

  IF v_cohort = 0 THEN
    PERFORM cron.unschedule('drain-stuck-pending-5m')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');
    UPDATE public.stuck_pending_drain_state
    SET last_run_at = now(), last_cohort = 0, consecutive_zero_runs = 0,
        last_note = 'cohort empty - unscheduled' WHERE id = 1;
    RETURN 'done: cohort empty, job unscheduled';
  END IF;

  IF v_zero >= 2 THEN
    PERFORM cron.unschedule('drain-stuck-pending-5m')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');
    UPDATE public.stuck_pending_drain_state
    SET last_run_at = now(), last_cohort = v_cohort, consecutive_zero_runs = v_zero,
        last_note = format('stalled at %s left after 2 runs with no progress - unscheduled', v_cohort)
    WHERE id = 1;
    RETURN format('stalled: %s left, job unscheduled', v_cohort);
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  PERFORM net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 25, 'apply', true, 'newestFirst', true),
    timeout_milliseconds := 280000
  );

  UPDATE public.stuck_pending_drain_state
  SET last_run_at = now(), last_cohort = v_cohort, consecutive_zero_runs = v_zero,
      last_note = format('dispatched, %s in cohort, %s runs without progress', v_cohort, v_zero)
  WHERE id = 1;
  RETURN format('dispatched: %s in cohort', v_cohort);
END
$fn$;
REVOKE ALL ON FUNCTION public.drain_tick() FROM PUBLIC;

-- Schedule the tick, not the edge function. Every stop condition is now on the
-- same side of the wire as the scheduler that has to act on it.
DO $cron$
BEGIN
  PERFORM cron.unschedule('drain-stuck-pending-5m')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');
  PERFORM cron.schedule('drain-stuck-pending-5m', '3-58/5 * * * *',
                        'SELECT public.drain_tick();');
  RAISE NOTICE 'drain-stuck-pending-5m rescheduled to call drain_tick()';
END
$cron$;

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, jobname, schedule, active, command FROM cron.job
           WHERE jobname = 'drain-stuck-pending-5m' LOOP
    RAISE NOTICE 'job % | % | active % | %', r.jobid, r.schedule, r.active, r.command;
  END LOOP;
END
$p$;
