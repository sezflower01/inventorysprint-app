-- Guardrails before the drain runs again.
--
-- It looped for three days: 25 Shipped orders written 18,195 times between
-- them, worst 734, while 149 orders in the cohort were never reached because
-- those 25 filled every batch. The exit condition is fixed, but "I fixed it"
-- is not a guardrail. These are.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A per-order attempt counter, separate from the resolution log.
--
-- The log only gets a row on a SUCCESSFUL write, so an order that Amazon
-- throttles is retried with no trace -- which is the legitimate retry path and
-- exactly the path that can spin forever. This counts every ASK, not every
-- write, which is the thing that needs bounding.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stuck_pending_attempts (
  order_id        text PRIMARY KEY,
  attempts        int         NOT NULL DEFAULT 0,
  first_attempt   timestamptz NOT NULL DEFAULT now(),
  last_attempt    timestamptz NOT NULL DEFAULT now(),
  terminal_reason text
);

COMMENT ON TABLE public.stuck_pending_attempts IS
  'One row per order the stuck-pending resolver has ASKED Amazon about. Bounds retries at 3 regardless of outcome: after that the order gets a terminal label and leaves the cohort whatever Amazon said.';

-- Seed from the damage so the loop cannot resume where it left off: anything
-- already written many times is past any sane cap.
INSERT INTO public.stuck_pending_attempts (order_id, attempts, first_attempt, last_attempt, terminal_reason)
SELECT order_id, LEAST(count(*), 99), min(resolved_at), max(resolved_at),
       CASE WHEN count(*) >= 3 THEN 'capped_by_backfill_after_loop' END
FROM public.stuck_pending_resolution_log
GROUP BY order_id
ON CONFLICT (order_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Run-level tripwire state.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stuck_pending_drain_state (
  id                   int PRIMARY KEY DEFAULT 1,
  consecutive_zero_runs int NOT NULL DEFAULT 0,
  last_run_at          timestamptz,
  last_note            text,
  CONSTRAINT one_row CHECK (id = 1)
);
INSERT INTO public.stuck_pending_drain_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. drain_tick(): the cron job calls THIS, not the edge function directly.
--
-- The stop conditions live in the database, beside the scheduler that has to
-- act on them. An edge function cannot unschedule its own cron job, and asking
-- it to signal that it wants to be stopped just moves the loop somewhere else.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.drain_tick()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid;
  v_cohort int;
  v_zero   int;
  v_secret text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_cohort
  FROM public.sales_orders so
  WHERE so.user_id = v_uid
    AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.estimated_price,0) > 0
    AND COALESCE(so.is_cancelled,false) = false
    AND so.order_id NOT LIKE '%-REFUND%'
    AND so.order_date <= current_date - 90
    AND COALESCE(so.price_confidence,'') <> 'ESTIMATE_UNRECOVERABLE'
    AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                    WHERE a.order_id = so.order_id AND a.attempts >= 3);

  SELECT consecutive_zero_runs INTO v_zero FROM public.stuck_pending_drain_state WHERE id = 1;

  -- Stop condition 1: nothing left to do.
  IF v_cohort = 0 THEN
    PERFORM cron.unschedule('drain-stuck-pending-5m')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');
    UPDATE public.stuck_pending_drain_state
    SET last_run_at = now(), last_note = 'cohort empty - unscheduled' WHERE id = 1;
    RETURN 'done: cohort empty, job unscheduled';
  END IF;

  -- Stop condition 2: two runs in a row that moved nothing. Either Amazon is
  -- refusing us or the exit condition has failed again; both want a human.
  IF v_zero >= 2 THEN
    PERFORM cron.unschedule('drain-stuck-pending-5m')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-stuck-pending-5m');
    UPDATE public.stuck_pending_drain_state
    SET last_run_at = now(), last_note = format('stalled with %s left - unscheduled', v_cohort)
    WHERE id = 1;
    RETURN format('stalled: %s orders left but two runs resolved nothing, job unscheduled', v_cohort);
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  PERFORM net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 25, 'apply', true, 'newestFirst', true),
    timeout_milliseconds := 280000
  );

  UPDATE public.stuck_pending_drain_state
  SET last_run_at = now(), last_note = format('dispatched with %s in cohort', v_cohort) WHERE id = 1;
  RETURN format('dispatched: %s orders in cohort', v_cohort);
END
$fn$;

REVOKE ALL ON FUNCTION public.drain_tick() FROM PUBLIC;

DO $p$
DECLARE r record; n int;
BEGIN
  SELECT count(*) INTO n FROM public.stuck_pending_attempts;
  RAISE NOTICE 'attempts table seeded with % orders from the loop', n;
  SELECT count(*) INTO n FROM public.stuck_pending_attempts WHERE terminal_reason IS NOT NULL;
  RAISE NOTICE '  of which % are already capped and cannot be asked again', n;

  FOR r IN SELECT count(*) AS cohort FROM public.sales_orders so
           WHERE so.user_id = (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com')
             AND COALESCE(so.sold_price,0)=0 AND COALESCE(so.estimated_price,0)>0
             AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
             AND so.order_date <= current_date - 90
             AND COALESCE(so.price_confidence,'') <> 'ESTIMATE_UNRECOVERABLE'
             AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                             WHERE a.order_id = so.order_id AND a.attempts >= 3)
  LOOP
    RAISE NOTICE 'cohort eligible under the new rules: % orders', r.cohort;
  END LOOP;
END
$p$;
