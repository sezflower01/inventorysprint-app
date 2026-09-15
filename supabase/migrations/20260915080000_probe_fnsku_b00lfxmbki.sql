-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The Create extension's label printer refused B00LFXMBKI: "Not safe to print
-- -- no valid Amazon FNSKU found ... appears to use manufacturer barcode". The
-- seller replenished it in Seller Central without issue and printed an FNSKU
-- label there, so Amazon has an FNSKU. The printer reads fnsku_map, inventory
-- and created_listings (ARBIPRO_LOAD_FNSKU_SOURCES), then get-fnsku, then a
-- per-SKU rescue. What does each hold for this ASIN?

DO $probe$
DECLARE v_uid uuid; r record; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== fnsku_map ========';
  v_n := 0;
  BEGIN
    FOR r IN EXECUTE $q$ SELECT to_jsonb(f) AS j FROM public.fnsku_map f WHERE f.asin = 'B00LFXMBKI' $q$ LOOP
      v_n := v_n + 1; RAISE NOTICE '  %', r.j;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  unreadable: %', SQLERRM; END;
  IF v_n = 0 THEN RAISE NOTICE '  none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== inventory ========';
  v_n := 0;
  FOR r IN
    SELECT sku, fnsku, listing_status, available, reserved, inbound, source, condition,
           ghost_reason, updated_at, last_inventory_sync_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '  sku=% fnsku=% status=% avail=% res=% inbound=% source=% cond=% ghost=% updated=% synced=%',
      r.sku, COALESCE(r.fnsku, 'NULL'), r.listing_status, r.available, r.reserved, r.inbound, r.source, r.condition,
      COALESCE(r.ghost_reason, '-'), r.updated_at, r.last_inventory_sync_at;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '  none'; END IF;
EXCEPTION WHEN undefined_column THEN
  RAISE NOTICE '  (column mismatch: %) -- falling back', SQLERRM;
  FOR r IN SELECT to_jsonb(i) - 'raw_data' AS j FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI' LOOP
    RAISE NOTICE '  %', left(r.j::text, 700);
  END LOOP;
END
$probe$;

DO $probe2$
DECLARE v_uid uuid; r record; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '======== created_listings ========';
  FOR r IN
    SELECT sku, fnsku, validation_status, date_created, created_at, updated_at, units, fba_blocked, fba_block_reason,
           validation_failure_code, validation_warning
    FROM public.created_listings WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
    ORDER BY created_at DESC
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '  sku=% fnsku=% status=% date=% created=% updated=% units=% fba_blocked=% reason=% fail=% warn=%',
      r.sku, COALESCE(r.fnsku, 'NULL'), r.validation_status, r.date_created, r.created_at, r.updated_at, r.units,
      r.fba_blocked, COALESCE(r.fba_block_reason, '-'), COALESCE(r.validation_failure_code, '-'), COALESCE(r.validation_warning, '-');
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '  none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== fba eligibility cache ========';
  BEGIN
    FOR r IN EXECUTE format($q$ SELECT to_jsonb(e) AS j FROM public.fba_eligibility_cache e
                              WHERE e.asin = 'B00LFXMBKI' AND e.user_id = %L $q$, v_uid) LOOP
      RAISE NOTICE '  %', left(r.j::text, 600);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  unreadable: %', SQLERRM; END;

  RAISE NOTICE '';
  RAISE NOTICE '======== how common: active listings / stocked inventory without a valid X FNSKU ========';
  FOR r IN
    SELECT count(DISTINCT i.asin) AS asins
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND (COALESCE(i.available, 0) + COALESCE(i.inbound, 0) + COALESCE(i.reserved, 0)) > 0
      AND NOT EXISTS (SELECT 1 FROM public.inventory i2 WHERE i2.user_id = v_uid AND i2.asin = i.asin AND i2.fnsku ~ '^X0')
  LOOP
    RAISE NOTICE '  stocked ASINs with no X-FNSKU on any inventory row: %', r.asins;
  END LOOP;
END
$probe2$;
