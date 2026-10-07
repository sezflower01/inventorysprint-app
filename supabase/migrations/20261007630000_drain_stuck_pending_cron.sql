-- Drain the rest of the cohort on a schedule instead of by hand.
--
-- Firing batches back to back was a mistake: Amazon's getOrder restores at
-- 0.5 req/s, and overlapping runs competed for the same quota. The tallies
-- show it plainly -- http_429 of 26, then 49, 55, 47 as more batches piled on,
-- and the same order ids reappearing in consecutive batches because nothing
-- had been written yet to take them out of the queue.
--
-- A small batch every five minutes is slower in theory and much faster in
-- practice: 25 orders at 2.35s is under a minute of work inside a five minute
-- window, so the quota is never contended and nothing is retried for nothing.
-- ~208 orders left, so roughly an hour.
--
-- Scheduled at :03/:08/:13... deliberately off the existing marks -- :22 order
-- status, :20 nightly prewarm, :35 P&L refresh -- per the staggering rule in
-- CLAUDE.md.
--
-- TEMPORARY. Unschedule it once the cohort is empty; the follow-up migration
-- that verifies completion also removes it.

DO $cron$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN RAISE NOTICE 'no INTERNAL_SYNC_SECRET; job not created'; RETURN; END IF;

  PERFORM cron.unschedule('drain-stuck-pending-5m')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');

  PERFORM cron.schedule(
    'drain-stuck-pending-5m',
    '3-58/5 * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
        headers := (SELECT jsonb_build_object(
                      'Content-Type','application/json',
                      'x-internal-secret', decrypted_secret::text)
                    FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1),
        body := jsonb_build_object('limit', 25, 'apply', true, 'newestFirst', true),
        timeout_milliseconds := 280000
      );
    $job$)
  );
  RAISE NOTICE 'scheduled drain-stuck-pending-5m at 3-58/5 * * * *';
END
$cron$;

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname = 'drain-stuck-pending-5m' LOOP
    RAISE NOTICE 'job % | % | % | active %', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
END
$p$;
