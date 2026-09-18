-- Pull new Amazon orders every 5 minutes instead of every 10.
--
-- ---- WHY ----------------------------------------------------------------
-- Seller report 2026-09-18: "mobile sales takes time to update numbers".
-- The Mobile Live Sales page re-reads the database every 5 s for Today and
-- Yesterday, so the page is not the delay. New orders reach sales_orders
-- through ONE job, auto-sync-sales-every-10-minutes-v2 (sync-sales-orders,
-- */10). Measured over the last 48 h (20260918030000): 176 orders, median
-- order -> row lag 6.2 min, p90 10.3 min -- i.e. waiting for the next tick.
-- Row created_at values sit on the :x0 marks (10:40:01, 08:10:03, 06:00:03).
--
-- ---- WHY 5 MINUTES IS SAFE -----------------------------------------------
--   * sync-sales-orders is incremental (orders since a stored marker), so a
--     shorter interval means smaller requests, not more work per order.
--   * Amazon getOrders allows ~1 request/min sustained; every 5 min is 0.2/min.
--   * No overlap lock exists, but runs are short: in the last 24 h 87 of 105
--     new-order inserts landed within 30 s of a tick and 12 more within 2 min
--     (20260918031000). The page's own sync kicks already overlap the cron
--     today without harm.
-- Expected: median lag ~3 min, p90 ~5-6 min.
--
-- ---- HOW ------------------------------------------------------------------
-- Offset to minutes 1,6,11,...,56 to stay off the :00/:x0 marks and the other
-- 5-minute jobs (check-seller-watchlist 2-57/5, classify-listing-brands
-- 4-59/5). The command is reused VERBATIM from the existing job, so auth
-- (x-internal-secret from Vault) and the body are unchanged. The old
-- definition is archived to cron_job_archive first. One transaction: if the
-- unschedule fails, the new schedule is rolled back too.

DO $m$
DECLARE
  v_old record;
  v_new_id bigint;
  r record;
BEGIN
  SELECT jobid, jobname, schedule, command, username, active INTO v_old
  FROM cron.job WHERE jobname = 'auto-sync-sales-every-10-minutes-v2';

  IF v_old.jobid IS NULL THEN
    RAISE EXCEPTION 'auto-sync-sales-every-10-minutes-v2 not found -- nothing changed';
  END IF;
  IF NOT v_old.active THEN
    RAISE EXCEPTION 'auto-sync-sales-every-10-minutes-v2 is inactive -- refusing to create an active replacement';
  END IF;
  RAISE NOTICE 'old: #% % [%] owner=%', v_old.jobid, v_old.jobname, v_old.schedule, v_old.username;

  INSERT INTO public.cron_job_archive (jobid, jobname, schedule, command, username, active, reason)
  VALUES (v_old.jobid, v_old.jobname, v_old.schedule, v_old.command, v_old.username, v_old.active,
          'Replaced by auto-sync-sales-every-5-minutes (1-56/5) on 2026-09-18: order lag median 6.2 min / p90 10.3 min at */10.');

  v_new_id := cron.schedule('auto-sync-sales-every-5-minutes', '1-56/5 * * * *', v_old.command);
  PERFORM cron.unschedule(v_old.jobid);

  RAISE NOTICE 'new: #% auto-sync-sales-every-5-minutes [1-56/5 * * * *] (same command)', v_new_id;

  FOR r IN SELECT jobid, jobname, schedule FROM cron.job
           WHERE active AND jobname <> 'auto-sync-sales-every-5-minutes'
             AND (schedule LIKE '1-56/5%' OR schedule LIKE '1,6,11%') LOOP
    RAISE NOTICE '  shares these minutes: #% % [%]', r.jobid, r.jobname, r.schedule;
  END LOOP;
END
$m$;
