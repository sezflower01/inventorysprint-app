-- VERIFY 20260915050000 as the seller, every branch, with made-up ASINs.
-- Everything runs inside a block that rolls back: no listing, COG, sale or
-- history row survives.
--
-- Listings are inserted the way the app does it (role authenticated, the
-- seller's JWT), so the trigger chain runs exactly as it will in production.

DO $verify$
DECLARE
  v_uid uuid;
  v_id  uuid;
  v_id2 uuid;
  r record;
  v_hist_before int;
  v_cog_before int;
  v_real_cog numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT count(*) INTO v_hist_before FROM public.asin_cog_on_record_history WHERE user_id = v_uid;
  SELECT count(*) INTO v_cog_before FROM public.asin_cog_on_record WHERE user_id = v_uid;
  SELECT unit_cost INTO v_real_cog FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B071GWMDWD';

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated', 'email', 'sezflower01@gmail.com')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    -- A. brand-new product with a real cost -> COG filled, From listing, not reviewed, logged
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZTEST01', 'TEST-SKU-01', 'Verify A', 50.00, 5, 10.00, current_date, 'ACTIVE')
    RETURNING id INTO v_id;
    FOR r IN SELECT unit_cost, source, reviewed_at, calculated_cost FROM public.asin_cog_on_record WHERE asin = 'B0ZZTEST01' LOOP
      RAISE NOTICE 'A new product $50/5: cog=% source=% reviewed=% calculated=%', r.unit_cost, r.source, r.reviewed_at IS NOT NULL, r.calculated_cost;
    END LOOP;
    FOR r IN SELECT action, new_unit_cost, changed_by_email, note FROM public.asin_cog_on_record_history WHERE asin = 'B0ZZTEST01' ORDER BY id DESC LIMIT 1 LOOP
      RAISE NOTICE '  history: % -> % by % | %', r.action, r.new_unit_cost, r.changed_by_email, r.note;
    END LOOP;

    -- B. the seller corrects that listing's cost while unreviewed -> COG follows
    UPDATE public.created_listings SET cost = 60.00, amount = 12.00 WHERE id = v_id;
    FOR r IN SELECT unit_cost, source FROM public.asin_cog_on_record WHERE asin = 'B0ZZTEST01' LOOP
      RAISE NOTICE 'B same listing corrected to $60/5: cog=% source=% (expect 12.00, listing)', r.unit_cost, r.source;
    END LOOP;

    -- C. restock +67% -> COG untouched, price change flagged
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZTEST01', 'TEST-SKU-01', 'Verify A', 100.00, 5, 20.00, current_date, 'ACTIVE')
    RETURNING id INTO v_id2;
    FOR r IN SELECT unit_cost, price_change_unit_cost, price_change_units FROM public.asin_cog_on_record WHERE asin = 'B0ZZTEST01' LOOP
      RAISE NOTICE 'C restock at $20/unit: cog=% (expect 12.00) price_change=% units=%', r.unit_cost, r.price_change_unit_cost, r.price_change_units;
    END LOOP;

    -- D. once reviewed, editing the original listing no longer moves the COG
    UPDATE public.asin_cog_on_record SET reviewed_at = now() WHERE asin = 'B0ZZTEST01';
    UPDATE public.created_listings SET cost = 70.00, amount = 14.00 WHERE id = v_id;
    FOR r IN SELECT unit_cost FROM public.asin_cog_on_record WHERE asin = 'B0ZZTEST01' LOOP
      RAISE NOTICE 'D reviewed, original listing edited to $14/unit: cog=% (expect 12.00)', r.unit_cost;
    END LOOP;

    -- E. no cost / F. placeholder / G. unit price typed into the total -> no COG
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZTEST02', 'TEST-SKU-02', 'Verify E', 0, 5, 0, current_date, 'ACTIVE');
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZTEST03', 'TEST-SKU-03', 'Verify F', 1.00, 50, 0.02, current_date, 'ACTIVE');
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B0ZZTEST04', 'TEST-SKU-04', 'Verify G', 7.49, 10, 7.49, current_date, 'ACTIVE');
    FOR r IN SELECT a.asin, EXISTS (SELECT 1 FROM public.asin_cog_on_record c WHERE c.asin = a.asin) AS has_cog
             FROM (VALUES ('B0ZZTEST02', 'no cost'), ('B0ZZTEST03', 'placeholder $0.02'), ('B0ZZTEST04', 'unit price in total')) AS a(asin, why)
    LOOP
      RAISE NOTICE 'E/F/G % -> COG created: % (expect false)', r.asin, r.has_cog;
    END LOOP;

    -- E2. that no-cost listing is costed later in the edit dialog -> COG filled then
    UPDATE public.created_listings SET cost = 40.00, amount = 8.00 WHERE asin = 'B0ZZTEST02';
    FOR r IN SELECT unit_cost, source FROM public.asin_cog_on_record WHERE asin = 'B0ZZTEST02' LOOP
      RAISE NOTICE 'E2 costed later at $40/5: cog=% source=% (expect 8.00, listing)', r.unit_cost, r.source;
    END LOOP;

    -- H. restock within 25% on a real product -> nothing flagged, COG untouched
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, amount, date_created, validation_status)
    VALUES (v_uid, 'B071GWMDWD', 'TEST-SKU-H', 'Verify H', 70.00, 5, 14.00, current_date, 'ACTIVE');
    FOR r IN SELECT unit_cost, price_change_unit_cost FROM public.asin_cog_on_record WHERE asin = 'B071GWMDWD' LOOP
      RAISE NOTICE 'H real restock $14 vs COG %: cog now % price_change=% (expect unchanged, null)', v_real_cog, r.unit_cost, COALESCE(r.price_change_unit_cost::text, 'null');
    END LOOP;

    -- I. the page function exposes the new state
    FOR r IN SELECT asin, source, reviewed_at IS NOT NULL AS reviewed, price_change_unit_cost
             FROM public.get_cog_page_products() WHERE asin IN ('B0ZZTEST01', 'B0ZZTEST02') ORDER BY asin LOOP
      RAISE NOTICE 'I page: % source=% reviewed=% price_change=%', r.asin, r.source, r.reviewed, r.price_change_unit_cost;
    END LOOP;

    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
    RAISE NOTICE '(rolled back)';
  END;

  SET LOCAL ROLE postgres;
  FOR r IN
    SELECT (SELECT count(*) FROM public.asin_cog_on_record WHERE user_id = v_uid) AS cogs,
           (SELECT count(*) FROM public.asin_cog_on_record_history WHERE user_id = v_uid) AS hist,
           (SELECT count(*) FROM public.created_listings WHERE user_id = v_uid AND asin LIKE 'B0ZZTEST%') AS test_listings,
           (SELECT unit_cost FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B071GWMDWD') AS real_cog
  LOOP
    RAISE NOTICE 'after rollback: COG rows % (was %) | history % (was %) | test listings % | B071GWMDWD cog % (was %)',
      r.cogs, v_cog_before, r.hist, v_hist_before, r.test_listings, r.real_cog, v_real_cog;
  END LOOP;
END
$verify$;
