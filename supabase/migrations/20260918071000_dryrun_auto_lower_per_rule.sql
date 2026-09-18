-- DRY RUN ONLY. Writes nothing to repricer data (dry runs also never stamp
-- auto_lower_min_last_run_at). First look at the deployed per-rule worker.

SELECT net.http_post(
  url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-auto-lower-min',
  headers := (
    SELECT jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', decrypted_secret::text)
    FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
  ),
  body := jsonb_build_object('triggered_by', 'per-rule-dry-run', 'dry_run', true, 'time', now()::text),
  timeout_milliseconds := 120000
) AS request_id;
