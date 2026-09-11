-- Fix the anon-bearer cron jobs that CAN be fixed (all owned by postgres).
-- Approved by the seller 2026-09-11.
--
-- Root cause, established by 20260911030000..035000: every hardcoded cron
-- bearer is the legacy anon JWT, and the runtime SUPABASE_ANON_KEY no longer
-- equals it (the project moved to new API keys). Guards that compared
-- bearer === anon key silently stopped matching.
--
-- The durable fix is the pattern already proven on 102/104/105/115/116/178:
-- read INTERNAL_SYNC_SECRET from the vault AT RUN TIME, inside the job, so the
-- secret is never stored in cron.job and no future key rotation can break it.
--
--   1. job 78 sync-fbm-cleanup-4h -> vault x-internal-secret.
--      Dead since 2026-08-15 20:45; sole writer of the merchant-listing FBM
--      sync and of ghost_source/ghosted_at. Its target's gate accepts the
--      secret first (okSecret). Dispatched once immediately below so the
--      whole chain -- including the per-user fan-out to sync-fbm-cleanup,
--      which uses the service-role bearer -- is verified now, not in 4 hours.
--
--   3. 102/104/105/115 -> timeout_milliseconds 30000.
--      These are WORKING jobs on pg_net's 5,000 ms default. About 9% of pg_net
--      requests lose 5s to DNS resolution on Supabase's side, flat across the
--      minute, and only 5s-budget jobs die of it: the repricer dispatchers and
--      the every-minute inventory refresh were losing about one run in six.
--      Commands are otherwise unchanged.
--
--   4. unschedule 77 and 96.
--      77 sync-inventory-report-4h: rejected by the same gate as 78, and its
--      work is superseded by the live_api inventory-refresh path (last real
--      bulk write April/May).
--      96 enrich-pending-orders-batch-150-booster: rejected every run by a
--      secret-or-user guard; enrichment continues via another path (2,252
--      attempts today).
--
-- Not touched: jobs owned by supabase_read_only_user (4, 6, 9, 13, 17, 18, 19,
-- 23, 25, 29). No available role can alter or remove them.

DO $fix$
DECLARE v_req bigint; v_secret_ok boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET')
    INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET is not in the vault; refusing to switch jobs to it';
  END IF;

  -- 1. job 78
  PERFORM cron.alter_job(78, command := $cmd$
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-fbm-cleanup-all',
      headers := (
        SELECT jsonb_build_object(
          'Content-Type', 'application/json',
          -- Vault secret read at run time. Replaces the legacy anon bearer,
          -- which stopped matching SUPABASE_ANON_KEY after the key rotation
          -- and left this job rejected from 2026-08-15 20:45.
          'x-internal-secret', decrypted_secret::text)
        FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
      ),
      body := jsonb_build_object('triggered_by', 'cron-sync-fbm-cleanup-4h'),
      timeout_milliseconds := 300000
    );
  $cmd$);
  RAISE NOTICE '1. job 78 now authenticates with the vault secret';

  -- 3. timeouts on the working every-minute jobs
  PERFORM cron.alter_job(102, command := $cmd$
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-auto-turbo',
      headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text)
                  FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
      body := concat('{"time": "', now(), '"}')::jsonb,
      -- 30s, not pg_net's 5s default: slow DNS on the Supabase side was
      -- killing about one run in six.
      timeout_milliseconds := 30000
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(104, command := $cmd$
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-unified-dispatch',
      headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text)
                  FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
      body := '{"scheduled": true}'::jsonb,
      timeout_milliseconds := 30000
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(105, command := $cmd$
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-unified-dispatch',
      headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text)
                  FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
      body := '{"scheduled": true, "worker_shard": "B"}'::jsonb,
      timeout_milliseconds := 30000
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(115, command := $cmd$
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/inventory-refresh-worker',
      headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text)
                  FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    ) AS request_id;
  $cmd$);
  RAISE NOTICE '3. jobs 102, 104, 105, 115 now allow 30s';

  -- 4. stop the two rejected, superseded jobs
  PERFORM cron.unschedule(77::bigint);
  PERFORM cron.unschedule(96::bigint);
  RAISE NOTICE '4. jobs 77 and 96 unscheduled';

  -- Verify job 78 now: one immediate run through the new command's own path.
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-fbm-cleanup-all',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text)
                FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := jsonb_build_object('triggered_by', 'manual-verify-after-fix'),
    timeout_milliseconds := 300000
  ) INTO v_req;
  RAISE NOTICE '   verification run of sync-fbm-cleanup-all dispatched, request id %', v_req;
END
$fix$;

DO $verify$
DECLARE r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== verify ========';
  FOR r IN
    SELECT jobid, jobname,
           (command ILIKE '%vault.decrypted_secrets%') AS vault,
           (command ~ 'eyJ[A-Za-z0-9_-]{10,}') AS legacy_jwt,
           substring(command FROM 'timeout_milliseconds\s*:=\s*([0-9]+)') AS timeout_ms
    FROM cron.job WHERE jobid IN (78, 102, 104, 105, 115) ORDER BY jobid
  LOOP
    RAISE NOTICE '   [%] % vault=% legacy_jwt=% timeout=%', r.jobid, rpad(r.jobname,38), r.vault, r.legacy_jwt, r.timeout_ms;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM cron.job WHERE jobid IN (77, 96)
  LOOP
    RAISE NOTICE '   jobs 77/96 remaining: %  (expected 0)', r.n;
  END LOOP;
END
$verify$;