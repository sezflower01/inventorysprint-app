-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The seller created a listing for B01LC9A6NS and does not see it on the COG
-- page. Same trace as 20260915040000 (B01A0LTJBO), plus the auto-fill rule
-- added since (20260915050000): was a COG created from the listing, and does
-- the page function return the product, and where?

DO $probe$
DECLARE v_uid uuid; r record; v_found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. created_listings rows ========';
  FOR r IN
    SELECT id, asin, sku, validation_status, public.is_active_created_listing(validation_status) AS passes,
           date_created, created_at, updated_at, cost, units, amount, (image_url IS NOT NULL) AS img,
           left(COALESCE(title, ''), 50) AS t
    FROM public.created_listings
    WHERE user_id = v_uid AND (asin = 'B01LC9A6NS' OR sku ILIKE '%B01LC9A6NS%' OR title ILIKE '%B01LC9A6NS%')
    ORDER BY created_at DESC
  LOOP
    v_found := true;
    RAISE NOTICE '  % asin=% sku=% status=% passes=% | date_created=% inserted=% updated=% | cost=% units=% amount=% img=% | %',
      r.id, r.asin, r.sku, r.validation_status, r.passes, r.date_created, r.created_at, r.updated_at,
      r.cost, r.units, r.amount, r.img, r.t;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE '  NONE for B01LC9A6NS'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. newest listings of any ASIN ========';
  FOR r IN
    SELECT asin, sku, validation_status, date_created, created_at, cost, units, left(COALESCE(title, ''), 40) AS t
    FROM public.created_listings WHERE user_id = v_uid
    ORDER BY created_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  inserted % | % % status=% date=% cost=% units=% | %',
      r.created_at, r.asin, r.sku, r.validation_status, r.date_created, r.cost, r.units, r.t;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. COG row and history ========';
  FOR r IN
    SELECT unit_cost, source, reviewed_at, needs_review, price_change_unit_cost, created_at, updated_at
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B01LC9A6NS'
  LOOP
    RAISE NOTICE '  cog=% source=% reviewed=% needs_review=% price_change=% created=% updated=%',
      r.unit_cost, r.source, r.reviewed_at, r.needs_review, r.price_change_unit_cost, r.created_at, r.updated_at;
  END LOOP;
  FOR r IN
    SELECT action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_at, note
    FROM public.asin_cog_on_record_history WHERE user_id = v_uid AND asin = 'B01LC9A6NS' ORDER BY id
  LOOP
    RAISE NOTICE '  history: % % -> % | % sales | % | %', r.action, r.old_unit_cost, r.new_unit_cost,
      r.sales_rows_repriced, r.changed_at, COALESCE(r.note, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. page function, as the seller ========';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_found := false;
  FOR r IN
    SELECT row_number() OVER () AS pos, asin, date_created, unit_cost, source, reviewed_at, price_change_unit_cost, is_restock
    FROM public.get_cog_page_products()
  LOOP
    IF r.asin = 'B01LC9A6NS' THEN
      v_found := true;
      RAISE NOTICE '  YES: position % | date % | cog=% source=% reviewed=% price_change=% restock=%',
        r.pos, r.date_created, r.unit_cost, r.source, r.reviewed_at IS NOT NULL, r.price_change_unit_cost, r.is_restock;
    END IF;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE '  NO: not returned'; END IF;
  FOR r IN SELECT asin, date_created, source FROM public.get_cog_page_products() LIMIT 4 LOOP
    RAISE NOTICE '  top: % % source=%', r.date_created, r.asin, r.source;
  END LOOP;
  SET LOCAL ROLE postgres;
END
$probe$;
