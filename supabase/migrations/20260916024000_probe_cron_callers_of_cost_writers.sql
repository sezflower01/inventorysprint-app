-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Which ACTIVE cron jobs reach the functions that write min prices from cost?
-- Decides whether deploying their COG change moves floors on its own schedule
-- or only when the seller clicks.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           substring(j.command from 'functions/v1/([a-z0-9-]+)') AS fn,
           (SELECT max(d.start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run,
           (SELECT d.status FROM cron.job_run_details d WHERE d.jobid = j.jobid ORDER BY d.start_time DESC LIMIT 1) AS last_status
    FROM cron.job j
    WHERE j.command ~ 'functions/v1/(apply-min-roi|auto-assign-bulk|backfill-repricer-min-max|sync-inventory-report|sync-intl-marketplace|repricer-unified-dispatch|repricer-scheduler|repricer-cron-trigger|repricer-auto-lower-min|auto-activate-inbound-all|sync-amazon-inventory)'
    ORDER BY fn, j.jobname
  LOOP
    RAISE NOTICE '  #% % [%] active=% -> % | last % %', r.jobid, r.jobname, r.schedule, r.active, r.fn, r.last_run, r.last_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- auto-assign / auto-minmax settings that decide whether sync writes cost-based mins --';
  FOR r IN SELECT to_jsonb(s) - 'user_id' AS j FROM public.repricer_settings s LIMIT 3 LOOP
    RAISE NOTICE '  %', (SELECT string_agg(k || '=' || COALESCE(r.j->>k, 'null'), ', ')
                        FROM jsonb_object_keys(r.j) k WHERE k ~ '^auto_(assign_enabled|minmax_enabled|min_strategy|max_strategy|min_buffer_pct|require_cost)');
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE '  (repricer_settings not found: %)', SQLERRM;
END
$p$;
