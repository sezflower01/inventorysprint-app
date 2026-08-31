-- Give the cleanup room to acquire its row locks.
--
-- After statement_timeout was raised (20260831020000) "Clean now" moved on to
-- "canceling statement due to lock timeout" -- a different failure, and a
-- better one: the statement now runs long enough to reach the point of taking
-- locks.
--
-- repricer_price_actions takes an insert roughly every second from the
-- repricer, so a delete batch briefly contends for pages the writer is also
-- touching. The authenticated role's lock_timeout is short by design, and it
-- is shorter than that contention lasts.
--
-- Safe for the same reason the statement_timeout change was: this function
-- deletes in 5,000-row batches and stops itself after four minutes regardless,
-- so a longer lock ceiling cannot turn into an unbounded wait. It only lets a
-- batch outlast a moment of contention instead of being cancelled by it.
--
-- Deliberately NOT zero. lock_timeout = 0 waits forever, which on a table the
-- repricer writes to continuously is how a cleanup ends up blocking the thing
-- that pays for the database.
ALTER FUNCTION public.cleanup_repricer_price_actions(INT) SET lock_timeout = '30s';
ALTER FUNCTION public.cleanup_repricer_ai_decisions(INT)  SET lock_timeout = '30s';

DO $$
DECLARE v_old BIGINT;
BEGIN
  SELECT count(*) INTO v_old FROM public.repricer_price_actions
  WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'lock_timeout raised to 30s on the cleanup functions (statement 600s, internal budget 4 min).';
  RAISE NOTICE '% row(s) older than 14 days.', v_old;
END $$;
