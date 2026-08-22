-- A sampler that captures what is actually running when statements get killed.
--
-- WHY THIS EXISTS
-- ---------------
-- "canceling statement due to statement timeout" has been recurring every few
-- minutes. Postgres logs the offending statement, but the Supabase Logs
-- Explorer returned "Backend error" on every attempt to read postgres_logs on
-- 2026-08-22, and the SQL Editor cannot see that table at all -- it is
-- BigQuery-backed, not Postgres. Without the statement text the errors are
-- unattributable, and two real fixes shipped the same day (an 86-second
-- repricer_price_actions lookup, and 441 MB of never-read indexes) did NOT
-- stop them. Guessing at a third fix would be guessing.
--
-- WHY SAMPLING AT THIS OFFSET CATCHES IT
-- --------------------------------------
-- The cancellation timestamps are not random. Seven of nine observed landed
-- between :16.3 and :17.9 past the minute:
--
--   20:52:17.799  20:52:17.903  21:06:15.129  21:07:16.782
--   21:22:16.336  21:22:16.498  21:30:17.000  21:37:16.784
--
-- A fixed offset past the minute boundary means the statements START at the
-- top of a minute and die a fixed interval later -- i.e. they are launched by
-- one of the thirteen every-minute cron jobs, and killed by a statement_timeout
-- of roughly fifteen seconds. Sampling at t+4, t+8 and t+12 seconds therefore
-- catches them mid-flight, before the cancellation destroys the evidence.
--
-- COST, since this runs on a system already under connection pressure
-- ------------------------------------------------------------------
-- One connection, held ~12 seconds per minute, doing four cheap reads of
-- pg_stat_activity. That is one slot roughly 20% of the time, against thirteen
-- jobs already firing every minute. The function sets its own statement_timeout
-- to 30s so that the sampler cannot itself be killed by the very timeout it is
-- trying to observe -- without that, it would sleep to t+12 and die at t+15
-- alongside its target.
--
-- REMOVE IT once the culprit is identified:
--   SELECT cron.unschedule('capture-slow-queries-1m');
--   DROP FUNCTION public.capture_slow_queries(int, int, numeric);
--   DROP TABLE public.slow_query_samples;

CREATE TABLE IF NOT EXISTS public.slow_query_samples (
  id               bigserial PRIMARY KEY,
  sampled_at       timestamptz NOT NULL DEFAULT now(),
  pid              int,
  usename          text,
  application_name text,
  client_addr      inet,
  state            text,
  wait_event_type  text,
  wait_event       text,
  query_start      timestamptz,
  duration_ms      numeric,
  query            text
);

CREATE INDEX IF NOT EXISTS idx_slow_query_samples_time
  ON public.slow_query_samples (sampled_at DESC);

-- Query text can contain user data, so this is service_role only. RLS on with
-- no policies means no client role can read it; the SQL Editor runs as
-- postgres and is unaffected.
ALTER TABLE public.slow_query_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slow_query_samples FROM authenticated, anon;
GRANT ALL ON public.slow_query_samples TO service_role;

CREATE OR REPLACE FUNCTION public.capture_slow_queries(
  p_min_ms       int     DEFAULT 3000,
  p_samples      int     DEFAULT 4,
  p_gap_seconds  numeric DEFAULT 4
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
-- 30s so the sampler outlives the ~15s timeout it is observing.
SET statement_timeout = '30s'
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_captured int := 0;
  v_this     int;
  i          int;
BEGIN
  FOR i IN 1..p_samples LOOP
    -- clock_timestamp(), not now(): now() is fixed for the whole transaction,
    -- so it would report the same duration on every sample of the loop.
    INSERT INTO public.slow_query_samples
      (pid, usename, application_name, client_addr, state,
       wait_event_type, wait_event, query_start, duration_ms, query)
    SELECT a.pid, a.usename, a.application_name, a.client_addr, a.state,
           a.wait_event_type, a.wait_event, a.query_start,
           EXTRACT(epoch FROM (clock_timestamp() - a.query_start)) * 1000,
           left(a.query, 4000)
    FROM pg_stat_activity a
    WHERE a.pid <> pg_backend_pid()
      AND a.state IS DISTINCT FROM 'idle'
      AND a.query_start IS NOT NULL
      AND clock_timestamp() - a.query_start > make_interval(secs => p_min_ms / 1000.0);

    GET DIAGNOSTICS v_this = ROW_COUNT;
    v_captured := v_captured + v_this;

    IF i < p_samples THEN
      PERFORM pg_sleep(p_gap_seconds);
    END IF;
  END LOOP;

  -- Self-pruning. This is a diagnostic, not a permanent record.
  DELETE FROM public.slow_query_samples
   WHERE sampled_at < now() - interval '7 days';

  RETURN v_captured;
END $$;

REVOKE ALL ON FUNCTION public.capture_slow_queries(int, int, numeric) FROM PUBLIC;

-- Idempotent reschedule. cron.unschedule resolves by (jobname, username) and
-- throws when the job does not exist, so the exception block is required for
-- this migration to be re-runnable.
DO $$
BEGIN
  PERFORM cron.unschedule('capture-slow-queries-1m');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture-slow-queries-1m',
  '* * * * *',
  $cron$SELECT public.capture_slow_queries();$cron$
);
