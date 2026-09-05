-- Read-only: does the server-side COGS RPC agree with the ladder?
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders
   WHERE asin = 'B0G2YNN87D' ORDER BY order_date DESC LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR r IN
    SELECT * FROM public.get_cogs_for_range(current_date - 1, current_date)
  LOOP
    RAISE NOTICE 'get_cogs_for_range row: %', row_to_json(r)::text;
  END LOOP;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
