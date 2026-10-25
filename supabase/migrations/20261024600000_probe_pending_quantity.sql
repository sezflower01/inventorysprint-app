-- READ-ONLY. Multi-unit pending orders stored as quantity 1.
-- Example: 113-1305212-7465044 / B0H854F7VF, Amazon says Quantity 2.
-- Nothing is written. Schema is printed rather than guessed.
DO $p$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== sales_orders columns relevant to this ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sales_orders'
      AND (column_name ILIKE '%quantit%' OR column_name ILIKE '%price%'
        OR column_name ILIKE '%status%' OR column_name ILIKE '%amount%'
        OR column_name ILIKE '%enrich%' OR column_name IN
           ('order_id','asin','sku','seller_sku','order_date','created_at','updated_at'))
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE ORDER: every row, every column ==';
  FOR r IN
    SELECT to_jsonb(s) AS j FROM public.sales_orders s
    WHERE s.order_id = '113-1305212-7465044'
  LOOP
    RAISE NOTICE '   %', left(r.j::text, 1800);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO ROW for 113-1305212-7465044'; END IF;

  SELECT count(*) INTO v_n FROM public.sales_orders WHERE order_id='113-1305212-7465044';
  RAISE NOTICE '   row count for this order: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== price audit trail for this order, if any ==';
  BEGIN
    FOR r IN
      SELECT to_jsonb(a) AS j FROM public.sales_order_price_audit a
      WHERE a.order_id = '113-1305212-7465044' ORDER BY 1 LIMIT 5
    LOOP RAISE NOTICE '   %', left(r.j::text, 500); END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   no audit rows'; END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE '   (sales_order_price_audit not queryable as named: %)', SQLERRM;
  END;
END
$p$;
