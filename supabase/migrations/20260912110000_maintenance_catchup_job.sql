-- Make the configured retention actually hold, by running the cleanup more
-- often instead of trying to make one run do more.
--
-- ---- WHAT IS WRONG ------------------------------------------------------
--
-- Measured 2026-09-12: repricer_price_actions holds 19.5 days of rows against
-- a 14-day setting -- oldest row 2026-08-24, 1,541,271 rows, ~79k inserted per
-- day. The nightly run deletes between 25,000 and 105,000 rows depending on
-- how fast the batches happen to go:
--
--   09-06   39,232 rows    9.60s
--   09-07   30,000 rows   46.69s
--   09-08  105,000 rows   45.26s
--   09-09   75,000 rows   45.02s
--   09-10   95,000 rows   45.05s
--   09-11   25,000 rows   46.41s
--
-- Every one of those is a SUCCESS. Nothing is failing. The run simply stops at
-- its 45-second per-table budget, and on a bad night that budget buys fewer
-- rows than the day inserted. So the window drifts wider, and it will keep
-- drifting: at 25,000 rows against 79,000 inserted, a night can lose ground.
--
-- ---- WHY NOT JUST RAISE THE BUDGET --------------------------------------
--
-- Because the budget is not the ceiling. 20260906070000 measured a ~120s cap
-- that cancels this job from outside -- source never identified, but real, and
-- it took whole runs down on 09-05 and 09-06. The 45s/100s budgets exist to
-- finish UNDER it. Raising them re-creates exactly the failure they fixed.
--
-- The other documented fix -- a PROCEDURE committing between batches -- is
-- deliberately still not taken here. pg_cron executes a job inside its own
-- transaction, so a procedure doing COMMIT is not reliably callable from it,
-- and finding out in production is not worth it when a cheaper option exists.
--
-- ---- WHAT THIS DOES INSTEAD ---------------------------------------------
--
-- Each call is already its own transaction that commits on return, so progress
-- accumulates across calls for free. Sixteen 100-second runs clear far more
-- than one, with no run ever approaching the ceiling.
--
-- Runs 04:02-07:47 UTC, every 15 minutes on an offset minute:
--   * after the 03:30 nightly, so the two never overlap;
--   * outside the 13:00-03:00 BR repricing window;
--   * on :02/:17/:32/:47 because the :00/:15/:30/:45 and :05/:20/:35/:50 slots
--     are where this project's cron collisions already happen -- five jobs
--     failed with "job startup timeout" at exactly 10:35:35 on 2026-09-12.
--
-- Capacity at the WORST observed rate (25,000 rows per run) is 400,000 rows a
-- night against ~79,000 inserted, so the ~435,000-row backlog clears in about
-- two nights and then the window stays at 14 days on its own.
--
-- Deliberately narrower than the nightly:
--   * tables already inside their retention are skipped without work;
--   * ONE summary row per run, not one per table, so 16 runs a night do not
--     bury the maintenance history the nightly writes;
--   * evaluate_health_alerts() is NOT called -- the nightly owns alerting, and
--     16 evaluations a night would just re-raise the same rows.

CREATE OR REPLACE FUNCTION public.run_maintenance_catchup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
 SET statement_timeout TO '30min'
AS $function$
DECLARE
  v_started      TIMESTAMPTZ := now();
  v_run_started  TIMESTAMPTZ := clock_timestamp();
  v_setting      public.database_maintenance_settings%ROWTYPE;
  v_results      JSONB := '[]'::jsonb;
  v_total        BIGINT := 0;
  v_ts_col       TEXT;
  v_sql          TEXT;
  v_batch        BIGINT;
  v_deleted      BIGINT;
  v_oldest       TIMESTAMPTZ;
  v_table_started TIMESTAMPTZ;
  v_hit_limit    BOOLEAN;
  v_err          TEXT;
  c_batch      CONSTANT INT      := 5000;
  c_per_table  CONSTANT INTERVAL := interval '45 seconds';
  c_whole_run  CONSTANT INTERVAL := interval '100 seconds';
  -- Two catch-up runs must never overlap: they would fight over the same rows
  -- and each would spend its budget on work the other already did.
  c_lock       CONSTANT BIGINT   := 918273645;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'another catchup run holds the lock');
  END IF;

  FOR v_setting IN
    SELECT * FROM public.database_maintenance_settings WHERE enabled = TRUE ORDER BY table_key
  LOOP
    EXIT WHEN clock_timestamp() - v_run_started > c_whole_run;

    BEGIN
      v_ts_col := COALESCE(NULLIF(v_setting.timestamp_column, ''), 'created_at');

      -- Is this table even behind? One indexed min() beats starting a delete
      -- loop that finds nothing, and it is what lets 16 runs a night be cheap.
      EXECUTE format('SELECT min(%I) FROM %I.%I',
                     v_ts_col, v_setting.schema_name, v_setting.table_name)
        INTO v_oldest;

      IF v_oldest IS NULL
         OR v_oldest >= now() - make_interval(days => v_setting.retention_days) THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_setting.table_key, 'status', 'within_retention'));
        CONTINUE;
      END IF;

      v_table_started := clock_timestamp();
      v_deleted := 0;
      v_hit_limit := false;

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
        IF clock_timestamp() - v_table_started > c_per_table
           OR clock_timestamp() - v_run_started > c_whole_run THEN
          v_hit_limit := true;
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_deleted;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'table', v_setting.table_key, 'rows_deleted', v_deleted,
        'oldest_was', v_oldest, 'hit_time_limit', v_hit_limit, 'status', 'ok'));

    EXCEPTION WHEN OTHERS THEN
      -- Recorded, never alerted. A catch-up run is best-effort by design and
      -- the nightly still raises the real alert if a table stops draining.
      v_err := SQLERRM;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'table', v_setting.table_key, 'status', 'failed', 'error', v_err));
    END;
  END LOOP;

  INSERT INTO public.database_maintenance_jobs(
    action, params, status, triggered_by_email, started_at, finished_at,
    duration_ms, rows_affected)
  VALUES ('maintenance_catchup',
          jsonb_build_object('results', v_results, 'source', 'catchup_cron'),
          'completed', 'cron@system', v_started, now(),
          GREATEST(0, EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_run_started))::int),
          v_total);

  PERFORM pg_advisory_unlock(c_lock);
  RETURN jsonb_build_object('total_deleted', v_total, 'results', v_results);
END; $function$;

COMMENT ON FUNCTION public.run_maintenance_catchup() IS
  'Best-effort retention catch-up. Same budgets as the nightly, run every 15 minutes 04:02-07:47 UTC so progress accumulates across calls. Skips tables already inside retention.';

-- Not granted to authenticated: this is a cron-owned job. The UI keeps its
-- existing per-table "Clean now" RPC, which is the path a person should use.
REVOKE ALL ON FUNCTION public.run_maintenance_catchup() FROM PUBLIC;

SELECT cron.unschedule('maintenance-catchup-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'maintenance-catchup-15min');

SELECT cron.schedule(
  'maintenance-catchup-15min',
  '2,17,32,47 4-7 * * *',
  $cron$SELECT public.run_maintenance_catchup();$cron$
);

DO $verify$
DECLARE r record; v_days numeric;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== scheduled ========';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname = 'maintenance-catchup-15min'
  LOOP
    RAISE NOTICE '  jobid % | % | % | active=%', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how far behind each table is now ========';
  FOR r IN
    SELECT s.table_key, s.retention_days, s.schema_name, s.table_name,
           COALESCE(NULLIF(s.timestamp_column, ''), 'created_at') AS ts_col
    FROM public.database_maintenance_settings s
    WHERE s.enabled = TRUE
    ORDER BY s.table_key
  LOOP
    BEGIN
      EXECUTE format('SELECT EXTRACT(epoch FROM (now() - min(%I))) / 86400.0 FROM %I.%I',
                     r.ts_col, r.schema_name, r.table_name)
        INTO v_days;
      IF v_days IS NULL THEN
        RAISE NOTICE '  % empty', rpad(r.table_key, 32);
      ELSE
        RAISE NOTICE '  % holds % days, retention %',
          rpad(r.table_key, 32), round(v_days, 1), r.retention_days;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '  % could not read: %', rpad(r.table_key, 32), SQLERRM;
    END;
  END LOOP;
END $verify$;
