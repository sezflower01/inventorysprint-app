-- Read-only: sales tax collected vs facilitator tax withheld, month by month.
-- In a facilitator state Amazon COLLECTS the tax from the buyer and WITHHOLDS
-- the same money to remit it. The two should offset; a month with one and not
-- the other overstates profit by that amount.
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR r IN
    SELECT b.month_num,
           b.sales_tax_collected        AS collected,
           b.marketplace_facilitator_tax AS fac_from_events,
           f.facilitator_tax             AS fac_from_settlements
    FROM public.get_monthly_pl_breakdown(2026) b
    LEFT JOIN public.get_monthly_facilitator_tax(2026, 'ALL') f
      ON f.month_num = b.month_num
    ORDER BY b.month_num LIMIT 10
  LOOP
    RAISE NOTICE '  month % | collected=% | facilitator: events=% settlements=% | net=%',
      r.month_num,
      round(COALESCE(r.collected,0), 2),
      round(COALESCE(r.fac_from_events,0), 2),
      round(COALESCE(r.fac_from_settlements,0), 2),
      round(COALESCE(r.collected,0) - COALESCE(r.fac_from_settlements,0), 2);
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
