-- READ-ONLY. "Keepa shows no CA/BR/MX sales or Buy Box -- can we treat it as
-- an estimate and still compute the fees?"
--
-- Two separate questions hiding in one. Keepa coverage decides whether a SALES
-- estimate is possible; asin_fee_cache decides whether FEES are, and the two
-- are independent. Measure each before agreeing a direction.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. FEE data we hold, by marketplace ==';
  FOR r IN
    SELECT marketplace, count(*) AS asins,
           count(*) FILTER (WHERE referral_rate > 0) AS with_referral,
           count(*) FILTER (WHERE fba_fee_fixed > 0) AS with_fba,
           round(avg(referral_rate * 100)::numeric, 2) AS avg_referral_pct,
           round(avg(fba_fee_fixed)::numeric, 2) AS avg_fba,
           count(DISTINCT fee_source) AS sources,
           max(updated_at) AS newest
    FROM public.asin_fee_cache WHERE user_id = v_uid
    GROUP BY 1 ORDER BY asins DESC
  LOOP
    RAISE NOTICE '  % | % ASINs | % referral | % fba | avg % pct / $% | % sources | newest %',
      rpad(r.marketplace, 4), lpad(r.asins::text, 5), lpad(r.with_referral::text, 5),
      lpad(r.with_fba::text, 5), r.avg_referral_pct, r.avg_fba, r.sources, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   -> fees ARE available per marketplace. That half needs no estimate.';

  RAISE NOTICE '';
  RAISE NOTICE '== 2. are those non-US fee rows actually RIGHT? vs what Amazon billed ==';
  FOR r IN
    SELECT COALESCE(so.marketplace, '-') AS mk,
           count(*) AS asins_compared,
           round(avg(fc.fba_fee_fixed)::numeric, 2) AS cached_fba,
           round(avg(a.actual_fba)::numeric, 2) AS billed_fba,
           round((100 * avg((a.actual_fba - fc.fba_fee_fixed)
                 / NULLIF(fc.fba_fee_fixed, 0)))::numeric, 1) AS err_pct
    FROM (
      SELECT asin, marketplace, sum(fba_fee) / NULLIF(sum(quantity), 0) AS actual_fba
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND%' AND COALESCE(fba_fee, 0) > 0
        AND upper(COALESCE(fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY 1, 2
    ) a
    JOIN public.sales_orders so ON so.asin = a.asin AND so.marketplace = a.marketplace
                              AND so.user_id = v_uid
    JOIN public.asin_fee_cache fc ON fc.user_id = v_uid AND fc.asin = a.asin
                               AND fc.marketplace = a.marketplace AND fc.fba_fee_fixed > 0
    GROUP BY 1 ORDER BY asins_compared DESC
  LOOP
    RAISE NOTICE '  % | % compared | cached $% vs billed $% | % pct out',
      rpad(r.mk, 4), lpad(r.asins_compared::text, 6), r.cached_fba, r.billed_fba, r.err_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. Keepa / price-stability coverage, by marketplace ==';
  SELECT count(*) INTO n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'asin_price_stability_cache';
  IF n = 0 THEN
    RAISE NOTICE '  (no asin_price_stability_cache table -- listing candidates)';
    FOR r IN SELECT table_name FROM information_schema.tables
             WHERE table_schema='public' AND (table_name ILIKE '%keepa%' OR table_name ILIKE '%stability%')
             ORDER BY table_name LOOP
      RAISE NOTICE '    %', r.table_name;
    END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. inventory is ONE pool for all four marketplaces ==';
  FOR r IN
    SELECT count(DISTINCT asin) AS asins, count(*) AS rows,
           sum(COALESCE(available,0) + COALESCE(reserved,0)) AS units
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  % ASINs | % rows | % units (no marketplace column -- one pool)',
      r.asins, r.rows, r.units;
  END LOOP;
END
$p$;
