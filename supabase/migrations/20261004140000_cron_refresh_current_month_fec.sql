-- Refresh the money side of Live Sales every 4 hours, not once a day.
--
-- MEASURED 2026-10-04 23:47 UTC, with nobody on any page:
--   newest sales_orders row      23:46:17   (48 seconds old)
--   newest financial_events_cache 06:20:09   (17 h 26 m old, 0 rows in 6 h)
--
-- The orders half is current -- cron 190 syncs every 5 minutes around the clock
-- and wrote rows in every single hour overnight. The MONEY half is not: fees,
-- refunds and settlement lines come from financial_events_cache, and the only
-- thing that refreshes it is prewarm-profit-loss-nightly (cron 176) at 06:20.
-- So Live Sales and the Sales Report show current units against money that can
-- be a full day behind, which reads exactly like "the numbers are not updating"
-- even while orders are landing every few minutes.
--
-- WHY NOT just run the nightly prewarm more often: it sweeps twelve months for
-- every credentialed user, budgets five minutes per month, and holds a one-hour
-- cron lock. Running that every four hours would spend hours of SP-API time to
-- refresh the one window anybody is looking at.
--
-- So this calls fetch-profit-loss directly for the CURRENT MONTH ONLY, with
-- forceRefresh so it actually pulls from Amazon rather than short-circuiting on
-- the cache. That is the same path the nightly uses for the current month, just
-- without the eleven months nobody is watching.
--
-- Scheduled at :35 past every fourth hour, deliberately off the existing marks
-- (:20 nightly prewarm, :37 order-gap backfill, :22 order status, 1-56/5 sales)
-- so quota-spending jobs do not burst together -- the staggering rule in
-- CLAUDE.md.

DO $cron$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  IF v_uid IS NULL THEN
    RAISE NOTICE 'user not found — job not created';
    RETURN;
  END IF;

  PERFORM cron.unschedule('pl-current-month-refresh-4h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pl-current-month-refresh-4h');

  PERFORM cron.schedule(
    'pl-current-month-refresh-4h',
    '35 */4 * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
        headers := (
          SELECT jsonb_build_object(
            'Content-Type', 'application/json',
            'x-internal-secret', decrypted_secret::text
          ) FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
        ),
        body := jsonb_build_object(
          'user_id', %L,
          'startDate', to_char(date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')), 'YYYY-MM-DD'),
          'endDate', to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD'),
          'forceRefresh', true
        ),
        timeout_milliseconds := 280000
      );
    $job$, v_uid)
  );

  RAISE NOTICE 'scheduled pl-current-month-refresh-4h at 35 */4 * * * for %', v_uid;
END
$cron$;

-- The dates are computed in Pacific on purpose: order_date is Pacific (Amazon
-- US default), so a month window built in UTC would include or exclude the
-- wrong day's orders for up to 8 hours either side of midnight.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname = 'pl-current-month-refresh-4h' LOOP
    RAISE NOTICE 'job % | % | % | active %', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
END
$p$;
