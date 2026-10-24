-- APPROVED CHANGES 1 and 2. Change 3 cannot be done from SQL -- see the note
-- at the bottom.
--
-- ---------------------------------------------------------------------------
-- A CORRECTION TO THE DIAGNOSIS THIS IS BASED ON
-- ---------------------------------------------------------------------------
-- I reported the 2026-10-24 12:33 outage as background-worker-slot starvation,
-- max_worker_processes = 6 against cron.max_running_jobs = 32. That mechanism
-- is WRONG, and the setting that disproves it is:
--
--     cron.use_background_workers = off
--
-- With that off, pg_cron does not use background workers at all. It opens a
-- libpq connection per job to cron.host. So max_worker_processes was never the
-- limit for these jobs, and raising it would not have prevented the outage.
--
-- What the evidence still supports, unchanged: the pg_cron scheduler froze for
-- 677.4 seconds from 12:33:00 and processed all thirteen timeouts at 12:44:18,
-- with "job startup timeout" -- a failure to START a job, not a slow query.
-- The database itself was healthy throughout (26 jobs succeeded at 12:30:01,
-- avg_query_ms_5m never moved, connections peaked at 21 of 90). Login failing
-- in the same window is consistent with new connections not being accepted.
-- The remaining candidates are connection/backend startup and a Supabase-side
-- instance event, neither of which this database records.
--
-- The two changes below stand on their own merits regardless: they are
-- measured waste. They are not presented as a fix for the outage.
-- ---------------------------------------------------------------------------


-- ---- CHANGE 1: stop seller-catalog-queue-topup -----------------------------
-- 72 of 72 runs in 24h failed, every one at exactly 120.0 s with
-- "canceling statement due to statement timeout". 8,643 seconds a day spent
-- achieving nothing, three times an hour. Deactivated rather than unscheduled
-- so the definition survives for whoever fixes topup_seller_catalog_queue:
--   SELECT cron.alter_job(185, active => true);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'seller-catalog-queue-topup'),
  active => false
);


-- ---- CHANGE 2: make the slow-query sampler cheap ---------------------------
-- Two problems, both measured over the 110,622 rows it has collected:
--
--   36.4% (40,244 rows) are idle Realtime WAL senders. These are not queries.
--         A walsender parked on Client/WalSenderWaitForWAL has a query_start
--         from when replication began -- days ago -- so it trips any duration
--         threshold forever. One row showed a "duration" of 272,634 seconds.
--         This is what made my own top-offenders table read 2.1 billion
--         seconds and be worthless.
--
--   55.2% (61,043 rows) are pg_cron. Most of those are the net.http_post
--         wrapper, which is noise.
--
-- A DELIBERATE DEPARTURE from what I proposed: I said filter out pg_cron, and
-- I am NOT doing that wholesale. Excluding pg_cron entirely would have hidden
-- the seller-catalog-queue-topup timeouts above -- exactly the kind of finding
-- this sampler exists for. So only the net.http_post wrapper is excluded, and
-- real cron SQL still gets recorded.
--
-- Also: backend_type is the correct way to exclude walsenders, not a
-- wait_event match. A walsender that happens to be actively streaming has a
-- different wait_event but is still not a query.
CREATE OR REPLACE FUNCTION public.capture_slow_queries(
  p_min_ms       int     DEFAULT 3000,
  p_samples      int     DEFAULT 4,
  p_gap_seconds  numeric DEFAULT 4
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_captured int := 0;
  v_this     int;
  i          int;
BEGIN
  FOR i IN 1..p_samples LOOP
    INSERT INTO public.slow_query_samples
      (pid, usename, application_name, client_addr, state,
       wait_event_type, wait_event, query_start, duration_ms, query)
    SELECT a.pid, a.usename, a.application_name, a.client_addr, a.state,
           a.wait_event_type, a.wait_event, a.query_start,
           EXTRACT(epoch FROM (clock_timestamp() - a.query_start)) * 1000,
           left(a.query, 4000)
    FROM pg_stat_activity a
    WHERE a.pid <> pg_backend_pid()
      AND a.state IS DISTINCT FROM 'idle'
      AND a.query_start IS NOT NULL
      AND clock_timestamp() - a.query_start > make_interval(secs => p_min_ms / 1000.0)
      -- Only real client backends. Excludes walsenders (replication), the
      -- autovacuum launcher, the checkpointer and friends: none of them is
      -- running a query that a statement_timeout could kill.
      AND a.backend_type = 'client backend'
      -- pg_cron's http wrapper only. Real cron SQL is still captured.
      AND COALESCE(a.query, '') NOT ILIKE '%net.http_post%';

    GET DIAGNOSTICS v_this = ROW_COUNT;
    v_captured := v_captured + v_this;

    IF i < p_samples THEN
      PERFORM pg_sleep(p_gap_seconds);
    END IF;
  END LOOP;

  DELETE FROM public.slow_query_samples
   WHERE sampled_at < now() - interval '7 days';

  RETURN v_captured;
END $$;

REVOKE ALL ON FUNCTION public.capture_slow_queries(int, int, numeric) FROM PUBLIC;

-- Every minute -> every five. The 12.5 s per run is almost entirely pg_sleep:
-- four samples with 4 s gaps. At */5 the same four-sample burst still catches a
-- statement that starts on a minute boundary and dies ~15 s later, because the
-- burst still begins on a minute boundary. Cost falls from 0.207 of a
-- connection held continuously to about 0.04.
DO $$
BEGIN
  PERFORM cron.unschedule('capture-slow-queries-1m');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture-slow-queries-5m',
  '*/5 * * * *',
  $cron$SELECT public.capture_slow_queries();$cron$
);


-- ---- CHANGE 3: not possible from here --------------------------------------
-- cron.max_running_jobs has context 'postmaster'. It cannot be lowered by
-- ALTER SYSTEM + reload; it needs a restart, exactly like
-- max_worker_processes. Both therefore belong in the one dashboard change
-- already planned, and ALTER SYSTEM is not attempted here because it cannot
-- run inside the transaction a migration uses.
--
-- On staggering the eleven every-minute jobs: pg_cron schedules at minute
-- granularity, so eleven jobs on '* * * * *' necessarily fire on the same
-- second. There is no offset to give them. The only way to separate them is to
-- halve their frequency with alternating offsets ('*/2' and '1-59/2'), and
-- that would slow repricer dispatch -- a product decision, not a tuning one,
-- so it is not done unilaterally.
--
-- The measurements also say it is not needed. p95 duration for ten of the
-- eleven is between 0.09 s and 0.18 s. The eleventh was the sampler at 12 s,
-- which change 2 just moved off the every-minute slot. The burst those eleven
-- jobs create is now about 1.5 connection-seconds per minute.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== verification ==';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname IN ('seller-catalog-queue-topup','capture-slow-queries-1m',
                      'capture-slow-queries-5m')
    ORDER BY jobname
  LOOP RAISE NOTICE '   [%] % | % | active %', r.jobid, rpad(r.jobname,28), rpad(r.schedule,14), r.active; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the filter, tested against what is running right now ==';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE backend_type <> 'client backend') AS non_client,
           count(*) FILTER (WHERE COALESCE(query,'') ILIKE '%net.http_post%') AS http_wrapper,
           count(*) FILTER (WHERE backend_type = 'client backend'
                              AND COALESCE(query,'') NOT ILIKE '%net.http_post%') AS would_keep
    FROM pg_stat_activity WHERE state IS DISTINCT FROM 'idle' AND query_start IS NOT NULL
  LOOP
    RAISE NOTICE '   % active now | % non-client-backend | % http wrapper | % would still be sampled',
      r.total, r.non_client, r.http_wrapper, r.would_keep;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every-minute jobs remaining after change 2 ==';
  FOR r IN SELECT count(*) AS n FROM cron.job
           WHERE schedule IN ('* * * * *','*/1 * * * *') AND active
  LOOP RAISE NOTICE '   % (was 11)', r.n; END LOOP;
END
$p$;
