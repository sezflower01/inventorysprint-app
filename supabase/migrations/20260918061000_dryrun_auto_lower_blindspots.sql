-- DRY RUN ONLY. Writes nothing to repricer data.
-- Fresh auto-lower-min dry run, so the next probe can check each skip reason
-- ("no_inventory_row", "no_competitor_data") against what the tables hold.

SELECT net.http_post(
  url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-auto-lower-min',
  headers := (
    SELECT jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', decrypted_secret::text)
    FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
  ),
  body := jsonb_build_object('triggered_by', 'blindspot-dry-run', 'marketplaces', jsonb_build_array('US'), 'dry_run', true, 'time', now()::text),
  timeout_milliseconds := 120000
) AS request_id;
