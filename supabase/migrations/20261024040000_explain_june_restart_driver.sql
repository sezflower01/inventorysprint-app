-- Patch the settle logic to use the tolerant finder, mark June done from the
-- evidence rather than re-running it, and re-schedule.
CREATE OR REPLACE FUNCTION public.repull_tick()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid; v_inflight public.repull_schedule; v_next public.repull_schedule;
  v_rep jsonb; v_running int; v_backup bigint; v_live bigint; v_req bigint;
  v_secret text; v_msg text;
  SYNC_RETRY_CAP constant int := 10;
  FIRE_TIMEOUT   constant interval := interval '6 minutes';
  ATTEMPT_CAP    constant int := 3;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT * INTO v_inflight FROM public.repull_schedule
  WHERE status = 'fired' ORDER BY seq LIMIT 1;

  IF v_inflight.seq IS NOT NULL THEN
    -- Tolerant month match. Matching a single format is what failed June.
    v_rep := public.repull_find_report(v_inflight.month, NULL, v_inflight.fired_at, false);

    IF v_rep IS NOT NULL THEN
      IF v_rep ? 'error' OR v_rep ? 'aborted' OR v_rep ? 'apply_error' THEN
        UPDATE public.repull_schedule SET status='failed',
          note='refused: ' || left(COALESCE(v_rep->>'error', v_rep->>'aborted', v_rep->>'apply_error'),200)
        WHERE seq = v_inflight.seq;
        PERFORM public.repull_unschedule('refusal on ' || to_char(v_inflight.month,'YYYY-MM'));
        RETURN format('FAILED %s: refused -- unscheduled', to_char(v_inflight.month,'YYYY-MM'));
      END IF;

      IF v_inflight.stage = 'apply' THEN
        v_msg := public.repull_verify_apply(v_uid, v_inflight.month, v_inflight.fp_before, v_rep);
        IF v_msg IS NOT NULL THEN
          PERFORM public.fec_restore_month(v_uid, v_inflight.month);
          UPDATE public.repull_schedule SET status='failed',
            note='verification failed, RESTORED: ' || left(v_msg,200) WHERE seq = v_inflight.seq;
          PERFORM public.repull_unschedule('verification failed on ' || to_char(v_inflight.month,'YYYY-MM'));
          RETURN format('FAILED %s: %s -- restored and unscheduled',
                        to_char(v_inflight.month,'YYYY-MM'), v_msg);
        END IF;
      END IF;

      UPDATE public.repull_schedule SET status='done' WHERE seq = v_inflight.seq;
    ELSIF v_inflight.fired_at > now() - FIRE_TIMEOUT THEN
      RETURN format('waiting on %s', to_char(v_inflight.month,'YYYY-MM'));
    ELSE
      IF v_inflight.attempts + 1 >= ATTEMPT_CAP THEN
        UPDATE public.repull_schedule SET status='failed', attempts=attempts+1,
          note=format('no report after %s attempts', ATTEMPT_CAP) WHERE seq = v_inflight.seq;
        PERFORM public.repull_unschedule('no report for ' || to_char(v_inflight.month,'YYYY-MM'));
        RETURN format('FAILED %s: no report -- unscheduled', to_char(v_inflight.month,'YYYY-MM'));
      END IF;
      UPDATE public.repull_schedule SET status='pending', attempts=attempts+1,
        req_id=NULL, fired_at=NULL WHERE seq = v_inflight.seq;
      RETURN format('retrying %s', to_char(v_inflight.month,'YYYY-MM'));
    END IF;
  END IF;

  SELECT * INTO v_next FROM public.repull_schedule WHERE status='pending' ORDER BY seq LIMIT 1;
  IF v_next.seq IS NULL THEN
    PERFORM public.repull_unschedule('cohort complete');
    RETURN 'cohort complete -- unscheduled';
  END IF;

  IF v_next.stage = 'apply' THEN
    SELECT count(*) INTO v_running FROM public.pl_sync_progress
    WHERE user_id=v_uid AND status IN ('running','continue');
    IF v_running > 0 THEN
      IF v_next.sync_retries + 1 > SYNC_RETRY_CAP THEN
        UPDATE public.repull_schedule SET status='failed', sync_retries=sync_retries+1,
          note='sync running past the retry cap' WHERE seq=v_next.seq;
        PERFORM public.repull_unschedule('sync never idle');
        RETURN 'FAILED: sync past retry cap -- unscheduled';
      END IF;
      UPDATE public.repull_schedule SET sync_retries=sync_retries+1 WHERE seq=v_next.seq;
      RETURN format('holding %s: sync running (%s/%s)', to_char(v_next.month,'YYYY-MM'),
                    v_next.sync_retries+1, SYNC_RETRY_CAP);
    END IF;

    v_backup := public.fec_backup_month(v_uid, v_next.month);
    SELECT count(*) INTO v_live FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date >= date_trunc('month',v_next.month)::date
      AND event_date < (date_trunc('month',v_next.month)+interval '1 month')::date;
    IF v_backup = 0 OR (v_backup <> v_live AND v_next.attempts = 0) THEN
      UPDATE public.repull_schedule SET status='failed',
        note=format('backup %s vs live %s', v_backup, v_live) WHERE seq=v_next.seq;
      PERFORM public.repull_unschedule('backup mismatch');
      RETURN format('FAILED %s: backup %s vs live %s -- unscheduled',
                    to_char(v_next.month,'YYYY-MM'), v_backup, v_live);
    END IF;
    UPDATE public.repull_schedule
    SET backup_rows=v_backup,
        fp_before=(SELECT jsonb_agg(jsonb_build_object('t',event_type,'n',rows,'f',fingerprint)
                                    ORDER BY event_type)
                   FROM public.fec_other_types_fingerprint(v_uid, v_next.month))
    WHERE seq=v_next.seq;
    SELECT * INTO v_next FROM public.repull_schedule WHERE seq=v_next.seq;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'month', to_char(v_next.month,'YYYY-MM-01'),
                               'apply', (v_next.stage='apply')),
    timeout_milliseconds := 115000
  ) INTO v_req;
  UPDATE public.repull_schedule SET status='fired', req_id=v_req, fired_at=now() WHERE seq=v_next.seq;
  RETURN format('fired %s (%s) req %s', to_char(v_next.month,'YYYY-MM'), v_next.stage, v_req);
END
$fn$;

-- June in fact succeeded five times. Mark it done from the evidence rather than
-- spending another 90 seconds of API budget re-running it.
UPDATE public.repull_schedule
SET status = 'done', attempts = 0,
    note = 'succeeded; the earlier failure was a month-format mismatch in my settle logic'
WHERE month = '2026-06-01' AND stage = 'dry';

DO $p$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== JUNE residual explanation (the only month holding a multiset so far) ==';
  PERFORM public.repull_residual_explain(v_uid,'2026-06-01');
END
$p$;

SELECT cron.schedule('repull-adjustments-2m', '*/2 * * * *', $$SELECT public.repull_tick()$$);
