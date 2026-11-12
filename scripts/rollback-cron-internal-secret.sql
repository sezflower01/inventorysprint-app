-- Rollback for 20261112230000_cron_internal_secret_three_jobs.sql.
--
-- Restores each job's command exactly as it was before that migration, from
-- the verbatim copy taken before anything was altered. This is a copy, not a
-- reconstruction.
--
-- It is a SCRIPT, not a migration, deliberately: `supabase db push` applies
-- everything pending in one go, so a file in the migrations folder gets run by
-- a routine push for something unrelated, by someone not thinking about this
-- file. A rollback has to be chosen.
--
--   psql "$DATABASE_URL" -f scripts/rollback-cron-internal-secret.sql
--
-- Safe to run more than once. It restores only what the archive holds, so a
-- job the migration skipped is never touched.
--
-- After running it the jobs are back to presenting a bearer and nothing else,
-- which means Phase 2 MUST NOT be deployed (or must be reverted first) -- the
-- functions would refuse them. That is the whole reason the two phases are
-- separate and separately reversible.

DO $rollback$
DECLARE
  a         record;
  v_ok      int := 0;
  v_fail    int := 0;
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing FROM pg_tables
   WHERE schemaname = 'public' AND tablename = 'archive_cron_commands_20261112';

  IF v_missing = 0 THEN
    RAISE EXCEPTION 'archive_cron_commands_20261112 does not exist -- the migration never ran, so there is nothing to roll back';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== rolling back cron commands ========';

  FOR a IN
    SELECT jobname, jobid, schedule, command, archived_at
      FROM public.archive_cron_commands_20261112
     ORDER BY jobname
  LOOP
    -- Resolve by NAME. A job may have been recreated since the archive was
    -- taken, in which case the stored jobid is stale and using it would
    -- rewrite the wrong job -- or none.
    DECLARE
      v_live_id bigint;
    BEGIN
      SELECT jobid INTO v_live_id FROM cron.job WHERE jobname = a.jobname;

      IF v_live_id IS NULL THEN
        RAISE NOTICE 'SKIP % -- no live job by that name', a.jobname;
        v_fail := v_fail + 1;
        CONTINUE;
      END IF;

      IF v_live_id <> a.jobid THEN
        RAISE NOTICE 'NOTE % -- job id changed since the archive (% -> %); restoring by name',
          a.jobname, a.jobid, v_live_id;
      END IF;

      PERFORM cron.alter_job(v_live_id, command := a.command);
      RAISE NOTICE 'OK   % restored to its state at %', rpad(a.jobname, 32), a.archived_at;
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Masked: some errors quote the offending statement back, and the
      -- archived commands carry a bearer.
      RAISE NOTICE 'FAIL % -- % (%)', a.jobname,
        regexp_replace(SQLERRM, 'Bearer\s+[A-Za-z0-9._-]+', 'Bearer <masked>', 'g'),
        SQLSTATE;
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'restored %, failed/skipped %', v_ok, v_fail;
  RAISE NOTICE '';
  RAISE NOTICE '--- state now (token masked) ---';

  FOR a IN
    SELECT jobname,
           (command ILIKE '%x-internal-secret%')       AS has_secret_header,
           (command ILIKE '%vault.decrypted_secrets%') AS reads_vault,
           (command ~ 'ey[A-Za-z0-9_-]{8,}\.')         AS has_literal_token
      FROM cron.job
     WHERE jobname IN (SELECT jobname FROM public.archive_cron_commands_20261112)
     ORDER BY jobname
  LOOP
    RAISE NOTICE '  % secret_header=% vault=% literal_token=%',
      rpad(a.jobname, 32), a.has_secret_header, a.reads_vault, a.has_literal_token;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Expect secret_header=f vault=f literal_token=t for a full rollback.';
  RAISE NOTICE 'Confirm the next runs are accepted before walking away:';
  RAISE NOTICE '  SELECT created, status_code FROM net._http_response';
  RAISE NOTICE '   WHERE created > now() - interval ''20 minutes'' ORDER BY created DESC;';
  RAISE NOTICE '';
END
$rollback$;
