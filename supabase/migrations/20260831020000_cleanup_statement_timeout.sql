-- Let the batched cleanup run under a timeout it can actually finish in.
--
-- ── WHY IT STILL FAILED ───────────────────────────────────────────────────
--
-- Batching (20260831000000) and a BRIN index (20260831010000) both landed and
-- "Clean now" still returned "canceling statement due to statement timeout",
-- while the row-count preview on the same screen worked fine.
--
-- The difference is WHO runs it. "Clean now" calls this function over
-- PostgREST as the authenticated user, whose statement_timeout is short by
-- design. The nightly cron runs as postgres with a far longer one. Same
-- function, same data, two different ceilings -- which is why it fails from
-- the button and had been succeeding from cron until the backlog grew.
--
-- ── WHY RAISING IT IS SAFE HERE, HAVING BEEN WRONG TWICE BEFORE ───────────
--
-- Raising statement_timeout has been tried twice on this table and regressed
-- both times. Both attempts raised it for an UNBOUNDED delete, so a longer
-- ceiling only bought a longer transaction holding locks and dead tuples, and
-- moved the failure later.
--
-- That is no longer the shape of this function. It deletes in 5,000-row
-- batches and stops itself after four minutes whatever happens, so the
-- ceiling is not what limits it -- the internal budget is. Ten minutes simply
-- has to exceed four so the function reaches its own stopping point instead of
-- being cancelled short of it.
--
-- The SET is on the FUNCTION, so it applies only while this runs and reverts
-- afterwards. Nothing else the caller does inherits it.

ALTER FUNCTION public.cleanup_repricer_price_actions(INT)
  SET statement_timeout = '600s';

-- The same argument applies to every other retention function: each is bounded
-- by its own delete, and none should be cancelled halfway through leaving a
-- partial clean the log reports as completed.
ALTER FUNCTION public.cleanup_repricer_ai_decisions(INT)
  SET statement_timeout = '600s';

DO $$
DECLARE v_old BIGINT;
BEGIN
  SELECT count(*) INTO v_old FROM public.repricer_price_actions
  WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'cleanup functions now run with a 600s ceiling; the 4-minute internal budget still bounds the work.';
  RAISE NOTICE '% row(s) older than 14 days. Click "Clean now" -- it should report rows_deleted and hit_time_limit.', v_old;
  RAISE NOTICE 'If hit_time_limit is true, click again; each run continues from where the last stopped.';
END $$;
