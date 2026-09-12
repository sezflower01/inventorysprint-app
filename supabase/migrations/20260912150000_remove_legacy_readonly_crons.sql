-- Remove the eleven legacy cron jobs, now that Supabase has made them ours.
--
-- ---- BACKGROUND ---------------------------------------------------------
--
-- Support ticket SU-471332. These jobs were owned by supabase_read_only_user,
-- which Supabase says is the identity of the dashboard AI assistant -- so they
-- were most likely created through it, and no role available to us could
-- unschedule, alter or delete them (five methods tried, all refused, see
-- docs/supabase-support-cron-ownership.md). On 2026-09-12 Supabase reassigned
-- them to postgres.
--
-- Lesson recorded for next time: do not create cron jobs through the Supabase
-- AI assistant. It creates them as a role you cannot manage afterwards, and
-- you cannot prompt it to remove them either.
--
-- ---- WHY REMOVING ALL ELEVEN CHANGES NOTHING THAT RUNS ------------------
--
-- Every one authenticates with a hardcoded legacy anon JWT that stopped
-- matching the runtime SUPABASE_ANON_KEY when the project moved to the new key
-- format. Every invocation is rejected -- 742 of 2,881 pg_net requests over
-- three hours on 2026-09-11. None of them has done work in weeks, so removing
-- them removes only noise:
--
--   4, 13, 17, 18, 19   work carried by postgres-owned twins on the vault secret
--   9                   order enrichment arrives by another path
--   6                   repair-pending-prices: dead since 2026-06-11 and
--                       DELIBERATELY not revived -- it writes prices from the
--                       wrong source. Removing it keeps that decision.
--   23, 24, 25, 29      housekeeping (monitor snapshots + their cleanup, ghost
--                       listings, dead assignments). Rejected every run, and it
--                       was never confirmed whether a replacement exists. That
--                       question is unchanged by this migration -- they were
--                       already doing nothing -- and stays open.
--
-- ---- NOTHING IS LOST ----------------------------------------------------
--
-- Each definition is copied into public.cron_job_archive before it is
-- unscheduled, so any of them can be read back and recreated properly (on the
-- vault secret) if one turns out to be needed. The archive is locked down:
-- the commands carry a bearer token, public or not.
--
-- ---- SAFETY -------------------------------------------------------------
--
--   * matched on jobid AND expected jobname, so a reused id cannot take out
--     the wrong job;
--   * skipped, not forced, if Supabase's ownership change has not landed;
--   * every unschedule caught individually and reported, so one refusal
--     cannot abort the migration and block the queue behind it.

CREATE TABLE IF NOT EXISTS public.cron_job_archive (
  id          BIGSERIAL PRIMARY KEY,
  jobid       BIGINT      NOT NULL,
  jobname     TEXT,
  schedule    TEXT,
  command     TEXT,
  username    TEXT,
  active      BOOLEAN,
  reason      TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_job_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_job_archive FROM anon, authenticated;

COMMENT ON TABLE public.cron_job_archive IS
  'Definitions of cron jobs removed deliberately, kept so they can be read back and recreated. No policies: service role only.';

DO $remove$
DECLARE
  r            record;
  v_expected   jsonb := jsonb_build_object(
    '4',  'auto-sync-sales-every-10-minutes',
    '6',  'repair-pending-prices-every-15-min',
    '9',  'enrich-pending-orders-every-15-min',
    '13', 'invoke-repricer-auto-turbo',
    '17', 'repricer-sequential-sweep',
    '18', 'repricer-unified-dispatch',
    '19', 'repricer-unified-dispatch-worker-b',
    '23', 'monitor-snapshot-5min',
    '24', 'cleanup-monitor-snapshots-daily',
    '25', 'clean-ghost-listings-12h',
    '29', 'cleanup-dead-assignments-6h'
  );
  v_removed    int := 0;
  v_skipped    int := 0;
  v_failed     int := 0;
  v_ok         boolean;
BEGIN
  RAISE NOTICE 'now: %  current_user=%', now(), current_user;

  RAISE NOTICE '';
  RAISE NOTICE '======== ownership, as it stands ========';
  FOR r IN
    SELECT jobid, jobname, username, active
    FROM cron.job
    WHERE jobid IN (4, 6, 9, 13, 17, 18, 19, 23, 24, 25, 29)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid % | % | owner=% | active=%',
      lpad(r.jobid::text, 2), rpad(r.jobname, 36), r.username, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== removing ========';
  FOR r IN
    SELECT jobid, jobname, schedule, command, username, active
    FROM cron.job
    WHERE jobid IN (4, 6, 9, 13, 17, 18, 19, 23, 24, 25, 29)
    ORDER BY jobid
  LOOP
    IF r.jobname IS DISTINCT FROM (v_expected ->> r.jobid::text) THEN
      RAISE NOTICE '  jobid % SKIPPED: name is %, expected %',
        r.jobid, r.jobname, v_expected ->> r.jobid::text;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF r.username <> current_user THEN
      RAISE NOTICE '  jobid % SKIPPED: still owned by %, not %',
        r.jobid, r.username, current_user;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.cron_job_archive (jobid, jobname, schedule, command, username, active, reason)
      VALUES (r.jobid, r.jobname, r.schedule, r.command, r.username, r.active,
              'SU-471332: legacy anon-JWT job, rejected every run; ownership reassigned to postgres by Supabase 2026-09-12');

      SELECT cron.unschedule(r.jobid) INTO v_ok;
      IF v_ok THEN
        v_removed := v_removed + 1;
        RAISE NOTICE '  jobid % removed  (%)', lpad(r.jobid::text, 2), r.jobname;
      ELSE
        -- Undo the archive row too, so the archive only ever lists what is gone.
        RAISE EXCEPTION 'cron.unschedule returned false';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE NOTICE '  jobid % FAILED: %', r.jobid, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  removed=%  skipped=%  failed=%', v_removed, v_skipped, v_failed;

  RAISE NOTICE '';
  RAISE NOTICE '======== still scheduled from that list (should be none) ========';
  FOR r IN
    SELECT jobid, jobname, username FROM cron.job
    WHERE jobid IN (4, 6, 9, 13, 17, 18, 19, 23, 24, 25, 29)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid % % owner=%', r.jobid, r.jobname, r.username;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the twins that carry the real work (should be active) ========';
  FOR r IN
    SELECT jobid, jobname, schedule, active, username FROM cron.job
    WHERE jobid IN (102, 104, 105, 152, 178)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid % | % | % | active=% | owner=%',
      r.jobid, rpad(r.jobname, 38), r.schedule, r.active, r.username;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== anything else still owned by the read-only role ========';
  FOR r IN
    SELECT jobid, jobname FROM cron.job WHERE username = 'supabase_read_only_user'
  LOOP
    RAISE NOTICE '  jobid % %', r.jobid, r.jobname;
  END LOOP;
END
$remove$;
