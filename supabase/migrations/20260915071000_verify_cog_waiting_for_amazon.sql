-- VERIFY 20260915070000 as the seller, with made-up ASINs. Everything rolls
-- back: no listing, COG, sale or history row survives.
--
--   W1 a listing saved PENDING_VALIDATION is on the page at once, "waiting",
--      with no COG (auto-fill still waits for Amazon)
--   W2 the seller types a COG while it waits
--   W3 Amazon confirms it: the typed COG is kept and NO "Price changed" flag is
--      raised, although the listing's own cost is 50% away
--   W4 a waiting listing with no typed COG is auto-filled on confirmation
--   W5 a rejected (FAILED_VALIDATION) listing never reaches the page
--   W6 a genuine restock on an imported COG still raises the flag
--   plus: the page's existing rows and the COG table are unchanged after

DO $verify$
DECLARE
  v_uid uuid;
  v_id1 uuid;
  v_id2 uuid;
  r record;
  v_rows_before int;
  v_rows_after int;
  v_fp_before text;
  v_fp_after text;
  v_real_asin text;
  v_real_cog numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT md5(string_agg(concat_ws('|', asin, unit_cost, source, reviewed_at, price_change_unit_cost), ',' ORDER BY asin))
    INTO v_fp_before FROM public.asin_cog_on_record WHERE user_id = v_uid;

  -- An imported COG with no review, for W6.
  SELECT asin, unit_cost INTO v_real_asin, v_real_cog
  FROM public.asin_cog_on_record
  WHERE user_id = v_uid AND source = 'import' AND reviewed_at IS NULL AND unit_cost > 1 AND price_change_unit_cost IS NULL
  ORDER BY asin LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated', 'email', 'sezflower01@gmail.com')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_rows_before FROM public.get_cog_page_products();
  RAISE NOTICE 'page rows before: %', v_rows_before;

  BEGIN
    -- W1
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZWAIT01', 'WAIT-SKU-1', 'Verify W1', 50.00, 5, 10.00, current_date, 'PENDING_VALIDATION')
    RETURNING id INTO v_id1;
    FOR r IN SELECT row_number() OVER () AS pos, asin, awaiting_amazon, pending_listing_count, cog_id, unit_cost
             FROM public.get_cog_page_products() LOOP
      IF r.asin = 'B0ZZWAIT01' THEN
        RAISE NOTICE 'W1 saved waiting: on page at position % | awaiting=% pending=% | COG row=% (expect true, 1, false)',
          r.pos, r.awaiting_amazon, r.pending_listing_count, r.cog_id IS NOT NULL;
      END IF;
    END LOOP;

    -- W2: the page's exact insert for a product without a COG row
    INSERT INTO public.asin_cog_on_record (user_id, asin, unit_cost, source, title, reviewed_at)
    VALUES (v_uid, 'B0ZZWAIT01', 15.00, 'manual', 'Verify W1', now());
    RAISE NOTICE 'W2 seller typed $15.00 while waiting';

    -- W3: Amazon confirms
    UPDATE public.created_listings SET validation_status = 'ACTIVE', validation_completed_at = now() WHERE id = v_id1;
    FOR r IN SELECT unit_cost, source, price_change_unit_cost FROM public.asin_cog_on_record WHERE asin = 'B0ZZWAIT01' LOOP
      RAISE NOTICE 'W3 confirmed: cog=% source=% price_change=% (expect 15.00, manual, null)',
        r.unit_cost, r.source, COALESCE(r.price_change_unit_cost::text, 'null');
    END LOOP;
    FOR r IN SELECT awaiting_amazon FROM public.get_cog_page_products() WHERE asin = 'B0ZZWAIT01' LOOP
      RAISE NOTICE '   page awaiting after confirmation: % (expect false)', r.awaiting_amazon;
    END LOOP;

    -- W4
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZWAIT02', 'WAIT-SKU-2', 'Verify W4', 40.00, 4, 10.00, current_date, 'PENDING_VALIDATION')
    RETURNING id INTO v_id2;
    SELECT count(*) INTO v_rows_after FROM public.asin_cog_on_record WHERE asin = 'B0ZZWAIT02';
    RAISE NOTICE 'W4 waiting, before confirmation: COG rows=% (expect 0)', v_rows_after;
    UPDATE public.created_listings SET validation_status = 'ACTIVE', validation_completed_at = now() WHERE id = v_id2;
    FOR r IN SELECT unit_cost, source, reviewed_at FROM public.asin_cog_on_record WHERE asin = 'B0ZZWAIT02' LOOP
      RAISE NOTICE '   after confirmation: cog=% source=% reviewed=% (expect 10.00, listing, false)',
        r.unit_cost, r.source, r.reviewed_at IS NOT NULL;
    END LOOP;

    -- W5
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZWAIT03', 'WAIT-SKU-3', 'Verify W5', 30.00, 3, 10.00, current_date, 'FAILED_VALIDATION');
    SELECT count(*) INTO v_rows_after FROM public.get_cog_page_products() WHERE asin = 'B0ZZWAIT03';
    RAISE NOTICE 'W5 rejected listing on page: % (expect 0)', v_rows_after;

    -- W6
    IF v_real_asin IS NOT NULL THEN
      INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
      VALUES (v_uid, v_real_asin, 'WAIT-SKU-6', 'Verify W6', round(v_real_cog * 2 * 5, 2), 5, round(v_real_cog * 2, 2), current_date, 'ACTIVE');
      FOR r IN SELECT unit_cost, price_change_unit_cost FROM public.asin_cog_on_record WHERE asin = v_real_asin LOOP
        RAISE NOTICE 'W6 restock at 2x on imported % (cog %): cog now % price_change=% (expect unchanged, flagged)',
          v_real_asin, v_real_cog, r.unit_cost, r.price_change_unit_cost;
      END LOOP;
    END IF;

    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
    RAISE NOTICE '(rolled back)';
  END;

  SELECT count(*) INTO v_rows_after FROM public.get_cog_page_products();
  SET LOCAL ROLE postgres;
  SELECT md5(string_agg(concat_ws('|', asin, unit_cost, source, reviewed_at, price_change_unit_cost), ',' ORDER BY asin))
    INTO v_fp_after FROM public.asin_cog_on_record WHERE user_id = v_uid;
  RAISE NOTICE 'after rollback: page rows % (was %) | COG fingerprint % (was %) | test listings left %',
    v_rows_after, v_rows_before, left(v_fp_after, 12), left(v_fp_before, 12),
    (SELECT count(*) FROM public.created_listings WHERE user_id = v_uid AND asin LIKE 'B0ZZWAIT%');
END
$verify$;
