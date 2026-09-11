-- PROBE (read-only): the request each suspect cron job actually sends.
--
-- Settles three things the guard reading left open:
--   78 sync-fbm-cleanup-all  -- exactly which headers and body it sends to a
--                               gate that rejects an anon bearer
--   88 inventory-valuation   -- does the body carry user_id? The target falls
--                               back to body.user_id when the bearer is not a
--                               user, so with it the anon bearer is harmless.
--   69 marketplace-sellab.   -- does it send mode=sweep? Only mode=scoped
--                               requires a user JWT.
--   77 sync-inventory-report -- same gate as 78, for comparison.
--
-- The hardcoded JWT is masked. Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname, schedule,
           left(
             regexp_replace(
               regexp_replace(command, 'eyJ[A-Za-z0-9_\-\.]+', '<JWT>', 'g'),
               '\s+', ' ', 'g'),
             700) AS cmd
    FROM cron.job WHERE jobid IN (78, 88, 69, 77)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '======== [%] % (%) ========', r.jobid, r.jobname, r.schedule;
    RAISE NOTICE '%', r.cmd;
    RAISE NOTICE '';
  END LOOP;
END
$probe$;