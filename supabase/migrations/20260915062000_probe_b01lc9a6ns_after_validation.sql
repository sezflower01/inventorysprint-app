-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- B01LC9A6NS was PENDING_VALIDATION at 13:54 UTC (created 13:39, 3 attempts;
-- recent listings validate in ~21 min). The COG auto-fill trigger
-- (20260915050000) fires on UPDATE of validation_status, so validation should
-- create its COG at 151.02 / 10 = $15.10, source 'listing', not reviewed. This
-- is the first real listing to go through that path rather than a test --
-- confirm it did.

DO $probe$
DECLARE v_uid uuid; r record; v_found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  FOR r IN
    SELECT validation_status, validation_attempts, validation_completed_at, cost, units
    FROM public.created_listings WHERE user_id = v_uid AND asin = 'B01LC9A6NS'
  LOOP
    RAISE NOTICE 'listing: status=% attempts=% completed=% cost=% units=%',
      r.validation_status, r.validation_attempts, r.validation_completed_at, r.cost, r.units;
  END LOOP;

  FOR r IN
    SELECT unit_cost, source, reviewed_at, created_at FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND asin = 'B01LC9A6NS'
  LOOP
    v_found := true;
    RAISE NOTICE 'COG: % source=% reviewed=% created=%', r.unit_cost, r.source, r.reviewed_at IS NOT NULL, r.created_at;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE 'COG: none yet'; END IF;

  FOR r IN
    SELECT action, new_unit_cost, sales_rows_repriced, changed_at, note
    FROM public.asin_cog_on_record_history WHERE user_id = v_uid AND asin = 'B01LC9A6NS' ORDER BY id
  LOOP
    RAISE NOTICE 'history: % -> % | % sales | % | %', r.action, r.new_unit_cost, r.sales_rows_repriced, r.changed_at, r.note;
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_found := false;
  FOR r IN
    SELECT row_number() OVER () AS pos, asin, unit_cost, source, is_restock FROM public.get_cog_page_products()
  LOOP
    IF r.asin = 'B01LC9A6NS' THEN
      v_found := true;
      RAISE NOTICE 'page: position % cog=% source=% restock=%', r.pos, r.unit_cost, r.source, r.is_restock;
    END IF;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE 'page: not listed yet'; END IF;
  SET LOCAL ROLE postgres;
END
$probe$;
