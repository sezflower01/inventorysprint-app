-- catchup-fba-shipments-weekly has been failing every run since 2026-09-01.
--
-- ── HOW IT WAS FOUND ──────────────────────────────────────────────────────
--
-- Reported 2026-11-17 from /tools/unshipped-purchases, which showed every
-- October 2026 purchase as "Shipped —" and said so out loud:
--
--   "The newest shipment on record is dated 2026-10-01 (history runs from
--    2021-07-26), and the most recent one was first synced 2026-10-02.
--    439 of 2112 shipments carry no usable Amazon date."
--
-- Six weeks of shipments missing, and 2026-10-02 is a Friday -- this job fires
-- on Sundays, so that last write was almost certainly a hand-pressed "Sync
-- Missing (18mo)" in the UI, not the cron. The cron's last real contribution
-- was earlier still.
--
-- ── WHY IT FAILED: TWO DEFECTS, EITHER ONE FATAL ──────────────────────────
--
-- 20260704022227 had the job fan out one POST per user straight at
-- sync-fba-shipments with { user_id, lookbackDays: 540, headersOnly: true }.
-- That worked.
--
-- 20260901160000 then repaired that job's missing gateway bearer -- correctly
-- diagnosed -- but rewrote the whole command and reduced the body to
-- { triggered_by: ... }. Two things broke at once:
--
--   1. NO user_id. sync-fba-shipments' internal-secret path requires it:
--        if (!bodyUserId) throw new Error('user_id required when using
--                                         internal-secret auth');
--      ...and its catch block returns HTTP 500. A 401 was traded for a 500.
--
--   2. THE BEARER IS THE LEGACY ANON JWT, hardcoded into cron.job.
--      20260901180000 and 20260911041000 established that this project has
--      since rotated its API keys, that the legacy token is what the platform
--      refuses as UNAUTHORIZED_LEGACY_JWT on functions keeping
--      verify_jwt = true, and that sync-fba-shipments is one of those
--      (config.toml, because the browser calls it). The call never reached
--      the function at all.
--
-- pg_cron records SUCCESS for any completed POST whatever the response, so
-- seven consecutive dead Sundays looked identical to seven healthy ones.
--
-- ── THE FIX ───────────────────────────────────────────────────────────────
--
-- Point the job at the catchup-fba-shipments WRAPPER and send it nothing but
-- the vault secret. The wrapper is verify_jwt = false (declared in
-- config.toml by this change), so there is no gateway JWT to go stale, and it
-- calls sync-fba-shipments with the service-role key from its own deployment
-- environment -- re-read on every cold start, so a future key rotation cannot
-- silently kill this a third time. Same shape as the fix to job 78.
--
-- The wrapper runs two passes per user, mirroring the two UI buttons that are
-- known to work: a 60-day pass WITH items and v2024 "Send to Amazon"
-- discovery first, then a 540-day headers-only coverage pass. Item-bearing
-- first on purpose -- the discrepancies page reads coverage from header dates,
-- so advancing coverage without fetching items would make it report real
-- units as never received. The 13-month-with-items window that caused
-- WORKER_RESOURCE_LIMIT in July is not attempted.
--
-- ── ORDER OF OPERATIONS ───────────────────────────────────────────────────
--
-- DEPLOY THE FUNCTION BEFORE APPLYING THIS MIGRATION. catchup-fba-shipments
-- is absent from config.toml until this change, so its live verify_jwt is
-- whatever the platform defaulted it to; the bearer-less call below only
-- works once the redeploy has set verify_jwt = false. Push to main (CI
-- deploys changed functions) or:
--
--   npx supabase functions deploy catchup-fba-shipments \
--     --project-ref mstibdszibcheodvnprm --use-api
--
-- Then npm run db:push. The immediate catch-up dispatch at the bottom closes
-- the six-week gap without waiting for Sunday.

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET') THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET is not in the vault; refusing to point the job at a secret that does not exist';
  END IF;
END
$guard$;

-- Best-effort, following 20260901180000: pg_cron resolves a job for the
-- CALLING role and refuses one created by another, so a failure here is
-- reported with the statement to run from the SQL editor rather than
-- aborting a migration that still needs to create the replacement.
DO $unsched$
BEGIN
  PERFORM cron.unschedule('catchup-fba-shipments-weekly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-weekly');
  RAISE NOTICE 'Old catchup-fba-shipments-weekly unscheduled.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'COULD NOT unschedule (%). Run in the SQL editor, then re-apply:', SQLERRM;
  RAISE NOTICE '  select cron.unschedule(''catchup-fba-shipments-weekly'');';
END
$unsched$;

SELECT cron.schedule(
  'catchup-fba-shipments-weekly',
  -- Unchanged cadence. The item-bearing pass looks back 60 days, so a single
  -- missed Sunday cannot reopen a gap.
  '40 5 * * 0',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        -- The vault secret and NOTHING else. No Authorization bearer: the
        -- wrapper is verify_jwt = false precisely so that no JWT has to be
        -- stored here, where the last one went stale unnoticed.
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-catchup-fba-shipments-weekly'),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- Close the gap now rather than on Sunday: six weeks of purchases are sitting
-- on the discrepancies page as unknown.
DO $kick$
DECLARE v_req bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'manual-verify-after-fix'),
    timeout_milliseconds := 300000
  ) INTO v_req;
  RAISE NOTICE 'Immediate catch-up dispatched, pg_net request id %.', v_req;
END
$kick$;

DO $verify$
DECLARE r record; v_newest date; v_ingested timestamptz;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== verify ========';

  FOR r IN
    SELECT jobid, jobname, schedule, active,
           (command ILIKE '%vault.decrypted_secrets%')   AS vault,
           (command ~ 'eyJ[A-Za-z0-9_-]{10,}')           AS legacy_jwt,
           (command ILIKE '%/catchup-fba-shipments%')    AS targets_wrapper
      FROM cron.job WHERE jobname = 'catchup-fba-shipments-weekly'
  LOOP
    RAISE NOTICE '  [%] % sched=% active=%', r.jobid, r.jobname, r.schedule, r.active;
    RAISE NOTICE '      vault=%  legacy_jwt=%  targets_wrapper=%  (want t / f / t)',
                 r.vault, r.legacy_jwt, r.targets_wrapper;
  END LOOP;

  -- The number the page actually reads. Re-run this in a few minutes; it
  -- should move off 2026-10-01.
  SELECT max(COALESCE(ship_date, received_date, confirmed_need_by_date)::date),
         max(created_at)
    INTO v_newest, v_ingested
    FROM public.fba_shipments;
  RAISE NOTICE '  newest dated shipment: %   last ingested: %', v_newest, v_ingested;
  RAISE NOTICE '  (was 2026-10-01 / 2026-10-02 when this was diagnosed)';

  RAISE NOTICE '';
  RAISE NOTICE '  Then check the run landed:';
  RAISE NOTICE '    select * from public.cron_run_history where job_name = ''catchup-fba-shipments-weekly'' order by started_at desc limit 5;';
  RAISE NOTICE '    select * from public.cron_http_failures_recent limit 20;';
END
$verify$;
