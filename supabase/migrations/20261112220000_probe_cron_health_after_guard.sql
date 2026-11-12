-- READ-ONLY PROBE. Writes nothing. Safe to run repeatedly.
--
-- Question: did the operator-credential guard, deployed to the sync family at
-- 2026-11-12 22:14 UTC, kill any scheduled job?
--
-- The guard can only ever produce ONE new outcome: a 200 response carrying
-- {error:'AMAZON_NOT_CONNECTED'} for an account that has no Amazon credentials
-- of its own and is not the operator. What matters is whether that outcome is
-- being reached for the OPERATOR -- which would mean the env lookup for
-- SPAPI_OWNER_USER_ID is wrong and the operator's own syncs have stopped.
--
-- This compares the window BEFORE the deploy with the window AFTER it, per
-- job, so a regression shows up as a change in the success rate rather than as
-- a count that has to be judged in isolation.

DO $$
DECLARE
  v_cutover   timestamptz := '2026-11-12 22:14:00+00';
  v_owner     uuid        := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  r           record;
  v_any       boolean := false;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ CRON HEALTH ACROSS THE GUARD DEPLOY ================';
  RAISE NOTICE 'cutover: % (deploy of the sync-family guard)', v_cutover;
  RAISE NOTICE 'now:     %', now();
  RAISE NOTICE 'elapsed since cutover: %', age(now(), v_cutover);
  RAISE NOTICE '';

  ------------------------------------------------------------------
  -- 1. cron_run_history: the jobs that wrap themselves in withCronLock
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. cron_run_history, equal windows either side of the deploy ---';
  RAISE NOTICE 'A job whose success rate is unchanged is unaffected. A job that';
  RAISE NOTICE 'ran before and has NOT run since may simply not be due yet --';
  RAISE NOTICE 'read next_due in section 3 before calling it dead.';
  RAISE NOTICE '';
  RAISE NOTICE '%', rpad('job_name', 42) || rpad('before', 26) || 'after';

  FOR r IN
    WITH win AS (
      SELECT
        job_name,
        COUNT(*) FILTER (WHERE started_at <  v_cutover
                           AND started_at >= v_cutover - (now() - v_cutover)) AS n_before,
        COUNT(*) FILTER (WHERE started_at <  v_cutover
                           AND started_at >= v_cutover - (now() - v_cutover)
                           AND status = 'success')                            AS ok_before,
        COUNT(*) FILTER (WHERE started_at >= v_cutover)                       AS n_after,
        COUNT(*) FILTER (WHERE started_at >= v_cutover AND status = 'success') AS ok_after,
        COUNT(*) FILTER (WHERE started_at >= v_cutover AND status = 'failed')  AS bad_after,
        MAX(started_at) FILTER (WHERE started_at >= v_cutover)                 AS last_after
      FROM public.cron_run_history
      WHERE started_at >= v_cutover - (now() - v_cutover) * 2
      GROUP BY job_name
    )
    SELECT * FROM win ORDER BY job_name
  LOOP
    v_any := true;
    RAISE NOTICE '%',
      rpad(r.job_name, 42)
      || rpad(r.ok_before || '/' || r.n_before || ' ok', 26)
      || r.ok_after || '/' || r.n_after || ' ok'
      || CASE WHEN r.bad_after > 0 THEN '   *** ' || r.bad_after || ' FAILED ***' ELSE '' END
      || CASE WHEN r.n_before > 0 AND r.n_after = 0 THEN '   (none since -- check next_due)' ELSE '' END;
  END LOOP;
  IF NOT v_any THEN
    RAISE NOTICE '(no cron_run_history rows in either window)';
  END IF;

  ------------------------------------------------------------------
  -- 2. Any failure text since the deploy, verbatim
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 2. failures since the deploy, verbatim ---';
  v_any := false;
  FOR r IN
    SELECT job_name, started_at, status, left(coalesce(error, '(none)'), 220) AS err
    FROM public.cron_run_history
    WHERE started_at >= v_cutover
      AND status NOT IN ('success', 'started')
    ORDER BY started_at DESC
    LIMIT 25
  LOOP
    v_any := true;
    RAISE NOTICE '  % % %', to_char(r.started_at, 'MM-DD HH24:MI'), rpad(r.job_name, 34), r.status;
    RAISE NOTICE '      %', r.err;
  END LOOP;
  IF NOT v_any THEN
    RAISE NOTICE '  NONE. No job recorded a non-success outcome after the deploy.';
  END IF;

  ------------------------------------------------------------------
  -- 3. pg_cron's own view: did the job even fire, and is it due?
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 3. pg_cron job_run_details for the sync jobs ---';
  RAISE NOTICE 'pg_cron reports "succeeded" when the HTTP call was DISPATCHED, not';
  RAISE NOTICE 'when the function succeeded -- so this section proves the schedule';
  RAISE NOTICE 'is alive, and section 1 proves the work happened.';
  RAISE NOTICE '';
  v_any := false;
  FOR r IN
    SELECT j.jobname,
           j.schedule,
           j.active,
           COUNT(d.*) FILTER (WHERE d.start_time >= v_cutover)                           AS fired_after,
           COUNT(d.*) FILTER (WHERE d.start_time >= v_cutover AND d.status = 'succeeded') AS ok_after,
           COUNT(d.*) FILTER (WHERE d.start_time >= v_cutover AND d.status = 'failed')    AS bad_after,
           MAX(d.start_time)                                                              AS last_fire
    FROM cron.job j
    LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.command ILIKE '%sync-sales-orders%'
       OR j.command ILIKE '%sync-amazon-inventory%'
       OR j.command ILIKE '%sync-fbm%'
       OR j.command ILIKE '%bulk-live-verify%'
       OR j.command ILIKE '%auto-sync%'
    GROUP BY j.jobname, j.schedule, j.active
    ORDER BY j.jobname
  LOOP
    v_any := true;
    RAISE NOTICE '  % sched=% active=% fired_since=% ok=% failed=% last=%',
      rpad(r.jobname, 36), rpad(r.schedule, 14), r.active,
      r.fired_after, r.ok_after, r.bad_after,
      to_char(r.last_fire, 'MM-DD HH24:MI:SS');
    IF r.bad_after > 0 THEN
      RAISE NOTICE '      *** pg_cron itself recorded a FAILED dispatch ***';
    END IF;
  END LOOP;
  IF NOT v_any THEN
    RAISE NOTICE '  (no matching cron jobs -- check the name filter)';
  END IF;

  ------------------------------------------------------------------
  -- 4. The one regression that would actually matter
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- 4. can the operator still be recognised as the operator? ---';
  RAISE NOTICE 'The guard allows the env token only for SPAPI_OWNER_USER_ID, and';
  RAISE NOTICE 'falls back to the admin role when that is unset. If BOTH were';
  RAISE NOTICE 'wrong the operator would be refused, and these are the two facts';
  RAISE NOTICE 'the guard reads. The env value is not visible from SQL, so this';
  RAISE NOTICE 'checks the fallback and the operator''s own credentials instead.';
  RAISE NOTICE '';

  PERFORM 1 FROM public.user_roles WHERE user_id = v_owner AND role = 'admin';
  IF FOUND THEN
    RAISE NOTICE '  admin role present for the operator: YES (fallback path would allow)';
  ELSE
    RAISE NOTICE '  admin role present for the operator: *** NO -- if SPAPI_OWNER_USER_ID';
    RAISE NOTICE '      is also unset or wrong, the operator is now REFUSED ***';
  END IF;

  FOR r IN
    SELECT
      (SELECT COUNT(*) FROM public.seller_authorizations
        WHERE user_id = v_owner AND is_active = true)        AS own_oauth_rows,
      (SELECT COUNT(*) FROM public.user_spapi_credentials
        WHERE user_id = v_owner)                             AS own_manual_rows
  LOOP
    RAISE NOTICE '  operator''s own credentials: seller_authorizations=% user_spapi_credentials=%',
      r.own_oauth_rows, r.own_manual_rows;
    IF r.own_oauth_rows > 0 OR r.own_manual_rows > 0 THEN
      RAISE NOTICE '      -> the operator resolves a token of their OWN and never';
      RAISE NOTICE '         reaches the guard at all. The guard cannot lock them out.';
    ELSE
      RAISE NOTICE '      -> the operator has NO credentials of their own, so every';
      RAISE NOTICE '         sync of theirs goes through the guard. The env id or the';
      RAISE NOTICE '         admin role is then load-bearing.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================ END ================';
  RAISE NOTICE '';
END $$;
