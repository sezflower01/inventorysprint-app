-- Relax the queue-depth gate from >3 to >25.
--
-- Depth 3 was too strict and for the wrong reason. The queue fills every
-- minute with this project's own short cron calls (capture-slow-queries-1m,
-- capture-system-load-1m, catalog-brand-backfill and friends) and drains
-- again; my request simply waits behind them, which costs time, not safety.
-- Gating on depth meant refusing to fire during most of every minute.
--
-- What actually matters is kept strict: an apply still refuses outright if any
-- pl_sync_progress row is running or continuing, because a concurrent
-- fetch-profit-loss run could upsert adjustment rows underneath the re-pull's
-- transaction. The transaction itself is what makes the write safe; the depth
-- check is only there to avoid pathological backlogs.
CREATE OR REPLACE FUNCTION public.repull_fire(p_user uuid, p_month date, p_apply boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_secret text; v_req bigint; v_q bigint; v_running bigint;
BEGIN
  SELECT count(*) INTO v_q FROM net.http_request_queue;
  IF v_q > 25 THEN
    RAISE EXCEPTION 'ABORT %: pg_net queue depth % is a backlog, not cron noise',
      to_char(p_month,'YYYY-MM'), v_q;
  END IF;

  SELECT count(*) INTO v_running FROM public.pl_sync_progress
  WHERE user_id = p_user AND status IN ('running','continue');
  IF p_apply AND v_running > 0 THEN
    RAISE EXCEPTION 'ABORT %: % sync(s) running -- refusing to apply concurrently',
      to_char(p_month,'YYYY-MM'), v_running;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', p_user,
                               'month', to_char(date_trunc('month',p_month),'YYYY-MM-01'),
                               'apply', p_apply),
    timeout_milliseconds := 115000
  ) INTO v_req;
  RAISE NOTICE '   fired % (apply=%) queue % syncs_running % -> request %',
    to_char(p_month,'YYYY-MM'), p_apply, v_q, v_running, v_req;
  RETURN v_req;
END
$fn$;

DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_ok := public.repull_report(38097);
  v_ok := public.repull_report(38109);
  RAISE NOTICE '';
  RAISE NOTICE '== DRY RUN: March (retry) ==';
  BEGIN v_req := public.repull_fire(v_uid, '2026-03-01', false);
  EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
END
$p$;
