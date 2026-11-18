-- The shipment catch-up was killed by the 150s platform idle timeout.
--
-- ── WHAT HAPPENED ─────────────────────────────────────────────────────────
--
-- 20261117203000 repaired catchup-fba-shipments-weekly and dispatched an
-- immediate catch-up. The function deployed fine -- catchup-fba-shipments
-- v337, verify_jwt = false, 2026-11-18T01:37:28Z, confirmed from
-- `supabase functions list` -- and the cron command was correct. But:
--
--   select * from public.cron_run_history
--    where job_name = 'catchup-fba-shipments-weekly';   -- NO ROWS
--
-- and cron_http_failures_recent carried, 13 minutes after that deploy:
--
--   2026-11-18 01:53:09+00 | 504 | {"code":"IDLE_TIMEOUT",
--     "message":"Request idle timeout limit (150s) reached"}
--     likely_job = repricer-unified-dispatch-v2 | candidate_jobs = 16
--
-- Backing out 150s puts the request start at ~01:50:39, which is when the
-- migration was applied. That 504 is the shipment catch-up, NOT the repricer.
-- The view attributes a failure to the nearest cron that started in the
-- preceding 90 seconds, and a hand-dispatched net.http_post has no cron behind
-- it at all -- so it borrowed the label of whatever fired nearby, with 16
-- candidates. The repricer was never involved.
--
-- Cause: the wrapper awaited BOTH passes for every user in one request. The
-- platform cuts a request off at 150s with no response bytes written, and two
-- heavy SP-API syncs plus throttles do not fit. The inner syncs persist as
-- they go, so work was done -- but the wrapper never returned, so
-- withCronLock never wrote its row, and "no rows" then meant both "never ran"
-- and "ran and was killed". One state doing two jobs, again, in the fix for a
-- bug about exactly that.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────
--
-- Not the timeout. Raising a timeout was tried twice on the nightly cleanup
-- and regressed both times; the work gets bounded instead.
--
--   * ONE PASS PER REQUEST. Two jobs 20 minutes apart, each sending `mode`,
--     instead of one job doing both.
--   * The function writes a 'started' row to cron_run_history BEFORE any
--     work, so a killed run is distinguishable from one that never began.
--   * The function stops starting new users at 110s and reports the rest as
--     deferred, so the request always returns and therefore always records.
--
-- recent (60d, WITH items and v2024 Send-to-Amazon discovery) must land before
-- wide (540d, headers only), because src/lib/shipmentCoverage.ts reads
-- coverage from HEADER dates: a headers-only pass advances coverage over
-- October without fetching the items the Shipped/Received columns come from,
-- which would make /tools/unshipped-purchases report real units as never
-- received. The 20-minute gap is not the guarantee -- the function refuses to
-- run `wide` unless `recent` recorded a success in the last 24h. An invariant
-- the page depends on belongs in code, not in two cron expressions someone
-- will later restagger.
--
-- Deploy the function before applying this. CI deploys on push to main, or:
--   npx supabase functions deploy catchup-fba-shipments \
--     --project-ref mstibdszibcheodvnprm --use-api

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET') THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET is not in the vault; refusing to point the jobs at a secret that does not exist';
  END IF;
END
$guard$;

-- Best-effort per 20260901180000: pg_cron resolves a job for the CALLING role
-- and refuses one created by another.
DO $unsched$
BEGIN
  PERFORM cron.unschedule('catchup-fba-shipments-weekly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-weekly');
  RAISE NOTICE 'Single-request catchup-fba-shipments-weekly unscheduled; replaced by two passes.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'COULD NOT unschedule (%). Run in the SQL editor:', SQLERRM;
  RAISE NOTICE '  select cron.unschedule(''catchup-fba-shipments-weekly'');';
END
$unsched$;

-- Pass 1: items + v2024 discovery. The one the discrepancies page depends on.
SELECT cron.unschedule('catchup-fba-shipments-recent-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-recent-weekly');

SELECT cron.schedule(
  'catchup-fba-shipments-recent-weekly',
  -- 60-day lookback, so a single missed Sunday cannot reopen a gap.
  '40 5 * * 0',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        -- The vault secret and NOTHING else. No Authorization bearer: the
        -- wrapper is verify_jwt = false precisely so no JWT has to be stored
        -- here, where the last one went stale unnoticed.
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('mode', 'recent', 'triggered_by', 'cron-catchup-fba-shipments-recent-weekly'),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- Pass 2: coverage breadth only. Refuses to run if pass 1 has not succeeded
-- within 24h -- see the function, this schedule is not the guarantee.
SELECT cron.unschedule('catchup-fba-shipments-wide-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-wide-weekly');

SELECT cron.schedule(
  'catchup-fba-shipments-wide-weekly',
  '0 6 * * 0',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('mode', 'wide', 'triggered_by', 'cron-catchup-fba-shipments-wide-weekly'),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- Close the six-week gap now, with the pass that actually pulls items.
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
    body := jsonb_build_object('mode', 'recent', 'triggered_by', 'manual-verify-after-split'),
    timeout_milliseconds := 300000
  ) INTO v_req;
  RAISE NOTICE 'Immediate recent-pass catch-up dispatched, pg_net request id %.', v_req;
END
$kick$;

DO $verify$
DECLARE r record; v_newest date; v_ingested timestamptz;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== verify ========';

  FOR r IN
    SELECT jobid, jobname, schedule, active,
           (command ILIKE '%vault.decrypted_secrets%') AS vault,
           (command ~ 'eyJ[A-Za-z0-9_-]{10,}')         AS legacy_jwt,
           substring(command FROM '''mode'', ''([a-z]+)''') AS mode
      FROM cron.job
     WHERE jobname LIKE 'catchup-fba-shipments%'
     ORDER BY jobname
  LOOP
    RAISE NOTICE '  [%] % sched=% active=% mode=% vault=% legacy_jwt=%',
                 r.jobid, rpad(r.jobname, 38), r.schedule, r.active, r.mode, r.vault, r.legacy_jwt;
  END LOOP;
  RAISE NOTICE '  (want exactly two jobs, modes recent and wide, vault=t legacy_jwt=f)';

  SELECT max(COALESCE(ship_date, received_date, confirmed_need_by_date)::date),
         max(created_at)
    INTO v_newest, v_ingested
    FROM public.fba_shipments;
  RAISE NOTICE '';
  RAISE NOTICE '  newest dated shipment: %   last ingested: %', v_newest, v_ingested;
  RAISE NOTICE '  (was 2026-10-01 / 2026-10-02 when this was diagnosed)';

  RAISE NOTICE '';
  RAISE NOTICE '  In a minute or two, the run should be recorded -- note the NEW job names:';
  RAISE NOTICE '    select job_name, status, duration_ms, items_processed, error, detail, started_at';
  RAISE NOTICE '      from public.cron_run_history';
  RAISE NOTICE '     where job_name like ''catchup-fba-shipments-%%'' order by started_at desc limit 10;';
  RAISE NOTICE '  A ''started'' row with no ''success'' after it means the worker was killed again.';
END
$verify$;
