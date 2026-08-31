-- Bring the cleanup budget under the HTTP gateway timeout.
--
-- "Clean now" now fails with a CLIENT-side "AbortError: signal is aborted
-- without reason" rather than any database error -- the browser gave up
-- waiting. The function is running; it is simply outliving the request.
--
-- The internal budget was four minutes, chosen so a nightly cron could chew
-- through a large backlog in one pass. But this function is also called
-- synchronously from a button over PostgREST, and that connection is held open
-- for far less than four minutes. Whatever the delete achieved, the caller
-- never saw it.
--
-- 45 seconds fits inside the gateway with room to spare, so a click now
-- RETURNS -- with rows_deleted and elapsed_seconds -- instead of aborting.
--
-- The backlog then clears over several clicks or several nights rather than
-- one pass. That is the slower option and the correct one: three attempts at
-- this have produced no measurement at all, because nothing ever returned. The
-- first successful run finally gives a throughput figure, and the budget can
-- be tuned from evidence instead of guessed at a fourth time.

CREATE OR REPLACE FUNCTION public.cleanup_repricer_price_actions(_keep_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_started TIMESTAMPTZ := clock_timestamp();
  v_before BIGINT; v_after BIGINT;
  v_deleted BIGINT := 0; v_batch BIGINT;
  v_cutoff TIMESTAMPTZ := now() - make_interval(days => _keep_days);
  c_batch      CONSTANT INT := 5000;
  -- Under the gateway timeout, so the caller always gets an answer.
  c_time_limit CONSTANT INTERVAL := interval '45 seconds';
  v_hit_limit BOOLEAN := false;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_before;

  LOOP
    DELETE FROM public.repricer_price_actions
    WHERE ctid IN (
      SELECT ctid FROM public.repricer_price_actions
      WHERE created_at < v_cutoff
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    EXIT WHEN v_batch = 0;
    IF clock_timestamp() - v_started > c_time_limit THEN
      v_hit_limit := true;
      EXIT;
    END IF;
  END LOOP;

  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_after;

  PERFORM public._log_maintenance_job(
    'cleanup_repricer_price_actions',
    jsonb_build_object('keep_days', _keep_days, 'batched', true, 'hit_time_limit', v_hit_limit),
    'completed', v_started, v_deleted, v_before, v_after, NULL);

  RETURN jsonb_build_object(
    'rows_deleted',    v_deleted,
    'before_bytes',    v_before,
    'after_bytes',     v_after,
    'hit_time_limit',  v_hit_limit,
    -- The number this whole exercise has been missing: how fast it actually
    -- deletes. Every previous attempt failed before returning anything.
    'elapsed_seconds', round(EXTRACT(EPOCH FROM clock_timestamp() - v_started)::numeric, 1));
END;
$fn$;

-- Ceilings above the internal budget, so the budget is what stops it.
ALTER FUNCTION public.cleanup_repricer_price_actions(INT) SET statement_timeout = '90s';
ALTER FUNCTION public.cleanup_repricer_price_actions(INT) SET lock_timeout = '30s';
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_price_actions(INT) TO authenticated;

DO $$
DECLARE v_old BIGINT;
BEGIN
  SELECT count(*) INTO v_old FROM public.repricer_price_actions
  WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'Budget now 45s, inside the gateway timeout -- Clean now will RETURN a result.';
  RAISE NOTICE '% row(s) older than 14 days. Click repeatedly; each run reports rows_deleted and elapsed_seconds.', v_old;
END $$;
