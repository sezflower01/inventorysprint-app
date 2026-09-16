-- READ-ONLY PROBE. Creates nothing, changes nothing. Prints secret NAMES only,
-- never values. repricer-ai-evaluate keeps verify_jwt = true, so a pg_net call
-- needs a service-role bearer in addition to x-internal-secret. Is one stored?

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT name, length(decrypted_secret) AS len FROM vault.decrypted_secrets ORDER BY name LOOP
    RAISE NOTICE '  % (length %)', r.name, r.len;
  END LOOP;
END
$p$;
