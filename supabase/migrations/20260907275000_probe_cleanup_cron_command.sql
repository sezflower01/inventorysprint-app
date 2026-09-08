-- PROBE (read-only): cleanup-dead-assignments has NO entry in config.toml, so
-- it defaults to verify_jwt = true. If its pg_cron command sends only
-- x-internal-secret and no Authorization bearer, the Supabase gateway rejects
-- the call before the function runs -- no function log, no error, and pg_cron
-- still records "succeeded". That is the exact trap CLAUDE.md documents.
--
-- Read the command text and the last run results to settle it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== the cron command ========';
  FOR r IN
    SELECT jobid, jobname, schedule, active, command
    FROM cron.job WHERE command ILIKE '%dead-assign%'
  LOOP
    RAISE NOTICE '   jobid=% % (%) active=%', r.jobid, r.jobname, r.schedule, r.active;
    RAISE NOTICE '   sends Authorization bearer? %',
      CASE WHEN r.command ILIKE '%authorization%' THEN 'YES' ELSE 'NO  <- gateway will reject' END;
    RAISE NOTICE '   sends x-internal-secret?     %',
      CASE WHEN r.command ILIKE '%internal-secret%' THEN 'YES' ELSE 'NO' END;
    RAISE NOTICE '   --- command ---';
    RAISE NOTICE '%', left(r.command, 1200);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what pg_cron thinks happened ========';
  FOR r IN
    SELECT d.status, count(*) AS runs, max(d.start_time) AS latest
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.command ILIKE '%dead-assign%'
      AND d.start_time > now() - interval '7 days'
    GROUP BY 1 ORDER BY latest DESC
  LOOP
    RAISE NOTICE '   status=% runs=% latest=%', r.status, r.runs, r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the HTTP response the last runs actually got ========';
  BEGIN
    FOR r IN
      SELECT rr.status_code, left(rr.content::text, 220) AS body, rr.created
      FROM net._http_response rr
      ORDER BY rr.created DESC LIMIT 12
    LOOP
      RAISE NOTICE '   % | % | %', r.created, r.status_code, r.body;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (net._http_response unreadable: %)', SQLERRM;
  END;
END
$probe$;
