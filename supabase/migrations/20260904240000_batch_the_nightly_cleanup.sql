-- Batch the NIGHTLY cleanup, which is the one that has actually been failing.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- repricer_price_actions has failed its nightly cleanup every night since
-- 2026-08-29 with "canceling statement due to statement timeout", while every
-- other table in the same run succeeded. Meanwhile the "Clean now" button on
-- the same table works.
--
-- The reason is that they are two different code paths. 20260831000000 taught
-- cleanup_repricer_price_actions() to delete in 5,000-row batches with its own
-- time budget -- and that is the BUTTON. run_nightly_maintenance() never
-- called it. It builds one statement per table:
--
--   DELETE FROM <table> WHERE <ts_col> < now() - <retention>
--
-- and runs it unbounded. So the batching fix landed on the path that was not
-- failing and left the failing one untouched.
--
-- Measured 2026-09-04: 2,173,433 rows, 617,019 of them past the 14-day
-- retention, across THIRTEEN indexes. One statement removing 617k rows also
-- removes ~8M index entries, which does not finish inside 30 minutes -- and
-- each failed night adds another ~114k rows to the backlog, which is the
-- compounding spiral this table has been in for six nights.
--
-- ---- WHY BATCHING RATHER THAN A LONGER TIMEOUT --------------------------
--
-- Raising statement_timeout was tried twice on this table and regressed both
-- times: a longer ceiling on an unbounded delete only buys a longer
-- transaction holding locks and accumulating dead tuples, and moves the
-- failure later. Bounding the work is the fix that was already established for
-- the button; this applies it where it was missing.
--
-- ---- A PARTIAL RUN IS NOT A FAILURE -------------------------------------
--
-- Previously any timeout raised a CRITICAL alert. With a budget, stopping
-- early is the design working: the run deleted what it could and the next one
-- continues. Those are logged as 'completed' with hit_time_limit, and only a
-- genuine error still alerts -- otherwise the dashboard cries critical every
-- night while the system does exactly what it should.

CREATE OR REPLACE FUNCTION public.run_nightly_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
 SET statement_timeout TO '30min'
AS $function$
DECLARE
  v_started TIMESTAMPTZ := now();
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_total_deleted BIGINT := 0;
  v_results JSONB := '[]'::jsonb;
  v_one JSONB; v_sql TEXT;
  v_before BIGINT; v_after BIGINT; v_deleted BIGINT; v_err TEXT;
  v_ts_col TEXT;
  v_batch BIGINT; v_table_started TIMESTAMPTZ; v_hit_limit BOOLEAN;
  -- 5,000 matches the button's proven batch size. Per-table rather than
  -- overall so one huge table cannot starve the six behind it -- which is how
  -- a single failing table could have taken the whole run down.
  c_batch      CONSTANT INT      := 5000;
  c_per_table  CONSTANT INTERVAL := interval '3 minutes';
BEGIN
  FOR v_setting IN SELECT * FROM public.database_maintenance_settings WHERE enabled = TRUE ORDER BY table_key LOOP
    BEGIN
      v_ts_col := COALESCE(NULLIF(v_setting.timestamp_column, ''), 'created_at');
      v_table_started := clock_timestamp();
      v_deleted := 0;
      v_hit_limit := false;
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_before;

      -- ctid batching: the subquery finds 5,000 doomed rows using the
      -- timestamp index, and the delete touches only those. Identical to the
      -- button's shape, so both paths now behave the same way.
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
        IF clock_timestamp() - v_table_started > c_per_table THEN
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
      -- A cancellation now means something genuinely went wrong: the budget
      -- above stops the loop long before the 30-minute ceiling.
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
