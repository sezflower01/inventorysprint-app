-- Tier the biggest column in the database: keep the row, drop the payload.
--
-- ---- WHAT THIS IS FOR ---------------------------------------------------
--
-- Measured 2026-09-12. repricer_price_actions is 7,022 MB, the largest object
-- in a 15 GB database, and it is not bloat:
--
--   heap      749 MB
--   indexes  1,106 MB
--   TOAST    5,167 MB   <-- out-of-line column storage
--
-- The maintenance dashboard reports this table at "1.6% bloat" because that
-- number counts dead tuples in the heap -- the 749 MB it can see. So the thing
-- actually filling the disk is invisible to the panel that exists to find it,
-- and pgstattuple_approx confirms a VACUUM FULL would return only ~257 MB.
--
-- Sampled over the newest 2,000 rows, the TOAST is one column:
--
--   intelligence_factors  jsonb   2,578 bytes/row   (89% of a 2,909-byte row)
--   reason                text      113 bytes/row
--
-- ~4 GB across 1.54M rows.
--
-- ---- WHY NULL IT RATHER THAN DELETE THE ROW OR DROP THE COLUMN ----------
--
-- intelligence_factors is read in 26 places -- the action log, the price-action
-- detail dialog, Smart Engine review, the monitor tables -- so the column stays
-- and recent rows keep it in full.
--
-- But those readers all open RECENT actions. The price history, the charts and
-- the outcome analysis need the row; none of them need a month-old copy of the
-- competitor snapshot that produced it. Nulling the column past a cutoff keeps
-- every row and every date, and returns the storage.
--
-- ---- THIS IS IRREVERSIBLE -----------------------------------------------
--
-- A nulled payload cannot be reconstructed. Hence a SETTING rather than a
-- hardcoded cutoff, and a conservative 7-day default rather than the 3 days
-- that would free more:
--
--   7 days kept  ~1.4 GB of payload retained, ~2.6 GB freed
--   3 days kept  ~0.6 GB of payload retained, ~3.4 GB freed
--
-- To change it, and it takes effect on the next run:
--   UPDATE public.database_maintenance_settings
--      SET payload_keep_days = 3 WHERE table_key = 'repricer_price_actions';
-- or call public.update_maintenance_payload_setting('repricer_price_actions', 3).
-- The Retention Settings panel in the UI does NOT expose this yet -- wiring it
-- in is a frontend change, deliberately not bundled here.
--
-- ---- WHAT IT COSTS ------------------------------------------------------
--
-- An UPDATE writes a new row version, so nulling ~1.3M rows leaves ~1.3M dead
-- heap tuples. The heap is only 749 MB and the nightly VACUUM ANALYZE already
-- runs, so that space returns as reusable within a night. The TOAST entries are
-- freed immediately. Net direction is strongly down, but the heap will look
-- WORSE for a few hours before it looks better -- that is expected, not a
-- regression.
--
-- As with every DELETE in this system, freed space is reusable but not returned
-- to the filesystem. A VACUUM FULL once the pruning has run is what shrinks the
-- 15 GB on disk, and it stays manual.

ALTER TABLE public.database_maintenance_settings
  ADD COLUMN IF NOT EXISTS payload_column    TEXT,
  ADD COLUMN IF NOT EXISTS payload_keep_days INTEGER;

DO $ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'database_maintenance_settings_payload_keep_days_check'
  ) THEN
    ALTER TABLE public.database_maintenance_settings
      ADD CONSTRAINT database_maintenance_settings_payload_keep_days_check
      CHECK (payload_keep_days IS NULL OR payload_keep_days >= 1);
  END IF;
END $ck$;

COMMENT ON COLUMN public.database_maintenance_settings.payload_column IS
  'Wide column nulled out past payload_keep_days while the row itself is kept. NULL disables payload tiering for this table.';
COMMENT ON COLUMN public.database_maintenance_settings.payload_keep_days IS
  'Days of full payload to retain. Must be <= retention_days to mean anything. NULL disables payload tiering.';

UPDATE public.database_maintenance_settings
   SET payload_column = 'intelligence_factors',
       payload_keep_days = 7
 WHERE table_key = 'repricer_price_actions';

CREATE OR REPLACE FUNCTION public.prune_maintenance_payloads()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30min'
AS $function$
DECLARE
  v_started       TIMESTAMPTZ := now();
  v_run_started   TIMESTAMPTZ := clock_timestamp();
  v_setting       public.database_maintenance_settings%ROWTYPE;
  v_results       JSONB := '[]'::jsonb;
  v_total         BIGINT := 0;
  v_ts_col        TEXT;
  v_sql           TEXT;
  v_batch         BIGINT;
  v_nulled        BIGINT;
  v_table_started TIMESTAMPTZ;
  v_hit_limit     BOOLEAN;
  v_err           TEXT;
  -- Smaller than the delete batch: each row rewrite also releases TOAST
  -- chunks, so a batch of 5,000 runs materially longer than a delete of 5,000.
  c_batch      CONSTANT INT      := 2000;
  c_per_table  CONSTANT INTERVAL := interval '45 seconds';
  c_whole_run  CONSTANT INTERVAL := interval '100 seconds';
  c_lock       CONSTANT BIGINT   := 918273646;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'another prune run holds the lock');
  END IF;

  FOR v_setting IN
    SELECT * FROM public.database_maintenance_settings
    WHERE enabled = TRUE
      AND payload_column IS NOT NULL
      AND payload_keep_days IS NOT NULL
    ORDER BY table_key
  LOOP
    EXIT WHEN clock_timestamp() - v_run_started > c_whole_run;

    BEGIN
      v_ts_col := COALESCE(NULLIF(v_setting.timestamp_column, ''), 'created_at');
      v_table_started := clock_timestamp();
      v_nulled := 0;
      v_hit_limit := false;

      -- `IS NOT NULL` in the predicate is what makes this converge: once a row
      -- is pruned it stops matching, so repeated runs walk forward through the
      -- backlog instead of rewriting the same rows.
      v_sql := format(
        'UPDATE %I.%I SET %I = NULL WHERE ctid IN ('
        || 'SELECT ctid FROM %I.%I '
        || 'WHERE %I < now() - make_interval(days => %s) AND %I IS NOT NULL LIMIT %s)',
        v_setting.schema_name, v_setting.table_name, v_setting.payload_column,
        v_setting.schema_name, v_setting.table_name,
        v_ts_col, v_setting.payload_keep_days, v_setting.payload_column, c_batch);

      LOOP
        EXECUTE v_sql;
        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_nulled := v_nulled + v_batch;
        EXIT WHEN v_batch = 0;
        IF clock_timestamp() - v_table_started > c_per_table
           OR clock_timestamp() - v_run_started > c_whole_run THEN
          v_hit_limit := true;
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_nulled;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'table', v_setting.table_key, 'column', v_setting.payload_column,
        'keep_days', v_setting.payload_keep_days, 'rows_nulled', v_nulled,
        'hit_time_limit', v_hit_limit, 'status', 'ok'));

    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'table', v_setting.table_key, 'status', 'failed', 'error', v_err));
    END;
  END LOOP;

  INSERT INTO public.database_maintenance_jobs(
    action, params, status, triggered_by_email, started_at, finished_at,
    duration_ms, rows_affected)
  VALUES ('payload_prune',
          jsonb_build_object('results', v_results, 'source', 'payload_prune_cron'),
          'completed', 'cron@system', v_started, now(),
          GREATEST(0, EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_run_started))::int),
          v_total);

  PERFORM pg_advisory_unlock(c_lock);
  RETURN jsonb_build_object('total_nulled', v_total, 'results', v_results);
END; $function$;

COMMENT ON FUNCTION public.prune_maintenance_payloads() IS
  'Nulls the configured wide column on rows older than payload_keep_days, keeping the rows. Batched and time-budgeted like the nightly cleanup.';

REVOKE ALL ON FUNCTION public.prune_maintenance_payloads() FROM PUBLIC;

-- Admin-only setter, so the cutoff can be changed without a migration.
CREATE OR REPLACE FUNCTION public.update_maintenance_payload_setting(
  _table_key TEXT,
  _payload_keep_days INTEGER
)
 RETURNS public.database_maintenance_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.database_maintenance_settings%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'admin role required';
  END IF;
  IF _payload_keep_days IS NOT NULL AND _payload_keep_days < 1 THEN
    RAISE EXCEPTION 'payload_keep_days must be >= 1, or NULL to disable';
  END IF;

  UPDATE public.database_maintenance_settings
     SET payload_keep_days = _payload_keep_days, updated_at = now()
   WHERE table_key = _table_key
  RETURNING * INTO v_row;

  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown table_key: %', _table_key; END IF;
  RETURN v_row;
END; $function$;

GRANT EXECUTE ON FUNCTION public.update_maintenance_payload_setting(TEXT, INTEGER) TO authenticated;

-- Runs on the same nights as the catch-up, interleaved between its slots so
-- the two never start together and never share the ~120s ceiling.
SELECT cron.unschedule('maintenance-payload-prune-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'maintenance-payload-prune-15min');

SELECT cron.schedule(
  'maintenance-payload-prune-15min',
  '9,24,39,54 4-7 * * *',
  $cron$SELECT public.prune_maintenance_payloads();$cron$
);

DO $verify$
DECLARE r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== payload tiering configured ========';
  FOR r IN
    SELECT table_key, payload_column, payload_keep_days, retention_days
    FROM public.database_maintenance_settings
    WHERE payload_column IS NOT NULL
  LOOP
    RAISE NOTICE '  % column=% keep=% days (row retention % days)',
      rpad(r.table_key, 30), r.payload_column, r.payload_keep_days, r.retention_days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== scheduled ========';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname IN ('maintenance-payload-prune-15min', 'maintenance-catchup-15min')
           ORDER BY jobname
  LOOP
    RAISE NOTICE '  jobid % | % | % | active=%', r.jobid, rpad(r.jobname, 32), r.schedule, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== backlog to prune ========';
  FOR r IN
    SELECT count(*) AS n
    FROM public.repricer_price_actions
    WHERE created_at < now() - interval '7 days'
      AND intelligence_factors IS NOT NULL
  LOOP
    RAISE NOTICE '  % rows older than 7 days still carry intelligence_factors', r.n;
  END LOOP;
END $verify$;
