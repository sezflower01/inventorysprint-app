-- INCIDENT: the database is unreachable (the CLI cannot even create its login
-- role: "Connection terminated due to connection timeout") and the seller
-- cannot log in, which fits -- Auth needs the database.
--
-- This migration removes the one continuously-running thing I added, FIRST,
-- before anything else. I do not know yet that repull-adjustments-2m is the
-- cause; I am removing it because it is mine, it fires every two minutes, and
-- the first move in an incident is to take your own changes out of the picture
-- rather than reason about whether they could be responsible.
--
-- What it does every tick: one net.http_post, a few small reads of
-- repull_schedule and repull_reports. Light on paper. But the edge function it
-- fires pages the Finances API for 60-90 seconds holding a connection, and
-- several runs have overlapped after pg_net dropped responses -- by the time
-- June had run five times, five such calls had been in flight across a few
-- minutes. Connection pressure is the plausible path from "my job" to "cannot
-- create a login role", and it is cheap to eliminate.
--
-- Named to sort BEFORE the RLS migration so it lands first if the database
-- comes back for only a moment.
DO $p$
DECLARE r record; v_found boolean := false;
BEGIN
  FOR r IN SELECT jobid, jobname FROM cron.job WHERE jobname = 'repull-adjustments-2m'
  LOOP
    v_found := true;
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'UNSCHEDULED [%] %', r.jobid, r.jobname;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE 'repull-adjustments-2m was already gone'; END IF;

  -- Leave the work list intact but parked, so nothing can pick it up if the
  -- job is ever re-created, and so the state is readable afterwards.
  UPDATE public.repull_schedule
  SET status = 'pending', req_id = NULL, fired_at = NULL,
      note = COALESCE(note || ' | ', '') || 'parked during the 2026-10-24 outage'
  WHERE status = 'fired';

  RAISE NOTICE '';
  RAISE NOTICE '== remaining cron jobs mentioning repull ==';
  FOR r IN SELECT jobid, jobname, active FROM cron.job WHERE jobname ILIKE '%repull%'
  LOOP RAISE NOTICE '   [%] % active %', r.jobid, r.jobname, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;
END
$p$;
