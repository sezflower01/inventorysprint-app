-- READ-ONLY PROBE. Writes nothing. Safe to run repeatedly.
--
-- The Phase 2 gate: now that the three fan-out functions REQUIRE an internal
-- caller, are the scheduled jobs still getting in?
--
-- Phase 1 proved the jobs present the header. Phase 2 makes the functions
-- insist on it. Between those two facts sits the thing that can still go
-- wrong: the header reaching cron.job is not the same as the header reaching
-- the function. sync-sales-orders in particular answers 202 from a thin
-- wrapper and rebuilds the Request before the guard ever sees it, so a header
-- could be lost in transit and the only symptom would be a 403 nobody is
-- watching for.
--
-- WHAT CHANGES FROM THE PHASE 1 PROBE
--
-- A new status becomes meaningful. 401 is the GATEWAY refusing a bearer; 403
-- is the FUNCTION'S OWN guard refusing a caller. Phase 2 can only produce the
-- second. Distinguishing them tells you which change to revert -- and they
-- revert differently: a 403 means roll back the FUNCTIONS (git revert) and
-- leave the crons alone, because the crons are the part now known to be
-- correct.
--
-- Set v_cutover to when CI finished deploying the three functions. Rows before
-- it were served by the ungated code and prove nothing either way.

DO $$
DECLARE
  -- CI run 43341832903 finished 01:03:06; the three functions report
  -- updated_at 01:02:56, 01:02:59 and 01:03:03. Rounded up to the next whole
  -- minute: too EARLY a cutover would count pre-deploy 202s and manufacture a
  -- false PASS, so this errs late on purpose.
  v_cutover timestamptz := '2026-11-13 01:04:00+00';
  r         record;
  v_202     int := 0;
  v_403     int := 0;
  v_401     int := 0;
  v_other   int := 0;
  v_rows    int := 0;
  v_fired   int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '========= PHASE 2 GATE: do the jobs still get in? =========';
  RAISE NOTICE 'now:      %', now();
  RAISE NOTICE 'cutover:  % (functions deployed)', v_cutover;
  RAISE NOTICE 'elapsed:  %', age(now(), v_cutover);
  RAISE NOTICE '';

  IF now() < v_cutover + interval '12 minutes' THEN
    RAISE NOTICE '*** Less than 12 minutes since the deploy. The sales job fires';
    RAISE NOTICE '    every 5 minutes, so wait for three runs before trusting a';
    RAISE NOTICE '    verdict below. ***';
    RAISE NOTICE '';
  END IF;

  ------------------------------------------------------------------
  -- 1. Did the sales job fire since the deploy?
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. pg_cron dispatches since the deploy (liveness only) ---';
  FOR r IN
    SELECT d.start_time, d.status
      FROM cron.job j
      JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'auto-sync-sales-every-5-minutes'
       AND d.start_time >= v_cutover
     ORDER BY d.start_time DESC
     LIMIT 10
  LOOP
    v_fired := v_fired + 1;
    RAISE NOTICE '  % status=%', to_char(r.start_time, 'HH24:MI:SS'), r.status;
  END LOOP;
  RAISE NOTICE '  % dispatches since the cutover', v_fired;

  ------------------------------------------------------------------
  -- 2. The sales job's actual HTTP outcomes
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 2. sync-sales-orders responses since the deploy ---';
  RAISE NOTICE 'A 202 body says "Sync started in background". A 403 body is';
  RAISE NOTICE '{"error":"Forbidden"} -- that is OUR guard, not the gateway.';
  RAISE NOTICE '';
  FOR r IN
    SELECT created, status_code,
           left(regexp_replace(coalesce(content, error_msg, ''), '\s+', ' ', 'g'), 90) AS body
      FROM net._http_response
     WHERE created >= v_cutover
       AND (coalesce(content, '') ILIKE '%Sync started in background%'
            OR coalesce(content, '') ILIKE '%Forbidden%'
            OR coalesce(content, '') ILIKE '%sync_all_users%')
     ORDER BY created DESC
     LIMIT 12
  LOOP
    RAISE NOTICE '  % % | %', to_char(r.created, 'HH24:MI:SS'),
      rpad(coalesce(r.status_code::text, '-'), 5), r.body;
    IF    r.status_code = 202 THEN v_202 := v_202 + 1;
    ELSIF r.status_code = 403 THEN v_403 := v_403 + 1;
    ELSIF r.status_code = 401 THEN v_401 := v_401 + 1;
    ELSE  v_other := v_other + 1;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- 3. Everything else, so a refusal cannot hide behind the filter
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 3. every response since the deploy, unfiltered ---';
  FOR r IN
    SELECT created, status_code, timed_out,
           left(regexp_replace(coalesce(content, error_msg, '(empty)'), '\s+', ' ', 'g'), 100) AS body
      FROM net._http_response
     WHERE created >= v_cutover
     ORDER BY created DESC
     LIMIT 30
  LOOP
    v_rows := v_rows + 1;
    RAISE NOTICE '  % % to=% | %',
      to_char(r.created, 'HH24:MI:SS'),
      rpad(coalesce(r.status_code::text, '-'), 5),
      rpad(coalesce(r.timed_out::text, '-'), 5),
      r.body;
  END LOOP;
  IF v_rows = 0 THEN
    RAISE NOTICE '  (no rows -- pg_net prunes this table)';
  END IF;

  ------------------------------------------------------------------
  -- 4. Verdict
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 4. verdict ---';
  RAISE NOTICE '  202 accepted        : %', v_202;
  RAISE NOTICE '  403 OUR guard said no: %', v_403;
  RAISE NOTICE '  401 gateway said no  : %', v_401;
  RAISE NOTICE '  other                : %', v_other;
  RAISE NOTICE '';

  IF v_403 > 0 THEN
    RAISE NOTICE '  FAIL -- the function is refusing the job. The header is not';
    RAISE NOTICE '  arriving, even though Phase 1 proved the job sends it.';
    RAISE NOTICE '  Revert the FUNCTIONS, not the crons:';
    RAISE NOTICE '      git revert 938a139 && git push';
    RAISE NOTICE '  The crons are the part already proven correct; rolling them';
    RAISE NOTICE '  back instead would undo a working change and leave the';
    RAISE NOTICE '  functions still refusing them.';
  ELSIF v_401 > 0 THEN
    RAISE NOTICE '  FAIL -- but at the GATEWAY, not our guard, so this is not';
    RAISE NOTICE '  Phase 2. Suspect the retained bearer (it is the publishable';
    RAISE NOTICE '  key and it rotates). Roll back the crons:';
    RAISE NOTICE '      psql "$DATABASE_URL" -f scripts/rollback-cron-internal-secret.sql';
  ELSIF v_202 >= 3 THEN
    RAISE NOTICE '  PASS -- three or more accepted runs with the gate live.';
    RAISE NOTICE '  The fan-out now requires an internal caller and the scheduled';
    RAISE NOTICE '  job is still getting through.';
  ELSIF v_202 > 0 THEN
    RAISE NOTICE '  NOT YET -- % accepted so far. Wait for three.', v_202;
  ELSE
    RAISE NOTICE '  INCONCLUSIVE. If section 1 shows dispatches but section 3 is';
    RAISE NOTICE '  empty, pg_net pruned the rows -- re-read shortly. If section 1';
    RAISE NOTICE '  is empty too, the schedule is not firing, which is neither';
    RAISE NOTICE '  phase''s fault.';
  END IF;

  ------------------------------------------------------------------
  -- 5. Name the 30-second timeout
  --
  --    Asked after a timed-out response appeared at 01:00:01 with no
  --    owner. net._http_response carries no url and the request queue
  --    keeps only pending rows, so attribution has to be by time and
  --    by the timeout value the job itself sets. 29 functions have
  --    been given 30000 ms at some point, so the code alone cannot
  --    answer it -- only the live schedule can.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 5. whose timeouts are these? ---';
  v_rows := 0;
  FOR r IN
    WITH touts AS (
      SELECT id, created
        FROM net._http_response
       WHERE timed_out IS TRUE
         AND created > now() - interval '6 hours'
       ORDER BY created DESC
       LIMIT 12
    )
    SELECT t.created AS resp_at,
           j.jobname,
           j.schedule,
           substring(j.command from 'timeout_milliseconds\s*:?=\s*([0-9]+)') AS tmo_ms,
           d.start_time,
           t.created - d.start_time AS gap
      FROM touts t
      JOIN cron.job_run_details d
        ON d.start_time BETWEEN t.created - interval '310 seconds' AND t.created + interval '5 seconds'
      JOIN cron.job j ON j.jobid = d.jobid
     WHERE substring(j.command from 'timeout_milliseconds\s*:?=\s*([0-9]+)') IS NOT NULL
       -- the response arrives one timeout-length after dispatch, give or take
       AND abs(extract(epoch from (t.created - d.start_time)) * 1000
               - substring(j.command from 'timeout_milliseconds\s*:?=\s*([0-9]+)')::numeric) < 4000
     ORDER BY t.created DESC, gap
     LIMIT 20
  LOOP
    v_rows := v_rows + 1;
    RAISE NOTICE '  timeout at % <- % [%] tmo=%ms dispatched % (gap %)',
      to_char(r.resp_at, 'HH24:MI:SS'), rpad(r.jobname, 34), r.schedule,
      r.tmo_ms, to_char(r.start_time, 'HH24:MI:SS'), r.gap;
  END LOOP;

  IF v_rows = 0 THEN
    RAISE NOTICE '  No timed-out response could be matched to a job by timing.';
    RAISE NOTICE '  Either none occurred in the last 6 hours, or the matching';
    RAISE NOTICE '  window is too tight. Widen it, or list every job that fired';
    RAISE NOTICE '  in the same second and judge by hand:';
    RAISE NOTICE '    SELECT j.jobname, d.start_time FROM cron.job_run_details d';
    RAISE NOTICE '      JOIN cron.job j ON j.jobid = d.jobid';
    RAISE NOTICE '     WHERE d.start_time BETWEEN ''2026-11-13 00:59:25+00''';
    RAISE NOTICE '                            AND ''2026-11-13 01:00:05+00'';';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '  A timed-out response means pg_net stopped WAITING. The';
    RAISE NOTICE '  function kept running server-side, so this is a lost receipt,';
    RAISE NOTICE '  not necessarily lost work.';
  END IF;

  ------------------------------------------------------------------
  -- 6. The daily and weekly jobs
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 6. the two jobs this window cannot test ---';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           (j.command ILIKE '%x-internal-secret%') AS sends_secret,
           (SELECT max(d.start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_fire
      FROM cron.job j
     WHERE j.jobname IN ('auto-sync-dispositions-daily', 'auto-sync-settlements-weekly')
     ORDER BY j.jobname
  LOOP
    RAISE NOTICE '  % [%] active=% sends_secret=% last_fire=%',
      rpad(r.jobname, 30), rpad(r.schedule, 12), r.active, r.sends_secret,
      to_char(r.last_fire, 'MM-DD HH24:MI');
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '  Next: dispositions 08:15 UTC, settlements Monday 09:00 UTC.';
  RAISE NOTICE '  Re-run this probe after each. Neither sets a timeout, so a';
  RAISE NOTICE '  timed-out response for them is not evidence of refusal -- a';
  RAISE NOTICE '  403 body would be.';
  RAISE NOTICE '';
  RAISE NOTICE '========= END =========';
  RAISE NOTICE '';
END $$;
