DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== did job 195 actually run? ==';
  FOR r IN SELECT runid, status, return_message, start_time, end_time
           FROM cron.job_run_details
           WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='drain-stuck-pending-5m')
           ORDER BY start_time DESC LIMIT 6 LOOP
    RAISE NOTICE '  % | % | % | %', r.start_time, rpad(r.status,10), r.runid,
      left(COALESCE(r.return_message,''), 140);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no run details at all)'; END IF;

  RAISE NOTICE '';
  FOR r IN SELECT jobid, jobname, schedule, active, username, command FROM cron.job
           WHERE jobname='drain-stuck-pending-5m' LOOP
    RAISE NOTICE '  job % runs as role "%" | % | active %', r.jobid, r.username, r.schedule, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== who owns drain_tick and who may execute it? ==';
  FOR r IN SELECT p.proname, pg_get_userbyid(p.proowner) AS owner,
                  COALESCE(array_to_string(p.proacl::text[], ' '), '(default: owner only after REVOKE)') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='drain_tick' LOOP
    RAISE NOTICE '  % owned by % | acl %', r.proname, r.owner, r.acl;
  END LOOP;
END
$p$;
