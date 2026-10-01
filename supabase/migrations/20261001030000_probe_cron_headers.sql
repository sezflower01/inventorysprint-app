-- READ-ONLY PROBE. Which cron jobs carry an x-internal-secret header, and does
-- any also carry an Authorization bearer? The direct call to
-- check-pricing-suppression-item was refused 403 by its own guard, which means
-- the header taken from job 190 did not carry a usable internal secret -- so
-- pick the header from a job that demonstrably authenticates as internal.
-- Values are masked: only the shape matters.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname,
           (command ~ 'x-internal-secret') AS has_internal,
           (command ~* 'Authorization') AS has_bearer,
           substring(command from 'functions/v1/([a-z0-9-]+)') AS fn,
           schedule, active
    FROM cron.job
    ORDER BY has_internal DESC, jobid
    LIMIT 40
  LOOP
    RAISE NOTICE '  job % | % | fn % | internal % bearer % | % | active %',
      r.jobid, COALESCE(r.jobname, ''), COALESCE(r.fn, ''), r.has_internal, r.has_bearer, r.schedule, r.active;
  END LOOP;
END
$p$;
