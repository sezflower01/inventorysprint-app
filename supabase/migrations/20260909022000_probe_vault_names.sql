-- PROBE (read-only): sync-sales-orders has verify_jwt = true at the platform,
-- so the gateway needs a real bearer as well as x-internal-secret -- the
-- two-header case CLAUDE.md describes for a cron worker calling a function the
-- browser also calls.
--
-- Find which vault entry holds a usable service-role key. Names only; no
-- secret values are printed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== vault secret names ========';
  FOR r IN
    SELECT name, length(decrypted_secret) AS len,
           left(decrypted_secret, 3) AS prefix,
           (decrypted_secret LIKE 'eyJ%') AS looks_like_jwt
    FROM vault.decrypted_secrets ORDER BY name
  LOOP
    RAISE NOTICE '   %  len=%  prefix=%  jwt=%',
      rpad(r.name, 34), r.len, r.prefix, r.looks_like_jwt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how do existing crons authenticate to this function? ========';
  FOR r IN
    SELECT jobname, left(command, 400) AS cmd
    FROM cron.job WHERE command ILIKE '%sync-sales-orders%' LIMIT 3
  LOOP
    RAISE NOTICE '   %', r.jobname;
    RAISE NOTICE '   %', r.cmd;
  END LOOP;
END
$probe$;
