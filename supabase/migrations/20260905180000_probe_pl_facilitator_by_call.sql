-- Read-only: does the marketplace argument zero out facilitator tax?
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders
   WHERE order_date >= '2026-01-01' LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE '--- 1-arg: get_monthly_pl_breakdown(2026) ---';
  FOR r IN
    SELECT month_num, marketplace_facilitator_tax AS fac
    FROM public.get_monthly_pl_breakdown(2026)
    ORDER BY month_num LIMIT 9
  LOOP
    RAISE NOTICE '  month % : %', r.month_num, r.fac;
  END LOOP;

  RAISE NOTICE '--- 2-arg with NULL marketplace ---';
  FOR r IN
    SELECT month_num, marketplace_facilitator_tax AS fac
    FROM public.get_monthly_pl_breakdown(2026, NULL)
    ORDER BY month_num LIMIT 5
  LOOP
    RAISE NOTICE '  month % : %', r.month_num, r.fac;
  END LOOP;

  RAISE NOTICE '--- 2-arg with US ---';
  FOR r IN
    SELECT month_num, marketplace_facilitator_tax AS fac
    FROM public.get_monthly_pl_breakdown(2026, 'US')
    ORDER BY month_num LIMIT 5
  LOOP
    RAISE NOTICE '  month % : %', r.month_num, r.fac;
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
