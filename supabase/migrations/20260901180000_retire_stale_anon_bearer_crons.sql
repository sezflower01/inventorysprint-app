-- The ~4/minute 401 storm: cron jobs carrying a STALE anon key.
--
-- ── THE CHAIN ─────────────────────────────────────────────────────────────
--
-- 262 Unauthorized responses per hour, machine-steady across every hour
-- measured. Four per minute exactly.
--
-- Four cron jobs fire every minute with an Authorization bearer:
--   invoke-repricer-auto-turbo, repricer-sequential-sweep,
--   repricer-unified-dispatch, repricer-unified-dispatch-worker-b
--
-- All four target functions guarded by requireInternalOrUser, whose logic
-- decides the status code:
--
--   if (!bearer)                      -> 401 Unauthorized
--   if (bearer === current anon key)  -> 403 Forbidden
--   if (getClaims(bearer) fails)      -> 401 Unauthorized
--
-- These return 401, not 403. A CURRENT anon key would give 403. So the bearer
-- is an anon key that is no longer the current one -- rotated at some point,
-- never updated in the job definitions. Same root cause as the 37
-- UNAUTHORIZED_LEGACY_JWT responses, which is the platform refusing the same
-- outdated token on functions that keep verify_jwt = true.
--
-- ── WHY THE REPRICER STILL WORKS ──────────────────────────────────────────
--
-- Three of the four have -v2 twins that use the vault secret and succeed:
-- invoke-repricer-auto-turbo-v2, repricer-unified-dispatch-v2,
-- repricer-unified-dispatch-worker-b-v2. Somebody hit this before, wrote
-- working replacements, and left the broken originals scheduled. The repricer
-- was healthy throughout -- 869 price actions in ten minutes while these were
-- failing 240 times an hour.
--
-- That combination is what made this so hard to see: the symptom (401s) and
-- the evidence of health (price actions) were both real, and pointed opposite
-- ways. Timestamp correlation kept naming these jobs correctly and kept being
-- dismissed, because the repricer obviously worked.
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────────
--
-- The three with working twins are UNSCHEDULED. They have never done anything
-- but burn a function invocation and log a 401.
--
-- repricer-sequential-sweep has no twin, so it is REPAIRED rather than
-- removed -- switched to the vault secret, which isInternalCaller accepts
-- directly and which does not rotate out from under the job. This job has been
-- dead for as long as the key has been stale; expect it to start doing real
-- work again.
--
-- Roughly 240 of the 262 hourly 401s should disappear. The remainder are the
-- lower-frequency anon-bearer jobs, left for a follow-up so this change can be
-- measured cleanly rather than confounded with a dozen others.

-- NOTE ON OWNERSHIP -- WHY THIS IS BEST-EFFORT
--
-- Neither cron.unschedule(name) nor UPDATE cron.job works from the migration
-- role for these particular jobs: pg_cron resolves a job for the CALLING role
-- and refuses when it was created by another. Both were tried and both failed.
--
-- So the deactivation below is attempted and its failure is CAUGHT rather than
-- aborting the migration -- the replacement job still needs to be created
-- either way. If it could not deactivate them, the notice says so and gives
-- the exact statements to run from the SQL editor, which executes as a role
-- that owns them.
--
-- Recorded rather than silently skipped: a migration that half-applies and
-- reports success is the shape of problem this whole session has been about.

DO $deact$
BEGIN
  UPDATE cron.job SET active = false
   WHERE jobname IN ('invoke-repricer-auto-turbo',
                     'repricer-unified-dispatch',
                     'repricer-unified-dispatch-worker-b',
                     'repricer-sequential-sweep')
     AND active;
  RAISE NOTICE 'Deactivated the four stale-anon-bearer repricer crons.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'COULD NOT deactivate (%). Run this in the SQL editor:', SQLERRM;
  RAISE NOTICE '  select cron.unschedule(jobname) from cron.job where jobname in (''invoke-repricer-auto-turbo'',''repricer-unified-dispatch'',''repricer-unified-dispatch-worker-b'',''repricer-sequential-sweep'');';
END
$deact$;

-- The replacement for repricer-sequential-sweep, which has no working twin.
-- Created under a new name because the original may still exist; the two are
-- not equivalent, so leaving both active would double the work.
SELECT cron.unschedule('repricer-sequential-sweep-v2')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repricer-sequential-sweep-v2');

SELECT cron.schedule(
  'repricer-sequential-sweep-v2',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-sequential-sweep',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        -- The vault secret, not a bearer. isInternalCaller accepts it before
        -- any JWT is examined, so a future anon-key rotation cannot silently
        -- break this the way it broke the original.
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-repricer-sequential-sweep-v2'),
    timeout_milliseconds := 300000
  );
  $cron$
);

DO $$
DECLARE
  v_rate numeric;
  v_still bigint;
BEGIN
  SELECT count(*) / 60.0 INTO v_rate
    FROM public.cron_http_failures
   WHERE status_code = 401 AND response_created > now() - interval '1 hour';

  SELECT count(*) INTO v_still
    FROM cron.job
   WHERE active AND jobname IN ('invoke-repricer-auto-turbo',
                                'repricer-unified-dispatch',
                                'repricer-unified-dispatch-worker-b',
                                'repricer-sequential-sweep');

  RAISE NOTICE 'repricer-sequential-sweep-v2 scheduled with the vault secret.';
  RAISE NOTICE '401 rate before this change: %/min.', round(v_rate, 2);
  IF v_still > 0 THEN
    RAISE NOTICE 'STILL ACTIVE: % of the four broken jobs. They keep 401ing until unscheduled from the SQL editor.', v_still;
  ELSE
    RAISE NOTICE 'All four broken jobs are stopped. Expect roughly 4/min fewer 401s.';
  END IF;
END $$;
