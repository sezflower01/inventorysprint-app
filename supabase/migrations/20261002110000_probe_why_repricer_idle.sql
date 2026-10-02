-- READ-ONLY PROBE. Credentials are now coherent and Amazon accepts every
-- pairing, but no price has been applied for 15+ minutes and the SP-API gate
-- has not been claimed for ~85 minutes. So the blocker has moved: the question
-- is no longer "are the credentials right" but "why is the repricer idle".
--
-- Candidates, in order of likelihood after an hour of failing calls:
--   1. assignments auto-suspended / disabled by the failure streak;
--   2. a stale cron lock left behind by a run that died mid-flight;
--   3. the dispatch cron not firing at all;
--   4. isolates still holding a cached dead-credential verdict.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== assignment population, US ==';
  FOR r IN SELECT is_enabled, manual_paused,
                  (auto_suspended_at IS NOT NULL) AS auto_suspended,
                  count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US'
           GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10 LOOP
    RAISE NOTICE '  enabled % | paused % | auto_suspended % : %', r.is_enabled, r.manual_paused, r.auto_suspended, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== anything auto-suspended or disabled in the last 2 hours? ==';
  FOR r IN SELECT COALESCE(auto_suspended_reason, last_disabled_reason, '(none)') AS reason,
                  count(*) AS n, max(COALESCE(auto_suspended_at, last_disabled_at)) AS newest
           FROM public.repricer_assignments
           WHERE user_id = v_uid
             AND COALESCE(auto_suspended_at, last_disabled_at) > now() - interval '2 hours'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % | newest %', left(r.reason, 120), r.n, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (nothing suspended or disabled in 2 h)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== failure streaks on enabled US assignments ==';
  FOR r IN SELECT consecutive_failures, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US' AND is_enabled = true
           GROUP BY 1 ORDER BY 1 DESC LIMIT 8 LOOP
    RAISE NOTICE '  consecutive_failures % : % assignment(s)', r.consecutive_failures, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== dispatch crons: are they even running? ==';
  FOR r IN SELECT j.jobid, j.jobname, d.status, d.start_time
           FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
           WHERE d.start_time > now() - interval '10 minutes'
             AND (j.jobname ILIKE '%dispatch%' OR j.jobname ILIKE '%turbo%' OR j.jobname ILIKE '%sequential%')
           ORDER BY d.start_time DESC LIMIT 12 LOOP
    RAISE NOTICE '  job % % | % | %', r.jobid, r.jobname, r.status, r.start_time;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NO dispatch cron runs in the last 10 minutes'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== stale cron locks? ==';
  FOR r IN SELECT job_name, status, started_at, finished_at, now() - started_at AS age
           FROM public.cron_run_history
           WHERE status NOT IN ('success', 'failed') AND started_at > now() - interval '6 hours'
           ORDER BY started_at DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | % | started % (% ago) | finished %', r.job_name, r.status, r.started_at, r.age, r.finished_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no in-flight cron rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== last dispatch / evaluation timestamps on enabled rows ==';
  FOR r IN SELECT max(last_dispatch_at) AS last_dispatch,
                  max(last_evaluated_at) AS last_eval,
                  max(last_applied_at) AS last_apply,
                  max(last_failure_at) AS last_failure
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US' AND is_enabled = true LOOP
    RAISE NOTICE '  dispatch % | eval % | apply % | failure %',
      r.last_dispatch, r.last_eval, r.last_apply, r.last_failure;
  END LOOP;
END
$p$;
