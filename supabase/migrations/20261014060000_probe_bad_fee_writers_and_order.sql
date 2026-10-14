-- READ-ONLY. Diagnose the two suspect fee writers, and trace order
-- 701-1848920-5681843 end to end. Nothing is changed here.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== A. the suspect rows, against a trusted row for the SAME ASIN ==';
  RAISE NOTICE '   trusted = sp_api_live or fees_api on the same asin+marketplace';
  FOR r IN
    WITH bad AS (
      SELECT asin, marketplace, fee_source, fba_fee_fixed, referral_rate
      FROM public.asin_fee_cache
      WHERE user_id = v_uid AND fee_source IN ('live_roi_floor', 'live_verified')
    ), good AS (
      SELECT asin, marketplace, avg(fba_fee_fixed) AS fba, avg(referral_rate) AS rate
      FROM public.asin_fee_cache
      WHERE user_id = v_uid AND fee_source IN ('sp_api_live', 'fees_api')
      GROUP BY 1, 2
    )
    SELECT b.marketplace AS mk, b.fee_source AS src, count(*) AS rows,
           round(avg(b.fba_fee_fixed)::numeric, 2) AS bad_fba,
           round(avg(g.fba)::numeric, 2) AS good_fba,
           round(avg(b.fba_fee_fixed / NULLIF(g.fba, 0))::numeric, 2) AS ratio,
           round(avg(b.referral_rate * 100)::numeric, 2) AS bad_ref_pct,
           round(avg(g.rate * 100)::numeric, 2) AS good_ref_pct
    FROM bad b JOIN good g ON g.asin = b.asin AND g.marketplace = b.marketplace
    GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE '  % | % | % overlapping | fba $% vs $% (x%) | referral % vs % pct',
      rpad(r.mk, 4), rpad(r.src, 16), lpad(r.rows::text, 4),
      lpad(r.bad_fba::text, 8), lpad(r.good_fba::text, 7), lpad(r.ratio::text, 6),
      r.bad_ref_pct, r.good_ref_pct;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no ASIN has both a suspect and a trusted row)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== B. how far out of range are they on their own terms? ==';
  FOR r IN
    SELECT COALESCE(fee_source, '(null)') AS src, marketplace AS mk, count(*) AS rows,
           count(*) FILTER (WHERE referral_rate > 0.25) AS referral_over_25pct,
           count(*) FILTER (WHERE fba_fee_fixed > 25) AS fba_over_25,
           round(max(referral_rate * 100)::numeric, 2) AS max_ref_pct,
           round(max(fba_fee_fixed)::numeric, 2) AS max_fba
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND fba_fee_fixed > 0
    GROUP BY 1, 2
    HAVING count(*) FILTER (WHERE referral_rate > 0.25) > 0
        OR count(*) FILTER (WHERE fba_fee_fixed > 25) > 0
    ORDER BY referral_over_25pct DESC, fba_over_25 DESC
  LOOP
    RAISE NOTICE '  % | % | % rows | % with referral >25 pct | % with fba >$25 | max % pct / $%',
      rpad(r.src, 18), rpad(r.mk, 4), lpad(r.rows::text, 5),
      lpad(r.referral_over_25pct::text, 4), lpad(r.fba_over_25::text, 4),
      r.max_ref_pct, r.max_fba;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== C. order 701-1848920-5681843: where did $69.60 come from? ==';
  FOR r IN
    SELECT so.quantity, so.estimated_price, so.referral_fee, so.fba_fee, so.total_fees,
           COALESCE(so.price_source, '-') AS psrc, COALESCE(so.fees_source, '-') AS fsrc,
           fx.rate
    FROM public.sales_orders so
    CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base = 'USD' AND quote = 'CAD' LIMIT 1) fx
    WHERE so.user_id = v_uid AND so.order_id = '701-1848920-5681843'
  LOOP
    RAISE NOTICE '  estimated_price % CAD/unit x % units = CA$% / % = US$%',
      r.estimated_price, r.quantity,
      round((r.estimated_price * r.quantity)::numeric, 2), r.rate,
      round((r.estimated_price * r.quantity / r.rate)::numeric, 2);
    RAISE NOTICE '  per unit in USD: CA$% / % = US$%',
      r.estimated_price, r.rate, round((r.estimated_price / r.rate)::numeric, 2);
    RAISE NOTICE '  price_source % | fees_source %', r.psrc, r.fsrc;
    RAISE NOTICE '  stored fees: referral $% + fba $% = $%',
      round(r.referral_fee::numeric, 2), round(r.fba_fee::numeric, 2),
      round(r.total_fees::numeric, 2);
    RAISE NOTICE '  referral as pct of the USD estimate: % pct',
      round((100 * r.referral_fee / NULLIF(r.estimated_price * r.quantity / r.rate, 0))::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== D. is CA$49.56 our CA list price, or a converted US one? ==';
  FOR r IN
    SELECT COALESCE(marketplace_id, '-') AS mp, my_price, COALESCE(currency, '-') AS cur,
           COALESCE(source, '-') AS src, COALESCE(seller_sku, '-') AS sku, fetched_at
    FROM public.asin_my_price_cache
    WHERE user_id = v_uid AND asin = 'B00DLD1C0A'
    ORDER BY fetched_at DESC
  LOOP
    RAISE NOTICE '  % | my_price % | % | % | sku % | %',
      rpad(r.mp, 16), lpad(r.my_price::text, 9), rpad(r.cur, 5), rpad(r.src, 16), rpad(r.sku, 14), r.fetched_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no my-price cache row for this ASIN)'; END IF;

  FOR r IN
    SELECT sku, price, my_price, cost FROM public.inventory
    WHERE user_id = v_uid AND asin = 'B00DLD1C0A'
  LOOP
    RAISE NOTICE '  inventory (one pool, USD) sku % | price % | my_price % | cost %',
      r.sku, COALESCE(r.price::text, '-'), COALESCE(r.my_price::text, '-'), COALESCE(r.cost::text, '-');
  END LOOP;
END
$p$;
