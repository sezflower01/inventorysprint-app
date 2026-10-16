-- READ-ONLY. "Fees never update, still says missing MX fee cache."
-- isFeeCacheMissingForNonUs fires when: non-US row, no real stored fees, AND
-- no asin_fee_cache entry. Find which of those three is true.
DO $p$
DECLARE v_uid uuid; r record; v_fx numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_fx FROM public.fx_rates WHERE base='USD' AND quote='MXN' LIMIT 1;
  RAISE NOTICE '== USD/MXN = % ==', v_fx;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. the order itself ==';
  FOR r IN
    SELECT order_id, asin, quantity AS qty, marketplace AS mk,
           sold_price, estimated_price, locked_est_price,
           COALESCE(locked_from,'-') AS lf, COALESCE(price_source,'-') AS psrc,
           referral_fee, fba_fee, closing_fee, total_fees,
           COALESCE(fees_source,'NULL') AS fsrc,
           COALESCE(fees_missing::text,'NULL') AS fmiss,
           COALESCE(needs_fee_enrich::text,'NULL') AS nfe,
           COALESCE(next_enrich_after::text,'NULL') AS nea,
           COALESCE(enrich_attempts,0) AS att,
           COALESCE(last_enrich_error,'(none)') AS lerr,
           COALESCE(last_enrich_attempt_at::text,'never') AS latt
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807'
  LOOP
    RAISE NOTICE '   % % q% %', r.order_id, r.asin, r.qty, r.mk;
    RAISE NOTICE '   est % MXN (locked %) from % | src %',
      r.estimated_price, COALESCE(r.locked_est_price::text,'NULL'), r.lf, r.psrc;
    RAISE NOTICE '   Amazon shows MX$392.30/unit -> Keepa estimate is % pct out',
      round((100*(r.estimated_price-392.30)/392.30)::numeric,1);
    RAISE NOTICE '   fees: referral % | fba % | closing % | total %',
      COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
      COALESCE(r.closing_fee::text,'NULL'), COALESCE(r.total_fees::text,'NULL');
    RAISE NOTICE '   fees_source % | fees_missing % | needs_fee_enrich %',
      r.fsrc, r.fmiss, r.nfe;
    RAISE NOTICE '   next_enrich_after % | attempts % | last attempt %',
      r.nea, r.att, r.latt;
    RAISE NOTICE '   last_enrich_error %', r.lerr;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (order not in sales_orders yet)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. is there an MX fee-cache row for this ASIN? ==';
  FOR r IN
    SELECT marketplace AS mk, referral_rate, fba_fee_fixed,
           COALESCE(fee_source,'-') AS src, COALESCE(last_error,'(none)') AS lerr, updated_at
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND asin = 'B003F35R34' ORDER BY marketplace
  LOOP
    RAISE NOTICE '   % | rate % | fba_fee_fixed % | % | %',
      rpad(r.mk,3), COALESCE(r.referral_rate::text,'NULL'),
      COALESCE(r.fba_fee_fixed::text,'NULL'), rpad(r.src,16), r.updated_at;
    RAISE NOTICE '        last_error %', r.lerr;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (NO fee-cache row for this ASIN in ANY marketplace)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. did MY quarantine on 2026-10-14 zero this ASIN? ==';
  FOR r IN
    SELECT reason, row_data->>'marketplace' AS mk,
           row_data->>'fba_fee_fixed' AS old_fba,
           row_data->>'fee_source' AS old_src, backed_up_at
    FROM public.backup_fee_cache_currency_20261014
    WHERE row_data->>'asin' = 'B003F35R34'
  LOOP
    RAISE NOTICE '   % | % | old fba % from % | backed up %',
      r.reason, r.mk, r.old_fba, r.old_src, r.backed_up_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (not quarantined - the gap predates that)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. MX fee-cache health overall (how widespread?) ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS rows,
           count(*) FILTER (WHERE fba_fee_fixed > 0) AS with_fba,
           count(*) FILTER (WHERE COALESCE(fba_fee_fixed,0) = 0) AS zero_fba
    FROM public.asin_fee_cache WHERE user_id = v_uid AND marketplace <> 'US'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | % usable | % ZERO (these read as "missing")',
      rpad(r.mk,3), lpad(r.rows::text,4), lpad(r.with_fba::text,4), lpad(r.zero_fba::text,4);
  END LOOP;
END
$p$;
