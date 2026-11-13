-- READ-ONLY. Writes nothing. Run it as often as you like.
--
-- The same check as migration 20261113011000, but re-runnable. That migration
-- has been applied, so `db push` will not run it again -- and the two jobs it
-- could not test fire daily (08:15 UTC) and weekly (Monday 09:00 UTC), which
-- is exactly when you need the check a second and third time.
--
--   psql "$DATABASE_URL" -f scripts/check-cron-internal-gate.sql
--
-- Or paste it into the SQL Editor. It takes no arguments: it looks at the
-- last 24 hours, which covers the daily job, and reports the weekly one's
-- most recent run whenever that was.
--
-- WHAT COUNTS AS FAILURE
--
--   403  our own guard refused the job -- the header is not arriving.
--        Revert the FUNCTIONS (git revert of the Phase 2 commit), not the
--        crons: the crons are the part already proven correct.
--   401  the GATEWAY refused -- not our guard. Suspect the retained bearer,
--        which is the publishable key and does rotate. Roll back the crons
--        with scripts/rollback-cron-internal-secret.sql.
--
-- pg_cron's own "succeeded" means the request was DISPATCHED and nothing
-- more. Read status_code.

DO $$
DECLARE
  r       record;
  v_202   int := 0;
  v_403   int := 0;
  v_401   int := 0;
  v_rows  int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '====== internal-caller gate: are the scheduled jobs getting in? ======';
  RAISE NOTICE 'now: %   window: last 24 hours', now();
  RAISE NOTICE '';

  ------------------------------------------------------------------
  -- 1. Anything refused, anywhere, in the last 24 hours
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. refusals (401 / 403) ---';
  FOR r IN
    SELECT created, status_code,
           left(regexp_replace(coalesce(content, error_msg, ''), '\s+', ' ', 'g'), 110) AS body
      FROM net._http_response
     WHERE created > now() - interval '24 hours'
       AND status_code IN (401, 403)
     ORDER BY created DESC
     LIMIT 20
  LOOP
    v_rows := v_rows + 1;
    IF r.status_code = 403 THEN v_403 := v_403 + 1; ELSE v_401 := v_401 + 1; END IF;
    RAISE NOTICE '  % % | %', to_char(r.created, 'MM-DD HH24:MI:SS'), r.status_code, r.body;
  END LOOP;
  IF v_rows = 0 THEN
    RAISE NOTICE '  NONE in 24 hours.';
  END IF;

  ------------------------------------------------------------------
  -- 2. The three guarded jobs, by their own replies
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 2. the three guarded jobs ---';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           (j.command ILIKE '%x-internal-secret%')       AS sends_secret,
           (j.command ILIKE '%vault.decrypted_secrets%') AS from_vault,
           d.last_fire,
           d.runs_24h
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT max(start_time) AS last_fire,
               count(*) FILTER (WHERE start_time > now() - interval '24 hours') AS runs_24h
          FROM cron.job_run_details x WHERE x.jobid = j.jobid
      ) d ON true
     WHERE j.jobname IN ('auto-sync-sales-every-5-minutes',
                         'auto-sync-dispositions-daily',
                         'auto-sync-settlements-weekly')
     ORDER BY j.jobname
  LOOP
    RAISE NOTICE '  % [%] active=% secret=% vault=% runs_24h=% last=%',
      rpad(r.jobname, 32), rpad(r.schedule, 12), r.active,
      r.sends_secret, r.from_vault, coalesce(r.runs_24h, 0),
      to_char(r.last_fire, 'MM-DD HH24:MI');
    IF NOT r.sends_secret THEN
      RAISE NOTICE '      *** this job no longer sends the secret -- the guard WILL refuse it ***';
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- 3. The sales job's replies, as the continuous canary
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 3. sync-sales-orders, last 30 minutes ---';
  FOR r IN
    SELECT created, status_code
      FROM net._http_response
     WHERE created > now() - interval '30 minutes'
       AND coalesce(content, '') ILIKE '%Sync started in background%'
     ORDER BY created DESC
     LIMIT 8
  LOOP
    v_202 := v_202 + 1;
    RAISE NOTICE '  % %', to_char(r.created, 'HH24:MI:SS'), r.status_code;
  END LOOP;
  RAISE NOTICE '  % accepted in the last 30 minutes (expect 5-6)', v_202;

  ------------------------------------------------------------------
  -- 4. Verdict
  ------------------------------------------------------------------
  RAISE NOTICE '';
  IF v_403 > 0 THEN
    RAISE NOTICE 'FAIL -- % refusal(s) from a function''s own guard.', v_403;
    RAISE NOTICE '  Revert the Phase 2 function commit; leave the crons alone.';
  ELSIF v_401 > 0 THEN
    RAISE NOTICE 'FAIL -- % refusal(s) at the gateway. Not our guard.', v_401;
    RAISE NOTICE '  psql "$DATABASE_URL" -f scripts/rollback-cron-internal-secret.sql';
  ELSIF v_202 = 0 THEN
    RAISE NOTICE 'INCONCLUSIVE -- no sales response in the last 30 minutes.';
    RAISE NOTICE '  Check section 2: if runs_24h is climbing, pg_net simply pruned';
    RAISE NOTICE '  the rows. If it is not, the schedule is the problem.';
  ELSE
    RAISE NOTICE 'PASS -- no refusals in 24 hours, and the sales job is still accepted.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'Note for the daily and weekly jobs: neither sets';
  RAISE NOTICE 'timeout_milliseconds, so they run on pg_net''s 5s default and their';
  RAISE NOTICE 'response can record as timed out even on a good run. For those two a';
  RAISE NOTICE 'timeout is NOT evidence of refusal -- only a 403 body is.';
  RAISE NOTICE '';
  RAISE NOTICE '====== END ======';
  RAISE NOTICE '';
END $$;
