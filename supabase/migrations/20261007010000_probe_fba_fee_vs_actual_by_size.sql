-- READ-ONLY PROBE. "The extensions treat a large item like a standard one, so
-- the ROI says profit and the sale makes a loss."
--
-- Nothing in this repo computes an FBA fee from size: every surface --
-- fetch-listing-snapshot, calculate-roi, asin_fee_cache, both extension panels
-- -- takes whatever Amazon's Product Fees API returns for the ASIN. So if the
-- number is wrong for oversize items, it is wrong BEFORE it reaches us, and
-- the fix is on our side only if we can show the gap and predict it.
--
-- There is one unimpeachable source for what Amazon actually charges:
-- sales_orders.fba_fee on settled orders. Compare that against the estimate
-- the app would have shown, per ASIN, and see whether the gap tracks size.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== does a dimensions cache exist, and what is in it? ==';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'asin_dimensions_cache'
           ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % | %', rpad(r.column_name, 30), r.data_type;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no asin_dimensions_cache table)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== fee cache coverage ==';
  FOR r IN SELECT marketplace, count(*) AS rows,
                  count(*) FILTER (WHERE fba_fee_fixed > 0) AS with_fba,
                  round(min(fba_fee_fixed)::numeric, 2) AS min_fba,
                  round(avg(fba_fee_fixed)::numeric, 2) AS avg_fba,
                  round(max(fba_fee_fixed)::numeric, 2) AS max_fba
           FROM public.asin_fee_cache WHERE user_id = v_uid
           GROUP BY marketplace ORDER BY marketplace LOOP
    RAISE NOTICE '  % | % rows | % with an fba fee | min $% avg $% max $%',
      r.marketplace, r.rows, r.with_fba, r.min_fba, r.avg_fba, r.max_fba;
  END LOOP;

  -- The heart of it: estimate vs what Amazon billed, per ASIN, FBA only.
  RAISE NOTICE '';
  RAISE NOTICE '== the 25 worst UNDER-estimates (cache says cheap, Amazon billed more) ==';
  RAISE NOTICE '   asin | orders | units | est/unit | actual/unit | gap/unit | gap pct';
  FOR r IN
    WITH actual AS (
      SELECT so.asin,
             count(*) AS orders,
             sum(so.quantity) AS units,
             sum(so.fba_fee) / NULLIF(sum(so.quantity), 0) AS actual_per_unit
      FROM public.sales_orders so
      WHERE so.user_id = v_uid
        AND COALESCE(so.is_cancelled, false) = false
        AND so.order_id NOT LIKE '%-REFUND'
        AND COALESCE(so.fba_fee, 0) > 0
        AND upper(COALESCE(so.fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY so.asin
      HAVING sum(so.quantity) >= 2
    )
    SELECT a.asin, a.orders, a.units,
           round(fc.fba_fee_fixed::numeric, 2) AS est,
           round(a.actual_per_unit::numeric, 2) AS act,
           round((a.actual_per_unit - fc.fba_fee_fixed)::numeric, 2) AS gap,
           round((100 * (a.actual_per_unit - fc.fba_fee_fixed) / NULLIF(fc.fba_fee_fixed, 0))::numeric, 0) AS gap_pct
    FROM actual a
    JOIN public.asin_fee_cache fc
      ON fc.user_id = v_uid AND fc.asin = a.asin AND fc.marketplace = 'US'
    WHERE fc.fba_fee_fixed > 0
      AND a.actual_per_unit > fc.fba_fee_fixed + 0.25
    ORDER BY (a.actual_per_unit - fc.fba_fee_fixed) DESC
    LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | % | $% | $% | +$% | +% pct',
      r.asin, lpad(r.orders::text, 4), lpad(r.units::text, 5),
      lpad(r.est::text, 6), lpad(r.act::text, 6), lpad(r.gap::text, 6), lpad(r.gap_pct::text, 4);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none -- the cache is not under-estimating anywhere)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how big is the problem overall? ==';
  FOR r IN
    WITH actual AS (
      SELECT so.asin, sum(so.quantity) AS units,
             sum(so.fba_fee) / NULLIF(sum(so.quantity), 0) AS actual_per_unit
      FROM public.sales_orders so
      WHERE so.user_id = v_uid
        AND COALESCE(so.is_cancelled, false) = false
        AND so.order_id NOT LIKE '%-REFUND'
        AND COALESCE(so.fba_fee, 0) > 0
        AND upper(COALESCE(so.fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY so.asin
    ), j AS (
      SELECT a.asin, a.units, a.actual_per_unit, fc.fba_fee_fixed AS est
      FROM actual a
      JOIN public.asin_fee_cache fc
        ON fc.user_id = v_uid AND fc.asin = a.asin AND fc.marketplace = 'US'
      WHERE fc.fba_fee_fixed > 0
    )
    SELECT count(*) AS asins,
           count(*) FILTER (WHERE actual_per_unit > est + 0.25) AS under,
           count(*) FILTER (WHERE actual_per_unit < est - 0.25) AS over,
           round(avg(actual_per_unit - est)::numeric, 2) AS avg_gap,
           round(sum((actual_per_unit - est) * units)::numeric, 2) AS total_gap_dollars
    FROM j
  LOOP
    RAISE NOTICE '  % ASINs compared | % under-estimated | % over-estimated | avg gap $% | total unbudgeted $%',
      r.asins, r.under, r.over, r.avg_gap, r.total_gap_dollars;
  END LOOP;

  -- Does the gap track the SIZE of the fee itself? A big fulfilment fee means
  -- a big item, so if the misses cluster at the top end that is the signal.
  RAISE NOTICE '';
  RAISE NOTICE '== gap by actual-fee band (a proxy for size tier) ==';
  FOR r IN
    WITH actual AS (
      SELECT so.asin, sum(so.quantity) AS units,
             sum(so.fba_fee) / NULLIF(sum(so.quantity), 0) AS actual_per_unit
      FROM public.sales_orders so
      WHERE so.user_id = v_uid
        AND COALESCE(so.is_cancelled, false) = false
        AND so.order_id NOT LIKE '%-REFUND'
        AND COALESCE(so.fba_fee, 0) > 0
        AND upper(COALESCE(so.fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY so.asin
    ), j AS (
      SELECT a.asin, a.units, a.actual_per_unit, fc.fba_fee_fixed AS est,
             CASE
               WHEN a.actual_per_unit < 4   THEN '1. under $4   (small std)'
               WHEN a.actual_per_unit < 6   THEN '2. $4-5.99    (large std)'
               WHEN a.actual_per_unit < 9   THEN '3. $6-8.99    (big large std)'
               WHEN a.actual_per_unit < 15  THEN '4. $9-14.99   (small oversize)'
               ELSE                              '5. $15+       (oversize)'
             END AS band
      FROM actual a
      JOIN public.asin_fee_cache fc
        ON fc.user_id = v_uid AND fc.asin = a.asin AND fc.marketplace = 'US'
      WHERE fc.fba_fee_fixed > 0
    )
    SELECT band, count(*) AS asins, sum(units) AS units,
           round(avg(est)::numeric, 2) AS avg_est,
           round(avg(actual_per_unit)::numeric, 2) AS avg_act,
           round(avg(actual_per_unit - est)::numeric, 2) AS avg_gap,
           count(*) FILTER (WHERE actual_per_unit > est + 0.25) AS n_under
    FROM j GROUP BY band ORDER BY band
  LOOP
    RAISE NOTICE '  % | % ASINs | % units | est $% vs actual $% | gap $% | % under',
      rpad(r.band, 28), lpad(r.asins::text, 4), lpad(r.units::text, 6),
      lpad(r.avg_est::text, 6), lpad(r.avg_act::text, 6), lpad(r.avg_gap::text, 6), r.n_under;
  END LOOP;
END
$p$;
