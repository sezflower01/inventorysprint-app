-- pg_cron driver for the 2026 adjustment re-pull: ONE month per run.
--
-- WHY THIS WORKS WHERE DIRECT CALLS DID NOT. pg_cron also goes through pg_net,
-- which drops the responses of 50-90 second calls (request 39338 and 44855 both
-- vanished from net.http_request_queue AND net._http_response while the worker
-- moved past them). That no longer matters: the edge function persists its own
-- report into repull_reports before returning, and the apply is atomic inside
-- repull_month_adjustments_apply. So the RESULT survives even when the response
-- does not, and this driver reads outcomes from the DATABASE rather than from
-- HTTP. Losing the response costs nothing; losing the work is impossible.
--
-- One month in flight at a time, enforced by the 'fired' status: the tick
-- refuses to start a new month while one is outstanding.

CREATE TABLE IF NOT EXISTS public.repull_schedule (
  seq          int PRIMARY KEY,
  month        date NOT NULL,
  stage        text NOT NULL CHECK (stage IN ('dry','apply')),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fired','done','failed')),
  req_id       bigint,
  fired_at     timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  sync_retries int NOT NULL DEFAULT 0,
  backup_rows  bigint,
  fp_before    jsonb,
  note         text
);

COMMENT ON TABLE public.repull_schedule IS
  'Work list for the 2026 adjustment re-pull, one row per month per stage. The driver (repull_tick) walks it in seq order, one month in flight at a time.';

-- Stage 1: dry runs only. June and July have never completed; February, March
-- and April completed BEFORE api_amount_multiset existed, so they are re-run to
-- capture the multisets their residuals need explaining with.
INSERT INTO public.repull_schedule (seq, month, stage) VALUES
  (10, '2026-06-01', 'dry'),
  (20, '2026-07-01', 'dry'),
  (30, '2026-02-01', 'dry'),
  (40, '2026-03-01', 'dry'),
  (50, '2026-04-01', 'dry')
ON CONFLICT (seq) DO NOTHING;

/**
 * One tick: settle whatever is in flight, then start at most one new month.
 *
 * Deliberately does nothing clever on failure. It unschedules itself and leaves
 * the row marked 'failed' with a note, because an automated retry loop over a
 * financial write is exactly the wrong instinct -- the January empty-month
 * episode came from assuming a retry would sort itself out.
 */
CREATE OR REPLACE FUNCTION public.repull_tick()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid;
  v_inflight public.repull_schedule;
  v_next public.repull_schedule;
  v_rep jsonb;
  v_running int;
  v_backup bigint; v_live bigint;
  v_req bigint;
  v_secret text;
  v_msg text;
  SYNC_RETRY_CAP constant int := 10;   -- ~20 minutes at a 2-minute cadence
  FIRE_TIMEOUT   constant interval := interval '6 minutes';
  ATTEMPT_CAP    constant int := 3;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ---------------------------------------------------------------- settle
  SELECT * INTO v_inflight FROM public.repull_schedule
  WHERE status = 'fired' ORDER BY seq LIMIT 1;

  IF v_inflight.seq IS NOT NULL THEN
    -- A report captured AFTER we fired is this run's result.
    SELECT report INTO v_rep FROM public.repull_reports
    WHERE month = to_char(v_inflight.month,'YYYY-MM')
      AND captured_at >= v_inflight.fired_at
    ORDER BY captured_at DESC LIMIT 1;

    IF v_rep IS NOT NULL THEN
      IF v_rep ? 'error' OR v_rep ? 'aborted' OR v_rep ? 'apply_error' THEN
        UPDATE public.repull_schedule SET status='failed',
          note = 'refused: ' || left(COALESCE(v_rep->>'error', v_rep->>'aborted', v_rep->>'apply_error'),200)
        WHERE seq = v_inflight.seq;
        PERFORM public.repull_unschedule('refusal on ' || to_char(v_inflight.month,'YYYY-MM'));
        RETURN format('FAILED %s: refused -- job unscheduled', to_char(v_inflight.month,'YYYY-MM'));
      END IF;

      -- An APPLY must be verified against the database, never trusted from a
      -- report, because a dropped response and a write that never happened
      -- look identical from the outside.
      IF v_inflight.stage = 'apply' THEN
        v_msg := public.repull_verify_apply(v_uid, v_inflight.month, v_inflight.fp_before, v_rep);
        IF v_msg IS NOT NULL THEN
          PERFORM public.fec_restore_month(v_uid, v_inflight.month);
          UPDATE public.repull_schedule SET status='failed',
            note='verification failed, RESTORED: ' || left(v_msg,200)
          WHERE seq = v_inflight.seq;
          PERFORM public.repull_unschedule('verification failed on ' || to_char(v_inflight.month,'YYYY-MM'));
          RETURN format('FAILED %s: %s -- restored and unscheduled',
                        to_char(v_inflight.month,'YYYY-MM'), v_msg);
        END IF;
      END IF;

      UPDATE public.repull_schedule SET status='done' WHERE seq = v_inflight.seq;
      -- fall through and start the next month in the same tick
    ELSIF v_inflight.fired_at > now() - FIRE_TIMEOUT THEN
      RETURN format('waiting on %s (%s)', to_char(v_inflight.month,'YYYY-MM'), v_inflight.stage);
    ELSE
      -- No report and the window has passed: the pg_net response was dropped
      -- AND the function left no trace, so it did not run.
      IF v_inflight.attempts + 1 >= ATTEMPT_CAP THEN
        UPDATE public.repull_schedule
        SET status='failed', attempts=attempts+1,
            note=format('no report after %s attempts', ATTEMPT_CAP)
        WHERE seq = v_inflight.seq;
        PERFORM public.repull_unschedule('no report for ' || to_char(v_inflight.month,'YYYY-MM'));
        RETURN format('FAILED %s: no report after %s attempts -- unscheduled',
                      to_char(v_inflight.month,'YYYY-MM'), ATTEMPT_CAP);
      END IF;
      UPDATE public.repull_schedule
      SET status='pending', attempts=attempts+1, req_id=NULL, fired_at=NULL
      WHERE seq = v_inflight.seq;
      RETURN format('retrying %s (attempt %s)', to_char(v_inflight.month,'YYYY-MM'),
                    v_inflight.attempts + 1);
    END IF;
  END IF;

  ---------------------------------------------------------------- next
  SELECT * INTO v_next FROM public.repull_schedule
  WHERE status = 'pending' ORDER BY seq LIMIT 1;

  IF v_next.seq IS NULL THEN
    PERFORM public.repull_unschedule('cohort complete');
    RETURN 'cohort complete -- job unscheduled';
  END IF;

  -- An apply must never land on a live sync.
  IF v_next.stage = 'apply' THEN
    SELECT count(*) INTO v_running FROM public.pl_sync_progress
    WHERE user_id = v_uid AND status IN ('running','continue');
    IF v_running > 0 THEN
      IF v_next.sync_retries + 1 > SYNC_RETRY_CAP THEN
        UPDATE public.repull_schedule SET status='failed', sync_retries=sync_retries+1,
          note=format('a sync was running for %s consecutive ticks', SYNC_RETRY_CAP)
        WHERE seq = v_next.seq;
        PERFORM public.repull_unschedule('sync never idle');
        RETURN 'FAILED: a sync has been running past the retry cap -- unscheduled';
      END IF;
      UPDATE public.repull_schedule SET sync_retries = sync_retries + 1 WHERE seq = v_next.seq;
      RETURN format('holding %s: sync running (retry %s/%s)',
                    to_char(v_next.month,'YYYY-MM'), v_next.sync_retries + 1, SYNC_RETRY_CAP);
    END IF;

    -- Back up and VERIFY the count before any write, and record the
    -- before-fingerprint of the rows this must not touch.
    v_backup := public.fec_backup_month(v_uid, v_next.month);
    SELECT count(*) INTO v_live FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= date_trunc('month', v_next.month)::date
      AND event_date <  (date_trunc('month', v_next.month) + interval '1 month')::date;

    IF v_backup = 0 OR (v_backup <> v_live AND v_next.attempts = 0) THEN
      -- On a RE-attempt the backup is the pristine pre-first-attempt copy and
      -- will legitimately differ from live, so only gate on it the first time.
      UPDATE public.repull_schedule SET status='failed',
        note=format('backup %s vs live %s', v_backup, v_live) WHERE seq = v_next.seq;
      PERFORM public.repull_unschedule('backup mismatch');
      RETURN format('FAILED %s: backup %s vs live %s -- unscheduled',
                    to_char(v_next.month,'YYYY-MM'), v_backup, v_live);
    END IF;

    UPDATE public.repull_schedule
    SET backup_rows = v_backup,
        fp_before = (SELECT jsonb_agg(jsonb_build_object('t',event_type,'n',rows,'f',fingerprint)
                                      ORDER BY event_type)
                     FROM public.fec_other_types_fingerprint(v_uid, v_next.month))
    WHERE seq = v_next.seq;
    SELECT * INTO v_next FROM public.repull_schedule WHERE seq = v_next.seq;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
                               'month', to_char(v_next.month,'YYYY-MM-01'),
                               'apply', (v_next.stage = 'apply')),
    timeout_milliseconds := 115000
  ) INTO v_req;

  UPDATE public.repull_schedule
  SET status='fired', req_id=v_req, fired_at=now() WHERE seq = v_next.seq;

  RETURN format('fired %s (%s) req %s', to_char(v_next.month,'YYYY-MM'), v_next.stage, v_req);
END
$fn$;

/** Remove the cron job, and say so in a note. Safe to call when absent. */
CREATE OR REPLACE FUNCTION public.repull_unschedule(p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repull-adjustments-2m') THEN
    PERFORM cron.unschedule('repull-adjustments-2m');
    RAISE NOTICE '[repull] unscheduled: %', COALESCE(p_reason,'(no reason given)');
  END IF;
END
$fn$;

/**
 * Verify an apply from the DATABASE. Returns NULL when everything checks out,
 * or a reason string when it does not.
 */
CREATE OR REPLACE FUNCTION public.repull_verify_apply(
  p_user uuid, p_month date, p_fp_before jsonb, p_report jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := date_trunc('month',p_month)::date;
  v_end   date := (date_trunc('month',p_month) + interval '1 month')::date;
  r record; v_bad text; v_api numeric; v_stored numeric; v_moved int := 0;
BEGIN
  -- 1. the rows this must not touch, byte for byte
  FOR r IN
    SELECT (b->>'t') AS t, (b->>'n')::bigint AS n, (b->>'f') AS f
    FROM jsonb_array_elements(COALESCE(p_fp_before,'[]'::jsonb)) AS b
  LOOP
    SELECT CASE
             WHEN f.rows IS NULL THEN format('%s disappeared', r.t)
             WHEN f.rows <> r.n THEN format('%s rows %s -> %s', r.t, r.n, f.rows)
             WHEN f.fingerprint <> r.f THEN format('%s fingerprint changed', r.t)
           END INTO v_bad
    FROM (SELECT * FROM public.fec_other_types_fingerprint(p_user,v_start)
          WHERE event_type = r.t) f;
    IF v_bad IS NOT NULL THEN RETURN v_bad; END IF;
  END LOOP;

  -- 2. clawbacks stored must equal what the API reported
  v_api := (p_report->>'api_clawback_total')::numeric;
  SELECT round(COALESCE(sum(compensated_clawback),0),2) INTO v_stored
  FROM public.financial_events_cache
  WHERE user_id=p_user AND event_type='adjustment'
    AND event_date>=v_start AND event_date<v_end;
  IF round(COALESCE(v_api,0),2) <> COALESCE(v_stored,0) THEN
    RETURN format('clawbacks stored %s vs API %s', v_stored, round(v_api,2));
  END IF;

  -- 3. nothing but adjustment rows may have changed key-wise
  SELECT count(*) INTO v_moved FROM public.fec_diff_month(p_user,v_start)
  WHERE verdict <> 'unchanged' AND event_type <> 'adjustment';
  IF v_moved > 0 THEN
    RETURN format('%s non-adjustment rows moved in the diff', v_moved);
  END IF;

  RETURN NULL;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_tick() TO service_role;
GRANT EXECUTE ON FUNCTION public.repull_unschedule(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.repull_verify_apply(uuid, date, jsonb, jsonb) TO service_role;

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== stage 1 work list ==';
  FOR r IN SELECT seq, to_char(month,'YYYY-MM') AS m, stage, status
           FROM public.repull_schedule ORDER BY seq
  LOOP RAISE NOTICE '   % | % | % | %', r.seq, r.m, rpad(r.stage,5), r.status; END LOOP;
END
$p$;

SELECT cron.schedule('repull-adjustments-2m', '*/2 * * * *', $$SELECT public.repull_tick()$$);
