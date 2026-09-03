-- Read-only: confirm the one-per-minute cadence is holding.
DO $$
DECLARE v_pending bigint; v_brand bigint; v_miss bigint; v_runs bigint;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NOT NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NULL)
    INTO v_pending, v_brand, v_miss FROM public.asin_brand_cache;
  SELECT count(*) INTO v_runs FROM cron.job_run_details d JOIN cron.job j USING (jobid)
   WHERE j.jobname='catalog-brand-backfill' AND d.start_time > now() - interval '5 minutes';
  RAISE NOTICE 'pending=% | with_brand=% no_brand=% | runs in last 5 min=%',
    v_pending, v_brand, v_miss, v_runs;
END $$;
