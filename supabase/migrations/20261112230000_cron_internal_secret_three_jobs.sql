-- Phase 1 of 2: give three scheduled jobs the project's standard internal
-- caller credential, so that Phase 2 can require it in the functions they call.
--
-- ORDER IS LOAD-BEARING. The functions these jobs call currently accept any
-- caller the gateway admits, so adding a credential here changes nothing for
-- them and they keep running. Doing Phase 2 first would refuse the jobs as
-- they are and stop all three -- and two of them run daily and weekly, so
-- that would not be noticed for a day and a week respectively.
--
-- ── WHY THE EXISTING BEARER IS KEPT ──────────────────────────────────────
--
-- A first version of this migration built the gateway bearer from a
-- service-role key in the vault. It refused to run at preflight because that
-- key is not there, and putting it there was declined: a service-role key in
-- vault.decrypted_secrets is readable by anything that can read that view,
-- which is a large new exposure to buy one header.
--
-- So each job KEEPS the bearer it already has, taken from its own current
-- command, and gains x-internal-secret from the vault. The division of labour:
--
--   Authorization      satisfies the GATEWAY only. Any token it accepts will
--                      do; this one grants nothing by itself.
--   x-internal-secret  is what Phase 2 will actually check. This is the
--                      protection.
--
-- The bearer cannot simply be dropped. All three targets are verify_jwt = true,
-- so a request without Authorization is rejected by the gateway BEFORE the
-- function runs: no function log, no error row, just a job that silently never
-- executes. That is why job 78's pattern (secret only) does not transfer --
-- its target sync-fbm-cleanup-all is verify_jwt = false.
--
-- ── WHAT THIS DOES NOT FIX ───────────────────────────────────────────────
--
-- The retained bearer is the publishable key, and it rotates. If it is ever
-- rotated these jobs start failing at the gateway, silently, exactly as four
-- jobs did in September 2026. This migration does not address that; it is a
-- separate change (move the bearer to a vault read, or give the targets a
-- verify_jwt = false sibling). Recorded here so the next person does not
-- read the x-internal-secret header and conclude the fragility was handled.
--
-- Note the bearer is a VALID token today -- byte-identical to the current
-- publishable key -- so these three jobs work. This is a tightening, not a
-- repair, which is why the order above matters so much.
--
-- ── HANDLING OF THE TOKEN ────────────────────────────────────────────────
--
-- The bearer is read out of each job's own command into a local variable and
-- written back into the new command. It is never printed: every report about
-- it uses a short md5 prefix, which is what lets the migration prove the new
-- command carries the SAME token without ever showing it. The vault secret is
-- never read into a variable at all -- only its existence is checked.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ─────────────────────────────────────
--
-- Schedule, URL, body and timeout are preserved exactly, and the migration
-- ASSERTS the current command still contains the URL and body it expects
-- before replacing it. If a job has been altered since it was created, the
-- assertion fails, that job is left untouched, and its command is printed with
-- the token masked. Nothing here is inferred from this repo's history alone.
--
-- Two of the three carry no timeout_milliseconds and therefore run on pg_net's
-- 5,000 ms default. That is pre-existing and is NOT changed here, but it does
-- limit verification: see the note at the end.

BEGIN;

-- Rollback store. Written BEFORE anything is altered, so restoring is a copy
-- rather than a reconstruction. These commands contain the publishable key,
-- which ships in the browser bundle, but the table is locked down anyway on
-- the principle that a rollback store is not a reference.
CREATE TABLE IF NOT EXISTS public.archive_cron_commands_20261112 (
  jobname     text PRIMARY KEY,
  jobid       bigint      NOT NULL,
  schedule    text        NOT NULL,
  command     text        NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.archive_cron_commands_20261112 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.archive_cron_commands_20261112 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.archive_cron_commands_20261112 TO service_role;

DO $m$
DECLARE
  v_spec    record;
  v_job     record;
  v_new     text;
  v_bearer  text;          -- never printed; md5 prefix only
  v_changed int := 0;
  v_skipped int := 0;
  v_done    text[] := '{}';   -- only these are asserted on below
  v_hashes  jsonb   := '{}';  -- jobname -> md5 prefix of the bearer before
BEGIN
  ------------------------------------------------------------------
  -- 0. Preflight. The vault secret must exist before ANY job is
  --    touched. Existence only -- the value is never read into a
  --    variable, so it cannot surface in a NOTICE or an error.
  ------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'INTERNAL_SYNC_SECRET' AND btrim(decrypted_secret) <> ''
  ) THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET is absent or empty in the vault; refusing to point jobs at it';
  END IF;

  RAISE NOTICE 'preflight: INTERNAL_SYNC_SECRET present in the vault';
  RAISE NOTICE 'preflight: no service-role key is required by this variant';
  RAISE NOTICE '';

  ------------------------------------------------------------------
  -- 1. Rewrite each job's command.
  ------------------------------------------------------------------
  FOR v_spec IN
    SELECT * FROM (VALUES
      -- jobname, url, a fragment the body MUST still contain, body SQL, extra args
      ('auto-sync-sales-every-5-minutes',
       'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
       'sync_all_users',
       '''{"sync_all_users": true}''::jsonb',
       E',\n      timeout_milliseconds := 120000'),

      ('auto-sync-dispositions-daily',
       'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-sync-dispositions-daily',
       'daily-cron',
       'jsonb_build_object(''trigger'', ''daily-cron'', ''time'', now())',
       ''),

      ('auto-sync-settlements-weekly',
       'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-sync-settlements-weekly',
       'pg_cron',
       'jsonb_build_object(''triggeredBy'', ''pg_cron'', ''time'', now())',
       '')
    ) AS s(jobname, url, body_must_contain, body_sql, extra_args)
  LOOP
    SELECT jobid, jobname, schedule, command, active
      INTO v_job
      FROM cron.job
     WHERE jobname = v_spec.jobname;

    IF NOT FOUND THEN
      RAISE NOTICE 'SKIP % -- no such job (resolved by NAME; job ids are not stable here)', v_spec.jobname;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Refuse to touch a job whose command is not the one described above.
    IF position(v_spec.url in v_job.command) = 0
       OR position(v_spec.body_must_contain in v_job.command) = 0 THEN
      RAISE NOTICE 'SKIP % (jobid %) -- its command does not match what this migration expects.', v_spec.jobname, v_job.jobid;
      RAISE NOTICE '      current command, token masked:';
      RAISE NOTICE '      %', regexp_replace(
        regexp_replace(v_job.command, 'Bearer\s+[A-Za-z0-9._-]+', 'Bearer <masked>', 'g'),
        '\s+', ' ', 'g');
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Take the job's OWN bearer. Matches both header shapes in use here: a
    -- jsonb literal and a jsonb_build_object call.
    v_bearer := substring(v_job.command from 'Bearer\s+([A-Za-z0-9._-]+)');

    IF v_bearer IS NULL OR length(v_bearer) < 40 THEN
      RAISE NOTICE 'SKIP % (jobid %) -- no usable bearer found in its command, so there is', v_spec.jobname, v_job.jobid;
      RAISE NOTICE '      nothing to carry forward for the gateway. Read it by hand.';
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_hashes := v_hashes || jsonb_build_object(v_spec.jobname, left(md5(v_bearer), 8));

    -- Archive verbatim, once. A re-run must not overwrite the original with
    -- an already-rewritten command.
    INSERT INTO public.archive_cron_commands_20261112 (jobname, jobid, schedule, command)
    VALUES (v_job.jobname, v_job.jobid, v_job.schedule, v_job.command)
    ON CONFLICT (jobname) DO NOTHING;

    -- jsonb_build_object with a scalar subquery, NOT a subquery over
    -- vault.decrypted_secrets wrapping the whole object. The difference is the
    -- failure mode: if the secret is ever removed, this still produces a
    -- complete header set with a null secret, so the request reaches the
    -- function and is refused visibly with a status code in
    -- net._http_response. The wrapping form would yield NULL headers, the
    -- gateway would reject it, and the job would go quiet instead.
    v_new := format($cmd$
    SELECT net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        -- This job's own pre-existing bearer, carried forward unchanged.
        -- It satisfies the gateway, which rejects an unauthenticated request
        -- before the function runs; it grants nothing on its own.
        'Authorization', %L,
        -- The credential that actually authorises the call. Read from the
        -- vault at run time, so it is not stored in the schedule.
        'x-internal-secret',
          (SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1)
      ),
      body := %s%s
    ) AS request_id;
    $cmd$, v_spec.url, 'Bearer ' || v_bearer, v_spec.body_sql, v_spec.extra_args);

    -- Nested block: pg_cron enforces username = current_user inside
    -- alter_job, so a job owned by supabase_read_only_user cannot be altered
    -- by any role available here. Ten such jobs exist on this project. One
    -- unalterable job must not abort the other two, so the failure is caught
    -- and reported rather than raised.
    BEGIN
      PERFORM cron.alter_job(v_job.jobid, command := v_new);
      RAISE NOTICE 'OK   % (jobid %, %) keeps its bearer [md5 %] and gains the vault secret',
        rpad(v_spec.jobname, 32), v_job.jobid, v_job.schedule, left(md5(v_bearer), 8);
      v_changed := v_changed + 1;
      v_done    := v_done || v_spec.jobname;
    EXCEPTION WHEN OTHERS THEN
      -- SQLERRM is masked: some errors quote the offending statement back,
      -- and the statement here contains the bearer.
      RAISE NOTICE 'FAIL % (jobid %) could not be altered: % (%)',
        v_spec.jobname, v_job.jobid,
        regexp_replace(SQLERRM, 'Bearer\s+[A-Za-z0-9._-]+', 'Bearer <masked>', 'g'),
        SQLSTATE;
      RAISE NOTICE '      If this is an ownership error the job belongs to another';
      RAISE NOTICE '      role and must be recreated under one we hold, which is a';
      RAISE NOTICE '      separate decision -- it changes the job id.';
      v_skipped := v_skipped + 1;
    END;

    v_bearer := NULL;   -- do not let it outlive the iteration
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'changed %, skipped %', v_changed, v_skipped;

  IF v_changed = 0 THEN
    RAISE EXCEPTION 'no job was changed -- refusing to commit a migration that did nothing';
  END IF;

  ------------------------------------------------------------------
  -- 2. Verify the rewritten commands, without calling anything.
  --
  --    NOTE the inverted rule. In the service-role variant a surviving
  --    literal token meant failure. Here the token is deliberately
  --    retained, so the assertion is that it is STILL THERE and is the
  --    SAME ONE -- compared by hash, so it is never printed.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '--- verify: stored command shape ---';
  FOR v_job IN
    SELECT jobname, active, command,
           (command ILIKE '%x-internal-secret%')       AS has_secret_header,
           (command ILIKE '%vault.decrypted_secrets%') AS reads_vault,
           (command ILIKE '%Authorization%')           AS has_bearer_header,
           left(md5(coalesce(substring(command from 'Bearer\s+([A-Za-z0-9._-]+)'), '')), 8) AS bearer_md5
      FROM cron.job
     WHERE jobname IN ('auto-sync-sales-every-5-minutes',
                       'auto-sync-dispositions-daily',
                       'auto-sync-settlements-weekly')
     ORDER BY jobname
  LOOP
    RAISE NOTICE '  % active=% secret_header=% vault=% bearer=% md5=% %',
      rpad(v_job.jobname, 32), v_job.active, v_job.has_secret_header,
      v_job.reads_vault, v_job.has_bearer_header, v_job.bearer_md5,
      CASE WHEN v_job.jobname = ANY(v_done) THEN '' ELSE '  (not changed by this migration)' END;

    -- Assert only on jobs this run actually rewrote. A job that was skipped
    -- -- because its command did not match, or because another role owns it
    -- -- is still in its original state, and failing here would roll back the
    -- jobs that DID succeed.
    IF v_job.jobname = ANY(v_done) THEN
      IF NOT (v_job.has_secret_header AND v_job.reads_vault AND v_job.has_bearer_header) THEN
        RAISE EXCEPTION 'job % did not end up with both headers', v_job.jobname;
      END IF;
      IF v_job.bearer_md5 IS DISTINCT FROM (v_hashes ->> v_job.jobname) THEN
        RAISE EXCEPTION 'job %: the bearer in the new command is not the one it had (% vs %)',
          v_job.jobname, v_job.bearer_md5, (v_hashes ->> v_job.jobname);
      END IF;
    END IF;
  END LOOP;

  -- Prove the vault lookup the jobs now perform actually resolves, by running
  -- that exact scalar subquery. Length only; no value is printed.
  DECLARE
    v_len int;
  BEGIN
    SELECT length(decrypted_secret) INTO v_len
      FROM vault.decrypted_secrets
     WHERE name = 'INTERNAL_SYNC_SECRET'
     LIMIT 1;

    IF v_len IS NULL OR v_len < 8 THEN
      RAISE EXCEPTION 'the vault lookup used by the new commands does not resolve to a usable secret';
    END IF;

    RAISE NOTICE '';
    RAISE NOTICE '--- verify: the vault lookup resolves ---';
    RAISE NOTICE '  x-internal-secret will be % characters (value not shown)', v_len;
  END;

  RAISE NOTICE '';
  RAISE NOTICE 'Phase 1 complete. The functions still accept any caller, so all';
  RAISE NOTICE 'three jobs keep working. Do NOT ship Phase 2 until the sales job';
  RAISE NOTICE 'has been seen to return 202 three times with these new commands.';
  RAISE NOTICE '';
END
$m$;

COMMIT;

-- ── VERIFYING THE FIRST RUNS ─────────────────────────────────────────────
--
-- auto-sync-sales-every-5-minutes is the canary for all three: it fires on
-- '1-56/5 * * * *', so three runs take about fifteen minutes, and all three
-- commands build their headers the same way. If the sales job's requests are
-- accepted, the header shape is good everywhere.
--
--   SELECT r.created, r.status_code,
--          left(regexp_replace(coalesce(r.content, r.error_msg, ''), '\s+', ' ', 'g'), 120) AS body
--     FROM net._http_response r
--    WHERE r.created > now() - interval '20 minutes'
--    ORDER BY r.created DESC
--    LIMIT 20;
--
-- Expect 202 and "Sync started in background". A 401 means the gateway
-- refused the bearer; read status_code, NOT pg_cron's own status, which
-- reports success as soon as the request is DISPATCHED. That exact
-- distinction hid a 401 on this very job for months.
--
-- Caveat for the other two: they carry no timeout_milliseconds, so pg_net
-- abandons the response after its 5,000 ms default and _http_response can
-- record a timeout even on a successful run. That is pre-existing and is not
-- changed here. For those two, judge by their effects and function logs, or
-- raise their timeouts as a separate, deliberate change. Dispositions next
-- fires at 08:15 UTC, settlements on Monday at 09:00 UTC.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────
--
--   psql "$DATABASE_URL" -f scripts/rollback-cron-internal-secret.sql
--
-- It restores each command verbatim from the archive table, resolving jobs by
-- name rather than by the stored id in case a job has been recreated since.
-- Kept as a script and not a migration so that a routine `db push` for
-- something unrelated can never run it.
