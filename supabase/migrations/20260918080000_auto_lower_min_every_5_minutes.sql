-- Run repricer-auto-lower-min every 5 minutes; each rule decides its own pace.
--
-- The worker (deployed 2026-09-18, per-rule) processes a rule only when its
-- auto_lower_min_interval_minutes has passed since auto_lower_min_last_run_at,
-- so a 5-minute tick is what makes the 5..60-minute choices possible. Rules
-- carried over from the old hourly job are at 60 minutes, so nothing speeds up
-- until the seller picks a shorter interval.
--
-- Verified before this swap (20260918071000 .. 072800): dry runs of the new
-- worker against the old code's 19:40 real run -- 679 vs 636 considered (+43
-- listings added to the rules since the old flag was set), 6 lowers, all at or
-- above break-even at the COG, all on snapshots <= 88 min old; 61 listings
-- with competitor data up to 7.5 days old now skipped as stale.
--
-- Offset 3-58/5: clear of :00/:x0, the sales sync (1-56/5), seller watch
-- (2-57/5) and brand classification (4-59/5). Command reused verbatim; old
-- definition archived first; one transaction.

DO $m$
DECLARE v_old record; v_new_id bigint; r record;
BEGIN
  SELECT jobid, jobname, schedule, command, username, active INTO v_old
  FROM cron.job WHERE jobname = 'repricer-auto-lower-min-hourly';
  IF v_old.jobid IS NULL THEN RAISE EXCEPTION 'repricer-auto-lower-min-hourly not found -- nothing changed'; END IF;
  RAISE NOTICE 'old: #% % [%] owner=% active=%', v_old.jobid, v_old.jobname, v_old.schedule, v_old.username, v_old.active;

  INSERT INTO public.cron_job_archive (jobid, jobname, schedule, command, username, active, reason)
  VALUES (v_old.jobid, v_old.jobname, v_old.schedule, v_old.command, v_old.username, v_old.active,
          'Replaced by repricer-auto-lower-min-5min (3-58/5) on 2026-09-18: per-rule intervals; rules pace themselves.');

  v_new_id := cron.schedule('repricer-auto-lower-min-5min', '3-58/5 * * * *', v_old.command);
  PERFORM cron.unschedule(v_old.jobid);
  RAISE NOTICE 'new: #% repricer-auto-lower-min-5min [3-58/5 * * * *] (same command)', v_new_id;

  FOR r IN SELECT jobid, jobname, schedule FROM cron.job
           WHERE active AND jobname <> 'repricer-auto-lower-min-5min' AND schedule LIKE '3-58/5%' LOOP
    RAISE NOTICE '  shares these minutes: #% % [%]', r.jobid, r.jobname, r.schedule;
  END LOOP;
END
$m$;
