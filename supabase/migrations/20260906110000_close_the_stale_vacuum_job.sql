-- Close the vacuum job row that is stuck at 'running'.
--
-- The 2026-09-06 21:38:49 one-click VACUUM FULL never wrote a final status:
-- the edge function was killed by its own wall-clock limit, so the row has sat
-- at 'running' ever since. Verified from pg_stat_activity that nothing is
-- actually running -- no VACUUM, nothing in pg_stat_progress_cluster, no lock
-- held or waited on repricer_price_actions -- and the table is unchanged at
-- 7,022 MB with all 1,480,856 rows present.
--
-- admin-vacuum-full does not check for an existing running job, so this blocks
-- nothing. It is corrected because a maintenance log that says a destructive
-- operation is still in flight, hours after it died, is worse than no log:
-- the next person to look will either wait for it or be afraid to touch the
-- table.
--
-- Scoped to rows older than an hour so a genuinely in-flight vacuum, if one is
-- ever running when this applies, is left alone.

UPDATE public.database_maintenance_jobs
   SET status = 'failed',
       finished_at = now(),
       error_message = 'Edge function terminated by its wall-clock limit before '
                    || 'the vacuum completed; the backend was killed and the rewrite '
                    || 'aborted. Confirmed via pg_stat_activity that no vacuum was '
                    || 'running and no lock was held. Table unchanged at 7,022 MB, '
                    || '1,480,856 rows intact. Supabase auto-expanded the disk '
                    || '18 GB -> 27 GB because VACUUM FULL writes a full second '
                    || 'copy of the heap and every index before swapping.'
 WHERE action LIKE 'vacuum_full:%'
   AND status = 'running'
   AND started_at < now() - interval '1 hour';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT action, status, started_at, finished_at
    FROM public.database_maintenance_jobs
    WHERE action LIKE 'vacuum_full:%'
    ORDER BY started_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '   % | % | started % | finished %', r.action, r.status, r.started_at, r.finished_at;
  END LOOP;

  PERFORM public.evaluate_health_alerts();
END $$;
