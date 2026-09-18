-- DRY RUN ONLY. Writes nothing to repricer data.
--
-- COG now outranks asin_cost_overrides (2026-09-18 00:45 deploy). Compared with the baseline in the next probe
-- before the hourly :40 run is allowed to use the new code.

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
    'triggered_by', 'cog-first-over-override-dry-run',
    'marketplaces', jsonb_build_array('US'),
    'dry_run', true,
    'time', now()::text
  ),
  timeout_milliseconds := 120000
) AS request_id;
