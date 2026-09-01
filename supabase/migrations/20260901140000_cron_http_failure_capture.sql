-- Catch failing cron jobs without touching 81 edge functions.
--
-- ── THE PROBLEM ───────────────────────────────────────────────────────────
--
-- 82 scheduled jobs, and until 2026-08-31 exactly ONE wrote to
-- cron_run_history. Everything else fails in silence, and this codebase has
-- now been bitten by that repeatedly:
--
--   * check-seller-watchlist died for 10 days. Found only because it happened
--     to use withCronLock; the CPU kill left no row, so even that was partial.
--   * auto-sync-settlements-weekly went unwatched long enough for January's
--     marketplace facilitator tax (~$12,200) to age out of Amazon's 90-day
--     retention. Unrecoverable.
--   * Three {"error":"Unauthorized"} responses were sitting in an 8-row window
--     of net._http_response on 2026-08-31 and nobody knew which jobs they were.
--
-- cron.job_run_details is no help: it records SUCCESS for any completed HTTP
-- POST regardless of what came back. A job can 401 every five minutes for a
-- month and pg_cron will report a perfect record.
--
-- ── WHY THIS SHAPE, NOT withCronLock EVERYWHERE ───────────────────────────
--
-- Wrapping 81 functions is 81 code changes, 81 deploys, and 81 chances to
-- introduce what happened to check-seller-watchlist -- whose watchdog was a
-- setTimeout inside the very isolate the platform was killing, so it could
-- never fire. Instrumentation that shares the failure domain of the thing it
-- watches is not instrumentation.
--
-- pg_net already records every response in net._http_response. The catch is
-- that it prunes them within hours, so nobody ever sees them. This copies just
-- the FAILURES somewhere permanent, on a schedule, in SQL. No function
-- changes, no deploys, and it covers all 82 jobs including ones added later.
--
-- ── THE LIMITATION, STATED UP FRONT ───────────────────────────────────────
--
-- net._http_response does NOT carry the request URL -- pg_net deletes the
-- queue row once handled -- so a captured failure cannot name its function
-- directly. What it gives is the status, the error, the response body and an
-- exact timestamp, which is enough to identify the job by correlating with
-- cron.job_run_details.start_time. Imperfect, and vastly better than the
-- current state of finding out months later that data has expired.

CREATE TABLE IF NOT EXISTS public.cron_http_failures (
  response_id      bigint PRIMARY KEY,
  status_code      int,
  error_msg        text,
  content_snippet  text,
  response_created timestamptz,
  observed_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cron_http_failures IS
  'Durable copy of failed pg_net responses (non-2xx, or timed out). net._http_response prunes within hours; this does not. Populated by snapshot_cron_http_failures() every 10 minutes.';

CREATE INDEX IF NOT EXISTS idx_cron_http_failures_created
  ON public.cron_http_failures (response_created DESC);

ALTER TABLE public.cron_http_failures ENABLE ROW LEVEL SECURITY;

-- Read-only to signed-in users; only the snapshot function (SECURITY DEFINER)
-- writes. There is nothing user-scoped here -- these are system events.
DROP POLICY IF EXISTS cron_http_failures_read ON public.cron_http_failures;
CREATE POLICY cron_http_failures_read ON public.cron_http_failures
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE OR REPLACE FUNCTION public.snapshot_cron_http_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_new int;
BEGIN
  INSERT INTO public.cron_http_failures
        (response_id, status_code, error_msg, content_snippet, response_created)
  SELECT r.id,
         r.status_code,
         r.error_msg,
         -- Enough to identify the failure shape. CLAUDE.md's own diagnosis
         -- rule depends on it: {"code":"UNAUTHORIZED_NO_AUTH_HEADER"} is the
         -- platform gateway, {"error":"Unauthorized"} is a function's own
         -- guard, and telling them apart decides where to look.
         left(r.content::text, 500),
         r.created
    FROM net._http_response r
   WHERE (r.status_code IS NULL OR r.status_code >= 400)
  ON CONFLICT (response_id) DO NOTHING;

  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 90 days is long enough to see a slow-burning pattern and short enough that
  -- the table never becomes its own problem.
  DELETE FROM public.cron_http_failures
   WHERE response_created < now() - interval '90 days';

  RETURN v_new;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.snapshot_cron_http_failures() TO service_role;

-- Every 10 minutes: comfortably inside pg_net's retention, cheap enough to
-- ignore. Minute 4 to stay off the :00 pile-up that stopped sixteen jobs
-- starting at once on 2026-08-22.
SELECT cron.unschedule('snapshot-cron-http-failures')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-cron-http-failures');

SELECT cron.schedule(
  'snapshot-cron-http-failures',
  '4-59/10 * * * *',
  $cron$ SELECT public.snapshot_cron_http_failures(); $cron$
);

-- Recent failures, newest first, with the likely job attributed by timestamp.
-- The join is a best guess by time (see the limitation note above), so
-- likely_job is a lead, never a verdict.
CREATE OR REPLACE VIEW public.cron_http_failures_recent
WITH (security_invoker = true) AS
SELECT f.response_created,
       f.status_code,
       f.error_msg,
       f.content_snippet,
       (SELECT j.jobname
          FROM cron.job_run_details d
          JOIN cron.job j ON j.jobid = d.jobid
         WHERE d.start_time BETWEEN f.response_created - interval '5 minutes'
                               AND f.response_created + interval '1 minute'
         ORDER BY abs(extract(epoch FROM (d.start_time - f.response_created)))
         LIMIT 1) AS likely_job
  FROM public.cron_http_failures f
 ORDER BY f.response_created DESC;

COMMENT ON VIEW public.cron_http_failures_recent IS
  'Failed cron HTTP responses with the nearest-in-time job name. likely_job is correlated by timestamp, not recorded -- treat it as a lead to confirm, not a fact.';

GRANT SELECT ON public.cron_http_failures_recent TO authenticated, service_role;

DO $$
DECLARE v_seeded int;
BEGIN
  SELECT public.snapshot_cron_http_failures() INTO v_seeded;
  RAISE NOTICE 'cron_http_failures created; % failure(s) captured from the current pg_net window.', v_seeded;
  RAISE NOTICE 'Snapshots every 10 minutes. Read: SELECT * FROM cron_http_failures_recent LIMIT 20;';
END $$;
