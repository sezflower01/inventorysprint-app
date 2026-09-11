-- Re-verify, for a support ticket, that the read-only-owned cron jobs cannot be
-- removed by any role available to this project.
--
-- The earlier record of this is from 2026-09-01 and a ticket should quote
-- CURRENT errors, not remembered ones. Each method is attempted inside its own
-- exception block so one failure does not abort the rest.
--
-- Attempted on jobid 13 (invoke-repricer-auto-turbo) as the representative
-- case. If any attempt unexpectedly SUCCEEDS, that is a good outcome: job 13 is
-- rejected on every run and its replacement (102, on the vault secret) already
-- does the work.

DO $verify$
DECLARE r record; v_err text; v_still boolean;
BEGIN
  RAISE NOTICE 'now: %  current_user=%  session_user=%', now(), current_user, session_user;

  RAISE NOTICE '';
  RAISE NOTICE '======== the jobs in question ========';
  FOR r IN
    SELECT jobid, jobname, schedule, username, active
    FROM cron.job WHERE username = 'supabase_read_only_user'
    ORDER BY jobid
  LOOP
    RAISE NOTICE '   jobid=%  %  %  owner=%  active=%',
      lpad(r.jobid::text,4), rpad(r.jobname,38), rpad(r.schedule,16), r.username, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== attempt 1: cron.unschedule(jobid) ========';
  BEGIN
    PERFORM cron.unschedule(13::bigint);
    RAISE NOTICE '   SUCCEEDED -- job 13 removed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '   FAILED: %', v_err;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== attempt 2: cron.unschedule(jobname) ========';
  BEGIN
    PERFORM cron.unschedule('invoke-repricer-auto-turbo');
    RAISE NOTICE '   SUCCEEDED -- job removed by name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '   FAILED: %', v_err;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== attempt 3: cron.alter_job(13, active := false) ========';
  BEGIN
    PERFORM cron.alter_job(13::bigint, active := false);
    RAISE NOTICE '   SUCCEEDED -- job 13 deactivated';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '   FAILED: %', v_err;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== attempt 4: UPDATE cron.job SET active = false ========';
  BEGIN
    UPDATE cron.job SET active = false WHERE jobid = 13;
    RAISE NOTICE '   SUCCEEDED -- row updated directly';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '   FAILED: %', v_err;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== attempt 5: DELETE FROM cron.job ========';
  BEGIN
    DELETE FROM cron.job WHERE jobid = 13;
    RAISE NOTICE '   SUCCEEDED -- row deleted directly';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '   FAILED: %', v_err;
  END;

  SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 13) INTO v_still;
  RAISE NOTICE '';
  RAISE NOTICE '   job 13 still scheduled after all five attempts: %', v_still;

  RAISE NOTICE '';
  RAISE NOTICE '======== rejected-call volume, last 3 hours ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE status_code = 401) AS unauthorized,
           count(*) AS total_requests
    FROM net._http_response WHERE created > now() - interval '3 hours'
  LOOP
    RAISE NOTICE '   % of % pg_net requests returned 401', r.unauthorized, r.total_requests;
  END LOOP;
END
$verify$;