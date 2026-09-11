-- Reschedule repair-collapsed-orders-15min, now that it remembers its verdicts.
--
-- Apply ONLY after the repair function that writes collapsed_order_checks is
-- deployed. Rescheduling against the old function resumes the exact loop that
-- 20260911020000 paused: 23 runs, 1,149 SP-API calls, 0 repairs.
--
-- offset 0 is now correct. Every final verdict removes its row from the
-- shortlist, so the head of the list is always rows not yet settled. Paging was
-- the wrong fix for a list with no memory; memory is the right one.
--
-- TWO WAYS THE JOB REMOVES ITSELF:
--   1. The shortlist is empty -- the work is done.
--   2. It has stalled: nothing recorded for two hours while candidates remain.
--      Rows that are throttled, hit a transient error, or lack seller auth are
--      deliberately NOT recorded so they can retry. If every remaining row is
--      in that state for good, the job would otherwise run forever and bill the
--      shared Orders API quota for it -- which is the failure being fixed here,
--      in a different disguise.

DO $sched$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET not readable from vault';
  END IF;

  PERFORM cron.unschedule('repair-collapsed-orders-15min')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repair-collapsed-orders-15min');

  PERFORM cron.schedule(
    'repair-collapsed-orders-15min',
    '7,22,37,52 * * * *',
    format($job$
      DO $inner$
      DECLARE v_left int; v_uid uuid; v_last timestamptz; v_started timestamptz;
      BEGIN
        SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

        SELECT count(*) INTO v_left
        FROM public.collapsed_order_candidates(v_uid, 5000);

        IF v_left = 0 THEN
          PERFORM cron.unschedule('repair-collapsed-orders-15min');
          RETURN;
        END IF;

        -- Stall guard. v_started is when this schedule was created, so a fresh
        -- schedule gets its two hours before an empty checks table counts as a
        -- stall.
        SELECT max(checked_at) INTO v_last
        FROM public.collapsed_order_checks WHERE user_id = v_uid;
        SELECT %L::timestamptz INTO v_started;

        IF GREATEST(COALESCE(v_last, v_started), v_started) < now() - interval '2 hours' THEN
          PERFORM cron.unschedule('repair-collapsed-orders-15min');
          RETURN;
        END IF;

        PERFORM net.http_post(
          url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-internal-secret', %L
          ),
          body := jsonb_build_object(
            'user_id', v_uid, 'dry_run', false, 'limit', 50, 'offset', 0
          ),
          timeout_milliseconds := 150000
        );
      END
      $inner$;
    $job$, now()::text, v_secret)
  );

  RAISE NOTICE 'rescheduled repair-collapsed-orders-15min (7,22,37,52 past the hour)';
  RAISE NOTICE 'removes itself when the shortlist is empty, or after 2h with no new verdict';
END
$sched$;

DO $verify$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN
    SELECT jobname, schedule, active FROM cron.job
    WHERE jobname = 'repair-collapsed-orders-15min'
  LOOP
    RAISE NOTICE '   % | % | active=%', r.jobname, r.schedule, r.active;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP
    RAISE NOTICE '   shortlist at reschedule: %', r.n;
  END LOOP;
END $verify$;
