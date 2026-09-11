-- PROBE (read-only): exact commands for the jobs about to be changed, plus a
-- known-good vault-secret job to copy the pattern from.
--
-- Secrets are masked: hardcoded JWTs, and any 40+ char hex/base64 run that
-- could be a literal secret. The point of reading the working pattern is to
-- confirm whether it reads the vault AT RUN TIME (secret never stored in
-- cron.job) or bakes the value into the command text.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname, schedule, username, active,
           left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(command, 'eyJ[A-Za-z0-9_\-\.]+', '<JWT>', 'g'),
                 '[A-Fa-f0-9]{40,}', '<HEX-SECRET>', 'g'),
               '\s+', ' ', 'g'),
             900) AS cmd,
           (command ~ '[A-Fa-f0-9]{40,}') AS has_literal_hex,
           (command ILIKE '%vault.decrypted_secrets%') AS reads_vault_at_runtime
    FROM cron.job
    WHERE jobid IN (6, 77, 78, 96, 102, 104, 105, 115, 178, 116, 187)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '======== [%] % (%) owner=% active=% ========', r.jobid, r.jobname, r.schedule, r.username, r.active;
    RAISE NOTICE '   reads vault at runtime: %  | literal hex secret in command: %', r.reads_vault_at_runtime, r.has_literal_hex;
    RAISE NOTICE '%', r.cmd;
    RAISE NOTICE '';
  END LOOP;

  RAISE NOTICE '======== any OTHER job with a literal hex secret in its command? ========';
  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE command ~ '[A-Fa-f0-9]{40,}' AND jobid NOT IN (6, 77, 78, 96, 102, 104, 105, 115, 178, 116, 187)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '   [%] %', r.jobid, r.jobname;
  END LOOP;
END
$probe$;