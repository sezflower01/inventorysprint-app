-- READ-ONLY. Does the P&L's COGS multiply by a unit count?
DO $p$
DECLARE v_def text; r record;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), '%', '%%') INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_monthly_cogs' LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'get_monthly_cogs not found; functions containing cog:';
    FOR r IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname ILIKE '%cog%' ORDER BY 1
    LOOP RAISE NOTICE '   %', r.proname; END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== does it reference quantity / unit_cost / total_cost? ==';
  RAISE NOTICE '   quantity   : %', position('quantity'   in v_def) > 0;
  RAISE NOTICE '   unit_cost  : %', position('unit_cost'  in v_def) > 0;
  RAISE NOTICE '   total_cost : %', position('total_cost' in v_def) > 0;
  RAISE NOTICE '   sales_orders: %', position('sales_orders' in v_def) > 0;

  RAISE NOTICE '';
  RAISE NOTICE '== the SUM lines ==';
  FOR r IN
    SELECT trim(line) AS line FROM regexp_split_to_table(v_def, E'\n') AS line
    WHERE line ILIKE '%SUM%' OR line ILIKE '%quantity%' OR line ILIKE '%unit_cost%'
    LIMIT 8
  LOOP RAISE NOTICE '   %', left(r.line,150); END LOOP;
END
$p$;
