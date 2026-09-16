-- DRY RUN ONLY. Writes nothing to repricer data.
--
-- Baseline for the COG change to repricer-auto-lower-min: ask the CURRENTLY
-- DEPLOYED (inventory.cost) version to decide every US row with dry_run=true.
-- The worker's dry-run path takes no lock and writes nothing; it returns every
-- decision in the response, which pg_net stores in net._http_response.
-- Same URL, auth and body shape as the hourly cron job, plus dry_run.

SELECT net.http_post(
  url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-auto-lower-min',
  headers := (
    SELECT jsonb_build_object(
      'Content-Type',      'application/json',
      'x-internal-secret', decrypted_secret::text
    )
    FROM vault.decrypted_secrets
    WHERE name = 'INTERNAL_SYNC_SECRET'
    LIMIT 1
  ),
  body := jsonb_build_object(
    'triggered_by', 'cog-change-baseline-dry-run',
    'marketplaces', jsonb_build_array('US'),
    'dry_run', true,
    'time', now()::text
  ),
  timeout_milliseconds := 120000
) AS request_id;
