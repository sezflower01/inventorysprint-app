-- PROBE (read-only): sales_orders has no amazon_order_id column. Read the real
-- column list before asking anything else of it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_cols text;
BEGIN
  SELECT string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sales_orders';
  RAISE NOTICE 'sales_orders columns:';
  RAISE NOTICE '%', left(v_cols, 3000);

  RAISE NOTICE '';
  RAISE NOTICE '======== unique constraints and indexes ========';
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'sales_orders'
      AND indexdef ILIKE '%UNIQUE%'
  LOOP
    RAISE NOTICE '   %', left(r.indexdef, 200);
  END LOOP;
END
$probe$;
