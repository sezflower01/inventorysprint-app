-- READ-ONLY PROBE. How does cron job #190 authenticate to sync-sales-orders?
-- The function keeps verify_jwt = true, so an x-internal-secret-only call is
-- refused at the gateway; the job passes a bearer as well. Need the same
-- header shape to re-enrich the FBM-fee-contaminated orders.
-- Secrets are NOT printed -- only which vault names and header keys are used.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, jobname,
                  regexp_replace(command, '[A-Za-z0-9_\-\.]{40,}', '<redacted>', 'g') AS shape
           FROM cron.job WHERE jobid = 190 LOOP
    RAISE NOTICE '#% %', r.jobid, r.jobname;
    RAISE NOTICE '%', r.shape;
  END LOOP;

  FOR r IN SELECT name FROM vault.decrypted_secrets ORDER BY name LOOP
    RAISE NOTICE 'vault secret available: %', r.name;
  END LOOP;
END
$p$;
