-- Read-only: how long do the International panel's two RPCs take per market?
SET statement_timeout TO '300s';
DO $$
DECLARE v_uid uuid; t0 timestamptz; r RECORD; mp text;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOREACH mp IN ARRAY ARRAY['ALL','CA','MX','BR','US'] LOOP
    t0 := clock_timestamp();
    PERFORM count(*) FROM public.get_monthly_pl_breakdown(2026, mp);
    RAISE NOTICE '  get_monthly_pl_breakdown(%) took %', rpad(mp,4), clock_timestamp() - t0;

    t0 := clock_timestamp();
    PERFORM count(*) FROM public.get_monthly_cogs(2026, mp);
    RAISE NOTICE '  get_monthly_cogs(%)          took %', rpad(mp,4), clock_timestamp() - t0;
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
