-- Three cron jobs that have been 401ing every run, identified deterministically.
--
-- ── HOW THEY WERE FOUND ───────────────────────────────────────────────────
--
-- 20260901140000 began capturing failed pg_net responses durably. The first
-- snapshot pulled 2,160 failures out of a six-hour window -- roughly 1,605 of
-- them 401s, at a steady four per minute, none of which anybody could see
-- before because pg_net prunes within hours and cron.job_run_details reports
-- SUCCESS for any completed POST regardless of the response.
--
-- Attribution by nearest-timestamp proved useless: it ranked
-- repricer-unified-dispatch-worker-b first purely because per-minute jobs are
-- the nearest neighbour to everything. The repricer was in fact healthy -- 869
-- price actions in the preceding ten minutes.
--
-- What worked was cross-referencing every job's auth style against its target
-- function's verify_jwt and its own guard. That is deterministic and it found
-- exactly three mismatches. It does NOT yet explain the steady 4/minute, which
-- remains open.
--
-- ── 1. auto-activate-inbound-5min — UNSCHEDULED ───────────────────────────
--
-- Sends `apikey` only. auto-activate-inbound-all requires an internal secret,
-- so the gateway admits the call and the function rejects it. Every run, for
-- as long as it has existed.
--
-- Removed rather than repaired, deliberately. auto-activate-inbound-all-2h
-- already calls the same function correctly with the vault secret, so the work
-- IS being done. Giving this one working credentials would not restore a lost
-- capability -- it would newly run a fanout every 5 minutes that has never once
-- run, a 24x load increase justified by nothing. If a 5-minute cadence is
-- actually wanted, raise the 2h job's frequency deliberately.
--
-- ── 2. prewarm-profit-loss-nightly — HEADERS FIXED ────────────────────────
--
-- Same apikey-only mistake against a guarded function, but no working
-- duplicate exists, so this one is repaired rather than removed. Nightly, so
-- it contributed 1 of the 1,605 -- and a nightly P&L prewarm that has never run
-- is exactly the kind of thing nobody notices until a report is slow.
--
-- ── 3. catchup-fba-shipments-weekly — BOTH HEADERS ────────────────────────
--
-- The other failure mode entirely: sync-fba-shipments keeps verify_jwt = true
-- because the browser calls it, so the gateway rejects this BEFORE the function
-- runs -- the internal secret it sends is never even read. Needs a bearer for
-- the gateway AND the secret for the function's own guard.
--
-- The anon key is correct here and is not a secret: it is published in the
-- browser bundle. It satisfies verify_jwt as a structurally valid JWT; the
-- x-internal-secret is what actually authorises the call.

SELECT cron.unschedule('auto-activate-inbound-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-activate-inbound-5min');

SELECT cron.unschedule('prewarm-profit-loss-nightly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prewarm-profit-loss-nightly');

SELECT cron.schedule(
  'prewarm-profit-loss-nightly',
  '20 6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/prewarm-profit-loss-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-prewarm-profit-loss-nightly'),
    timeout_milliseconds := 300000
  );
  $cron$
);

SELECT cron.unschedule('catchup-fba-shipments-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-weekly');

SELECT cron.schedule(
  'catchup-fba-shipments-weekly',
  '40 5 * * 0',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-fba-shipments',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        -- Gateway needs a structurally valid JWT because this function keeps
        -- verify_jwt = true for the browser. The anon key is published in the
        -- client bundle and is not a credential in any meaningful sense.
        'Authorization',     'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
        -- ...and the function's own guard needs this.
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-catchup-fba-shipments-weekly'),
    timeout_milliseconds := 300000
  );
  $cron$
);


-- ── TIGHTEN THE ATTRIBUTION VIEW ──────────────────────────────────────────
--
-- The first version correlated a failure to any job starting within FIVE
-- MINUTES. With per-minute jobs in the schedule that made every failure look
-- like it belonged to whichever job fires most often, and it named the
-- repricer as the top offender when the repricer was demonstrably healthy.
--
-- pg_net stamps the response when it ARRIVES, so the causing job started
-- shortly BEFORE it -- never after. A 90-second backward-only window fits a
-- slow call while excluding the next minute is fire. Where more than one job
-- fired in that window the answer is genuinely ambiguous, so candidate_jobs
-- says so rather than picking one and sounding certain.
CREATE OR REPLACE VIEW public.cron_http_failures_recent
WITH (security_invoker = true) AS
SELECT f.response_created,
       f.status_code,
       f.error_msg,
       f.content_snippet,
       (SELECT j.jobname
          FROM cron.job_run_details d
          JOIN cron.job j ON j.jobid = d.jobid
         WHERE d.start_time <= f.response_created
           AND d.start_time >  f.response_created - interval '90 seconds'
         ORDER BY d.start_time DESC
         LIMIT 1) AS likely_job,
       (SELECT count(DISTINCT d.jobid)
          FROM cron.job_run_details d
         WHERE d.start_time <= f.response_created
           AND d.start_time >  f.response_created - interval '90 seconds') AS candidate_jobs
  FROM public.cron_http_failures f
 ORDER BY f.response_created DESC;

COMMENT ON VIEW public.cron_http_failures_recent IS
  'Failed cron HTTP responses with the nearest preceding job. likely_job is correlated by time, not recorded: trust it only where candidate_jobs = 1.';

GRANT SELECT ON public.cron_http_failures_recent TO authenticated, service_role;

DO $$
DECLARE v_401 bigint;
BEGIN
  SELECT count(*) INTO v_401
    FROM public.cron_http_failures
   WHERE status_code = 401
     AND response_created > now() - interval '1 hour';
  RAISE NOTICE 'auto-activate-inbound-5min unscheduled (broken duplicate of auto-activate-inbound-all-2h).';
  RAISE NOTICE 'prewarm-profit-loss-nightly and catchup-fba-shipments-weekly rescheduled with working auth.';
  RAISE NOTICE '% 401(s) in the last hour before this change -- compare in an hour.', v_401;
  RAISE NOTICE 'The steady ~4/minute 401 is NOT explained by these three and is still open.';
END $$;
