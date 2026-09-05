-- Read-only: effective sales-tax rate per month.
--
-- An independent sanity check that needs no external report: US combined
-- state+local rates run roughly 6-8%, so tax as a share of sales should sit in
-- that band every month. A month far outside it is the one to distrust.
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR r IN
    SELECT b.month_num, b.sales, b.sales_tax_collected AS tax,
           CASE WHEN COALESCE(b.sales,0) > 0
                THEN round(100.0 * COALESCE(b.sales_tax_collected,0) / b.sales, 2)
           END AS pct
    FROM public.get_monthly_pl_breakdown(2026, 'US') b
    WHERE COALESCE(b.sales,0) > 0
    ORDER BY b.month_num
  LOOP
    RAISE NOTICE '  month % | sales=% | tax=% | effective rate = %%%',
      r.month_num, round(r.sales,2), round(COALESCE(r.tax,0),2), r.pct;
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
