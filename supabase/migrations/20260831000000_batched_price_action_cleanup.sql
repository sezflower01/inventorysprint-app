-- Delete old repricer_price_actions in bounded batches instead of one statement.
--
-- ── THE FAILURE ───────────────────────────────────────────────────────────
--
-- nightly_cleanup_repricer_price_actions failed three nights running --
-- 2026-08-27, 08-28, 08-29 -- all "canceling statement due to statement
-- timeout". Every other table cleaned fine on the same nights; only the 6.8 GB
-- one dies.
--
-- It had succeeded on 08-24 (36,066 rows), 08-25 (125,130) and 08-26 (131,023),
-- so this is not a long-standing fault. The likeliest trigger is retention
-- being lowered from the schema default of 30 days to 14, which leaves one
-- enormous catch-up delete. Checked and ruled out: the eight index drops on
-- this table landed on 08-22, three successful nights before the first failure.
--
-- Left alone it compounds. Each failed night leaves more rows for the next,
-- which makes the delete larger and the timeout more certain. It does not
-- recover on its own.
--
-- ── WHY BATCHING, NOT A LONGER TIMEOUT ────────────────────────────────────
--
-- Raising the timeout has been tried twice here and regressed both times: a
-- longer statement holds locks and dead tuples longer, and simply moves the
-- failure later. statement_timeout applies PER STATEMENT, so many small
-- deletes each finish well inside it where one large delete cannot.
--
-- ── BOUNDED BY TIME, NOT JUST ROWS ────────────────────────────────────────
--
-- A row cap alone still lets a slow night run indefinitely. The time budget is
-- what guarantees the job always ends, whatever the data looks like, and a
-- partial clean that finishes is worth more than a complete one that is
-- cancelled -- the next run simply continues from where it stopped.
--
-- ── NO INDEX ADDED ────────────────────────────────────────────────────────
--
-- Deliberately not recreating an index on created_at. The table is
-- append-only, so the oldest rows are physically first and a LIMIT-bounded
-- scan finds its batch almost immediately. An index here would be maintained
-- on every insert on the hottest write path in the system, which is exactly
-- the write amplification the 2026-08-22 drop removed.

CREATE OR REPLACE FUNCTION public.cleanup_repricer_price_actions(_keep_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_started TIMESTAMPTZ := clock_timestamp();
  v_before BIGINT; v_after BIGINT;
  v_deleted BIGINT := 0; v_batch BIGINT;
  v_cutoff TIMESTAMPTZ := now() - make_interval(days => _keep_days);
  -- Comfortably inside statement_timeout on this table, and small enough that
  -- a cancelled batch loses little work.
  c_batch      CONSTANT INT := 5000;
  -- Bounds the whole run. The nightly window has room for several minutes;
  -- what matters is that it always ENDS.
  c_time_limit CONSTANT INTERVAL := interval '4 minutes';
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

    EXIT WHEN v_batch = 0;                      -- nothing left to remove
    IF clock_timestamp() - v_started > c_time_limit THEN
      v_hit_limit := true;
      EXIT;
    END IF;
  END LOOP;

  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_after;

  -- Reported, not hidden. A run that stopped on the clock with rows still
  -- older than the cutoff is a PARTIAL clean, and calling that "completed"
  -- without qualification is how a backlog builds unnoticed.
  PERFORM public._log_maintenance_job(
    'cleanup_repricer_price_actions',
    jsonb_build_object('keep_days', _keep_days, 'batched', true, 'hit_time_limit', v_hit_limit),
    'completed', v_started, v_deleted, v_before, v_after, NULL);

  RETURN jsonb_build_object(
    'rows_deleted', v_deleted,
    'before_bytes', v_before,
    'after_bytes',  v_after,
    'hit_time_limit', v_hit_limit,
    'note', CASE WHEN v_hit_limit
      THEN 'Stopped on the 4-minute budget; rows older than the cutoff remain. The next run continues.'
      ELSE 'All rows older than the cutoff were removed.' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_repricer_price_actions(INT) TO authenticated;

DO $$
DECLARE v_old BIGINT;
BEGIN
  SELECT count(*) INTO v_old FROM public.repricer_price_actions
  WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'cleanup_repricer_price_actions now batches (5,000 rows, 4-minute budget).';
  RAISE NOTICE '% row(s) currently older than 14 days.', v_old;
  RAISE NOTICE 'A large backlog clears over several nights rather than failing every night.';
END $$;
