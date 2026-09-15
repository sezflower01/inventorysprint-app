-- READ-ONLY PROBE. Every write below is rolled back. Nothing changes.
--
-- The seller chose (2026-09-14): a COG edit applies IMMEDIATELY to all of that
-- ASIN's 2026 sales, no date prompt, with a background change log.
--
-- Before building that, measure what "immediately" costs:
--   1. how long rewriting one ASIN's 2026 sales takes WITH the existing
--      sales_orders triggers -- the largest is B0G4B3117X at 1,308 rows, and a
--      save from the page runs under the authenticated 8-second
--      statement_timeout;
--   2. whether sales_orders is in a realtime publication, which would turn the
--      one-time activation (~37k rows) into a broadcast storm to open tabs;
--   3. which of the ROI-guard columns exist.

DO $probe$
DECLARE
  v_uid uuid;
  t0 timestamptz;
  v_n bigint;
  v_ms numeric;
  r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== realtime publications containing sales_orders ========';
  v_n := 0;
  FOR r IN SELECT pubname FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'sales_orders' LOOP
    RAISE NOTICE '  %', r.pubname; v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '  none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== guard columns ========';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders'
      AND column_name IN ('fees_invalid', 'fees_missing', 'cost_locked_at', 'roi_source', 'cost_invalid')
  LOOP
    RAISE NOTICE '  % %', r.column_name, r.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== timed rewrites (rolled back) ========';
  BEGIN
    t0 := clock_timestamp();
    UPDATE public.sales_orders
       SET unit_cost = unit_cost + 0, total_cost = total_cost + 0
     WHERE user_id = v_uid AND asin = 'B0G4B3117X' AND order_date >= '2026-01-01';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_ms := round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000);
    RAISE NOTICE '  B0G4B3117X: % rows in % ms (%.2f ms/row)', v_n, v_ms, round(v_ms / NULLIF(v_n, 0), 2);

    t0 := clock_timestamp();
    UPDATE public.sales_orders
       SET unit_cost = unit_cost + 0
     WHERE user_id = v_uid AND order_date >= '2026-01-01' AND order_date < '2026-02-01';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_ms := round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000);
    RAISE NOTICE '  January 2026 (all ASINs): % rows in % ms', v_n, v_ms;

    RAISE EXCEPTION 'rollback-probe';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-probe' THEN RAISE; END IF;
    RAISE NOTICE '  (rolled back)';
  END;

  FOR r IN
    SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon, count(*) AS n
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % rows in %', r.n, r.mon;
  END LOOP;
END
$probe$;
