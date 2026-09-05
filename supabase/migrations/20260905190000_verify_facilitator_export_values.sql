-- Read-only: the values the Excel export will now merge in.
DO $$
DECLARE r RECORD; v_uid uuid; v_tot numeric := 0;
BEGIN
  SELECT user_id INTO v_uid FROM public.settlement_line_items
   WHERE amount_type = 'ItemWithheldTax' LIMIT 1;
  IF v_uid IS NULL THEN
    SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR r IN
    SELECT month_num, facilitator_tax, facilitator_tax_refunds, adjustment
    FROM public.get_monthly_facilitator_tax(2026, 'ALL')
    ORDER BY month_num
  LOOP
    v_tot := v_tot + COALESCE(r.facilitator_tax, 0);
    RAISE NOTICE '  month % : tax=% refunds=% adjustment=%',
      r.month_num, round(r.facilitator_tax, 2),
      round(COALESCE(r.facilitator_tax_refunds,0), 2), round(COALESCE(r.adjustment,0), 2);
  END LOOP;
  RAISE NOTICE 'YEAR TOTAL: % (screen shows 51,652.18)', round(v_tot, 2);

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
