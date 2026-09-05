-- Read-only: September tax, ALL marketplaces vs US only.
-- InventoryLab is US-only, so a like-for-like comparison must filter to US.
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR r IN
    SELECT month_num, sales_tax_collected AS collected,
           marketplace_facilitator_tax AS fac
    FROM public.get_monthly_pl_breakdown(2026) WHERE month_num = 9
  LOOP
    RAISE NOTICE 'ALL marketplaces, Sep: collected=% facilitator=%',
      round(COALESCE(r.collected,0),2), round(COALESCE(r.fac,0),2);
  END LOOP;

  FOR r IN
    SELECT month_num, sales_tax_collected AS collected,
           marketplace_facilitator_tax AS fac
    FROM public.get_monthly_pl_breakdown(2026, 'US') WHERE month_num = 9
  LOOP
    RAISE NOTICE 'US only,          Sep: collected=% facilitator=%',
      round(COALESCE(r.collected,0),2), round(COALESCE(r.fac,0),2);
  END LOOP;

  -- Raw settlement withholding for September, whatever has posted so far.
  FOR r IN
    SELECT COALESCE(sum(amount),0) AS amt, count(*) AS n,
           min(posted_date) AS first_posted, max(posted_date) AS last_posted
    FROM public.settlement_line_items
    WHERE user_id = v_uid AND amount_type = 'ItemWithheldTax'
      AND posted_date >= '2026-09-01' AND posted_date < '2026-10-01'
  LOOP
    RAISE NOTICE 'settlements posted for Sep so far: % rows, $%, % .. %',
      r.n, round(r.amt,2), r.first_posted, r.last_posted;
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
