-- Finish the sweep on a schedule instead of by hand.
--
-- 348 rows remain and the repair now paces itself at Amazon's real Orders API
-- rate -- about 0.5 requests/second -- so a run covers roughly 50 candidates
-- inside its 110s budget. Seven or eight runs finishes the list.
--
-- Every 15 minutes rather than continuously, for two reasons. The Orders API
-- quota is account-wide and shared with sync-sales-orders, so this must be a
-- background tenant of that budget and not a competitor for it. And the
-- shortlist recomputes each run, so spacing the runs lets the per-ASIN fee
-- medians settle after each pass rather than shifting mid-sweep.
--
-- The job removes ITSELF once the shortlist is empty. A repair cron that
-- outlives the damage it was written for is just a standing tax on the SP-API
-- budget, and this repo already carries four dead crons nobody can unschedule.

DO $sched$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  PERFORM cron.unschedule('repair-collapsed-orders-15min')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repair-collapsed-orders-15min');

  PERFORM cron.schedule(
    'repair-collapsed-orders-15min',
    '7,22,37,52 * * * *',
    format($job$
      DO $inner$
      DECLARE v_left int; v_uid uuid;
      BEGIN
        SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
        SELECT count(*) INTO v_left
        FROM public.collapsed_order_candidates(v_uid, 5000);

        IF v_left = 0 THEN
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
    $job$, v_secret)
  );

  RAISE NOTICE 'scheduled repair-collapsed-orders-15min (7,22,37,52 past the hour)';
  RAISE NOTICE 'it unschedules itself when the shortlist reaches zero';
END
$sched$;

DO $verify$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobname, schedule, active FROM cron.job
    WHERE jobname = 'repair-collapsed-orders-15min'
  LOOP
    RAISE NOTICE '   % | % | active=%', r.jobname, r.schedule, r.active;
  END LOOP;
END $verify$;
