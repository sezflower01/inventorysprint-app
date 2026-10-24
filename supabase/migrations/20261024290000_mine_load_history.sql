-- ITEM 1, READ-ONLY. Mine the recorded load history for the outage window.
--
-- The schemas are printed first rather than assumed: guessing column names has
-- cost several migrations in this exercise already.
DO $p$
DECLARE r record; v_cols text;
BEGIN
  RAISE NOTICE '== schemas ==';
  FOR r IN
    SELECT table_name,
           string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('system_load_snapshot','slow_query_samples')
    GROUP BY table_name ORDER BY table_name
  LOOP
    RAISE NOTICE '   %:', r.table_name;
    RAISE NOTICE '      %', left(r.cols, 1200);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   neither table exists'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== coverage: how far back does each go? ==';
  FOR r IN
    SELECT 'system_load_snapshot' AS t, count(*) AS n,
           min(captured_at) AS lo, max(captured_at) AS hi
    FROM public.system_load_snapshot
  LOOP RAISE NOTICE '   % | % rows | % .. %', r.t, r.n, r.lo, r.hi; END LOOP;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE '   (system_load_snapshot has no captured_at; see the schema above)';
END
$p$;
