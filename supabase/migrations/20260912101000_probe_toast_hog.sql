-- READ-ONLY PROBE, part 2. Creates nothing, changes nothing.
--
-- Probe 1 found the real shape of the 15 GB: repricer_price_actions is 7,022 MB
-- of which the HEAP is only 749 MB. 5,167 MB is TOAST and 1,106 MB is indexes.
-- The maintenance dashboard reports "bloat 1.6%" for this table because it
-- measures dead tuples in the heap, which is the 749 MB it can see -- so the
-- table reads as healthy while being the single largest object in the database.
--
-- TOAST at 5.1 GB over 1.5M rows is ~3.5 KB of out-of-line data per row. That
-- is one or two wide columns, not the table being big. Naming the column is
-- what decides the fix: trimming what is written costs nothing and stops the
-- growth permanently, whereas VACUUM FULL is a lock that buys time once.
--
-- Measures, per column, the average stored size over the most recent 2,000
-- rows. Sampled rather than scanned: a full pass over 7 GB would hit the
-- statement timeout, and the newest rows are the ones that describe what is
-- being written NOW, which is the number that matters for growth.

DO $probe$
DECLARE
  r       record;
  v_num   numeric;
  v_total numeric;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== avg stored bytes per column, newest 2000 rows ========';

  FOR r IN
    SELECT 'repricer_price_actions'::text AS tbl UNION ALL
    SELECT 'repricer_ai_decisions'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '  ---- % ----', r.tbl;
    v_total := 0;
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = r.tbl
        ORDER BY ordinal_position
      LOOP
        BEGIN
          EXECUTE format(
            'SELECT COALESCE(avg(pg_column_size(%I)), 0) FROM '
            '(SELECT %I FROM public.%I ORDER BY created_at DESC LIMIT 2000) s',
            c.column_name, c.column_name, r.tbl)
          INTO v_num;
        EXCEPTION WHEN others THEN
          v_num := -1;
        END;
        v_total := v_total + GREATEST(v_num, 0);
        -- Only the columns that matter are printed; a 4-byte int is noise.
        IF v_num >= 40 OR v_num < 0 THEN
          RAISE NOTICE '    % % bytes  (%)',
            rpad(c.column_name, 34), lpad(round(v_num, 0)::text, 8), c.data_type;
        END IF;
      END LOOP;
    END;
    RAISE NOTICE '    %  ~% bytes/row across all columns',
      rpad('TOTAL', 34), lpad(round(v_total, 0)::text, 8);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how much VACUUM FULL would actually return ========';
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgstattuple;
    FOR r IN
      SELECT 'repricer_price_actions' AS tbl UNION ALL
      SELECT 'repricer_ai_decisions'
    LOOP
      DECLARE s record;
      BEGIN
        EXECUTE format('SELECT * FROM pgstattuple_approx(%L)', 'public.' || r.tbl) INTO s;
        RAISE NOTICE '  % heap free=% (%%% of heap), dead=%',
          rpad(r.tbl, 26),
          pg_size_pretty(s.approx_free_space::bigint),
          round(s.approx_free_percent::numeric, 1),
          s.dead_tuple_count;
      EXCEPTION WHEN others THEN
        RAISE NOTICE '  % pgstattuple_approx failed: %', r.tbl, SQLERRM;
      END;
    END LOOP;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  pgstattuple unavailable: %', SQLERRM;
  END;
END
$probe$;
