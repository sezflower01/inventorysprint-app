-- Bring the nightly cleanup's time budget under the ceiling that actually
-- cancels it.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- 20260904240000 batched the nightly delete and gave each table a 3-minute
-- budget under a declared 30-minute statement_timeout. The declared ceiling is
-- not the one that fires. Measured from cron.job_run_details on 2026-09-06:
--
--   09-02  137.9s  succeeded
--   09-03  140.8s  succeeded
--   09-04  141.9s  succeeded
--   09-05  120.4s  CANCELLED  statement timeout
--   09-06  120.2s  CANCELLED  statement timeout
--
-- Something cancels around 120s. Neither the postgres role nor the database
-- sets a statement_timeout and the function declares 30min, so the source of
-- that ceiling is NOT identified -- but a 3-minute per-table budget can never
-- fire beneath it, which means the biggest table is always cancelled rather
-- than exiting cleanly. On 09-05 and 09-06 that took the whole run with it.
--
-- The per-table cleanup function got this right a week earlier and said so in
-- its own migration (20260831040000): "Ceilings above the internal budget, so
-- the budget is what stops it." 45 seconds under a 90-second ceiling. That is
-- the path the "Clean now" button uses, and it is the one that works -- 330,005
-- rows on 2026-08-30, then 34,633, both committed. This applies the same shape
-- to the nightly.
--
-- ---- WHY AN OVERALL BUDGET TOO, NOT JUST A SMALLER PER-TABLE ONE --------
--
-- 45 seconds x 7 enabled tables is 5 minutes 15 seconds, still far above the
-- ~120s ceiling. Per-table budgets alone cannot bound the run; they only bound
-- one table. In practice six of the seven finish in seconds and only
-- repricer_price_actions is large, so the run fits -- but "in practice" is how
-- the 3-minute budget looked reasonable too. c_whole_run makes the function
-- return before the ceiling regardless of how many tables grow.
--
-- 100 seconds leaves ~20s of headroom under the observed 120s, enough for the
-- closing INSERT and evaluate_health_alerts() to land.
--
-- ---- WHAT THIS DOES NOT FIX --------------------------------------------
--
-- The run is still a single function call, so a cancellation that is NOT
-- caught still discards the whole transaction's deletes. Budgets make that
-- unlikely rather than impossible. The durable fix is a PROCEDURE committing
-- between batches, which cron can CALL and which would make progress
-- permanent the moment each batch lands. Deliberately not done here: it
-- changes the shape of the job and the UI's RPC cannot call a procedure,
-- so it needs its own change rather than riding along with a constant.

CREATE OR REPLACE FUNCTION public.run_nightly_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
 SET statement_timeout TO '30min'
AS $function$
DECLARE
  v_started TIMESTAMPTZ := now();
  v_run_started TIMESTAMPTZ := clock_timestamp();
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_total_deleted BIGINT := 0;
  v_results JSONB := '[]'::jsonb;
  v_one JSONB; v_sql TEXT;
  v_before BIGINT; v_after BIGINT; v_deleted BIGINT; v_err TEXT;
  v_ts_col TEXT;
  v_batch BIGINT; v_table_started TIMESTAMPTZ; v_hit_limit BOOLEAN;
  v_skipped BOOLEAN;
  c_batch      CONSTANT INT      := 5000;
  -- Matches the per-table cleanup function's proven budget. Was 3 minutes,
  -- which is above the ceiling that actually cancels this job.
  c_per_table  CONSTANT INTERVAL := interval '45 seconds';
  -- Bounds the WHOLE run, which per-table budgets cannot do.
  c_whole_run  CONSTANT INTERVAL := interval '100 seconds';
BEGIN
  FOR v_setting IN SELECT * FROM public.database_maintenance_settings WHERE enabled = TRUE ORDER BY table_key LOOP
    -- Out of overall budget: record the remaining tables as skipped rather
    -- than starting work that will be cancelled mid-flight.
    IF clock_timestamp() - v_run_started > c_whole_run THEN
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('table', v_setting.table_key, 'status', 'skipped',
                           'reason', 'run time budget exhausted'));
      CONTINUE;
    END IF;

    BEGIN
      v_ts_col := COALESCE(NULLIF(v_setting.timestamp_column, ''), 'created_at');
      v_table_started := clock_timestamp();
      v_deleted := 0;
      v_hit_limit := false;
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_before;

      v_sql := format(
        'DELETE FROM %I.%I WHERE ctid IN ('
        || 'SELECT ctid FROM %I.%I WHERE %I < now() - make_interval(days => %s) LIMIT %s)',
        v_setting.schema_name, v_setting.table_name,
        v_setting.schema_name, v_setting.table_name,
        v_ts_col, v_setting.retention_days, c_batch);

      LOOP
        EXECUTE v_sql;
        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_deleted := v_deleted + v_batch;
        EXIT WHEN v_batch = 0;
        -- Either budget stops the loop; whichever runs out first.
        IF clock_timestamp() - v_table_started > c_per_table
           OR clock_timestamp() - v_run_started > c_whole_run THEN
          v_hit_limit := true;
          EXIT;
        END IF;
      END LOOP;

      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_after;
      INSERT INTO public.database_maintenance_jobs(
        action, params, status, triggered_by_email, started_at, finished_at, duration_ms,
        rows_affected, before_total_bytes, after_total_bytes
      ) VALUES (
        'nightly_cleanup_' || v_setting.table_key,
        jsonb_build_object('keep_days', v_setting.retention_days, 'ts_col', v_ts_col,
                           'source', 'nightly_cron', 'batched', true,
                           'hit_time_limit', v_hit_limit),
        'completed', 'cron@system', v_table_started, now(),
        GREATEST(0, EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_table_started))::int),
        v_deleted, v_before, v_after
      );
      v_total_deleted := v_total_deleted + COALESCE(v_deleted, 0);
      v_one := jsonb_build_object('table', v_setting.table_key, 'rows_deleted', v_deleted,
                                  'status', 'ok', 'hit_time_limit', v_hit_limit);
    EXCEPTION
      WHEN OTHERS THEN
        v_err := SQLERRM;
        INSERT INTO public.database_maintenance_jobs(action, params, status, triggered_by_email, started_at, finished_at, error_message)
        VALUES ('nightly_cleanup_' || v_setting.table_key,
                jsonb_build_object('keep_days', v_setting.retention_days, 'ts_col', v_ts_col, 'source', 'nightly_cron'),
                'failed', 'cron@system', v_started, now(), v_err);
        PERFORM public._raise_maintenance_alert('critical', 'nightly_cleanup_failed',
          format('Nightly cleanup failed for %s: %s', v_setting.table_key, v_err),
          jsonb_build_object('table_key', v_setting.table_key, 'error', v_err));
        v_one := jsonb_build_object('table', v_setting.table_key, 'status', 'failed', 'error', v_err);
    END;
    v_results := v_results || jsonb_build_array(v_one);
  END LOOP;

  INSERT INTO public.database_maintenance_jobs(action, params, status, triggered_by_email, started_at, finished_at, duration_ms, rows_affected)
  VALUES ('nightly_maintenance', jsonb_build_object('results', v_results), 'completed', 'cron@system', v_started, now(),
          GREATEST(0, EXTRACT(MILLISECONDS FROM (now() - v_started))::int), v_total_deleted);

  PERFORM public.evaluate_health_alerts();
  RETURN jsonb_build_object('total_deleted', v_total_deleted, 'results', v_results);
END; $function$;

-- Prove the budgets actually bound the run, rather than assuming they do.
DO $verify$
DECLARE t0 timestamptz := clock_timestamp(); v jsonb; v_secs numeric; v_rows bigint;
BEGIN
  SELECT public.run_nightly_maintenance() INTO v;
  v_secs := round(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::numeric, 1);
  v_rows := (v ->> 'total_deleted')::bigint;
  RAISE NOTICE 'run finished in % s, % rows deleted', v_secs, v_rows;
  RAISE NOTICE 'per-table results: %', v -> 'results';
  IF v_secs > 115 THEN
    RAISE WARNING 'run took % s -- still close to the ~120s ceiling', v_secs;
  END IF;
END $verify$;
