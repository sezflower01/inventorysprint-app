-- READ-ONLY PROBE. Writes nothing. Safe to run repeatedly.
--
-- The Phase 1 gate: did the three jobs' new commands survive contact with the
-- gateway? Push this about fifteen minutes after Phase 1, so the five-minute
-- sales job has fired three times with the new command.
--
-- WHY net._http_response AND NOT pg_cron
--
-- cron.job_run_details reports "succeeded" as soon as net.http_post QUEUED
-- the request. It says nothing about what the other end answered. A 401 at
-- the Supabase gateway therefore looks exactly like a success in pg_cron --
-- which is how a stale bearer on this very job went unnoticed for months
-- (see 20260805155438). The HTTP status lives only in net._http_response.
--
-- WHY THE BODY IS MATCHED RATHER THAN THE URL
--
-- net._http_response carries no url column, and net.http_request_queue holds
-- only requests still pending, so a delivered response cannot be attributed
-- to a job by address. sync-sales-orders answers with a distinctive string,
-- so that is used instead -- the same technique as 20260918032500.
--
-- A 401 is attributed differently: the gateway's own refusals are short and
-- carry a code, and section 2 lists every recent response unfiltered so one
-- cannot hide behind the body filter.

DO $$
DECLARE
  r          record;
  v_n_202    int := 0;
  v_n_401    int := 0;
  v_n_other  int := 0;
  v_n_rows   int := 0;
  v_fired    int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '============ PHASE 1 GATE: did the new commands work? ============';
  RAISE NOTICE 'now: %', now();
  RAISE NOTICE '';

  ------------------------------------------------------------------
  -- 1. Did the sales job actually fire? (schedule liveness only)
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. pg_cron: did jobid 190 fire? (dispatch only, NOT acceptance) ---';
  FOR r IN
    SELECT d.start_time, d.status, left(coalesce(d.return_message, ''), 60) AS msg
      FROM cron.job j
      JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'auto-sync-sales-every-5-minutes'
       AND d.start_time > now() - interval '30 minutes'
     ORDER BY d.start_time DESC
     LIMIT 8
  LOOP
    v_fired := v_fired + 1;
    RAISE NOTICE '  % status=% %', to_char(r.start_time, 'HH24:MI:SS'), rpad(r.status, 10), r.msg;
  END LOOP;

  IF v_fired = 0 THEN
    RAISE NOTICE '  *** NO RUNS IN 30 MINUTES. The schedule itself is not firing --';
    RAISE NOTICE '      that is a different problem from a refused request. ***';
  ELSE
    RAISE NOTICE '  % dispatches in the last 30 minutes', v_fired;
  END IF;

  ------------------------------------------------------------------
  -- 2. Every recent HTTP response, unfiltered
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 2. net._http_response, last 25 minutes, nothing filtered out ---';
  RAISE NOTICE 'Any 401 here is the gateway refusing a bearer. Any 403 is a';
  RAISE NOTICE 'function''s own guard. Read these, not pg_cron''s status.';
  RAISE NOTICE '';
  FOR r IN
    SELECT created, status_code, timed_out,
           left(regexp_replace(coalesce(content, error_msg, '(empty)'), '\s+', ' ', 'g'), 110) AS body
      FROM net._http_response
     WHERE created > now() - interval '25 minutes'
     ORDER BY created DESC
     LIMIT 25
  LOOP
    v_n_rows := v_n_rows + 1;
    RAISE NOTICE '  % % timed_out=% | %',
      to_char(r.created, 'HH24:MI:SS'),
      rpad(coalesce(r.status_code::text, '-'), 5),
      rpad(coalesce(r.timed_out::text, '-'), 5),
      r.body;
  END LOOP;
  IF v_n_rows = 0 THEN
    RAISE NOTICE '  (no rows -- pg_net prunes this table, so an empty window is';
    RAISE NOTICE '   possible if nothing fired recently)';
  END IF;

  ------------------------------------------------------------------
  -- 3. The sales job specifically, by its distinctive answer
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 3. sync-sales-orders responses (matched on its own reply) ---';
  FOR r IN
    SELECT created, status_code,
           left(regexp_replace(coalesce(content, error_msg, ''), '\s+', ' ', 'g'), 90) AS body
      FROM net._http_response
     WHERE created > now() - interval '25 minutes'
       AND (coalesce(content, '') ILIKE '%Sync started in background%'
            OR coalesce(content, '') ILIKE '%sync_all_users%')
     ORDER BY created DESC
     LIMIT 10
  LOOP
    RAISE NOTICE '  % % | %', to_char(r.created, 'HH24:MI:SS'),
      rpad(coalesce(r.status_code::text, '-'), 5), r.body;
    IF r.status_code = 202 THEN v_n_202 := v_n_202 + 1;
    ELSIF r.status_code = 401 THEN v_n_401 := v_n_401 + 1;
    ELSE v_n_other := v_n_other + 1;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- 4. Verdict
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 4. verdict ---';
  RAISE NOTICE '  202 accepted : %', v_n_202;
  RAISE NOTICE '  401 refused  : %', v_n_401;
  RAISE NOTICE '  other        : %', v_n_other;
  RAISE NOTICE '';

  IF v_n_401 > 0 THEN
    RAISE NOTICE '  FAIL. The gateway refused the bearer. Roll back now:';
    RAISE NOTICE '    psql "$DATABASE_URL" -f scripts/rollback-cron-internal-secret.sql';
    RAISE NOTICE '  Do NOT ship Phase 2.';
  ELSIF v_n_202 >= 3 THEN
    RAISE NOTICE '  PASS. Three or more accepted runs with the new command.';
    RAISE NOTICE '  Phase 2 may ship.';
  ELSIF v_n_202 > 0 THEN
    RAISE NOTICE '  NOT YET. % accepted so far; wait for three and re-run this probe.', v_n_202;
  ELSE
    RAISE NOTICE '  INCONCLUSIVE. No identifiable sales response in the window.';
    RAISE NOTICE '  If section 1 shows dispatches but section 2 is empty, pg_net';
    RAISE NOTICE '  pruned the rows -- widen the interval and re-run. If section 1';
    RAISE NOTICE '  is also empty, the schedule is the problem, not the headers.';
  END IF;

  ------------------------------------------------------------------
  -- 5. The two jobs that cannot be tested in this window
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 5. the daily and weekly jobs ---';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           (SELECT max(d.start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_fire,
           (j.command ILIKE '%x-internal-secret%')       AS has_secret_header,
           (j.command ILIKE '%vault.decrypted_secrets%') AS reads_vault,
           (j.command ILIKE '%timeout_milliseconds%')    AS has_timeout
      FROM cron.job j
     WHERE j.jobname IN ('auto-sync-dispositions-daily', 'auto-sync-settlements-weekly')
     ORDER BY j.jobname
  LOOP
    RAISE NOTICE '  % [%] active=% secret=% vault=% timeout=% last_fire=%',
      rpad(r.jobname, 30), rpad(r.schedule, 12), r.active,
      r.has_secret_header, r.reads_vault, r.has_timeout,
      to_char(r.last_fire, 'MM-DD HH24:MI');
    IF NOT r.has_timeout THEN
      RAISE NOTICE '      no timeout_milliseconds -> pg_net''s 5s default, so its';
      RAISE NOTICE '      response may record as timed out even on a good run.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'These two build their headers from the same expression as the sales';
  RAISE NOTICE 'job, so a PASS above covers them. Their own next runs are 08:15 UTC';
  RAISE NOTICE 'and Monday 09:00 UTC.';
  RAISE NOTICE '';
  RAISE NOTICE '============ END ============';
  RAISE NOTICE '';
END $$;
