-- READ-ONLY PROBE. The analyser already KNOWS the size tier -- classifySizeTier()
-- in extension/panel.js computes it from Keepa package dimensions and prints it
-- in the diagnostics grid as "Size Tier". The ROI line beside it ignores it
-- completely and uses whatever fulfilment fee Amazon's Product Fees API
-- returned, which for an ASIN the seller has never sent to FBA is frequently a
-- standard-size figure.
--
-- 20261007010000 showed the damage: the estimate tracks reality under $6 and
-- falls apart above it -- gap -$0.08 / +$0.07 / +$0.54 / +$2.20 across rising
-- fee bands, 102 of 656 ASINs under-estimated, $2,382.83 of fulfilment cost
-- never budgeted for.
--
-- The question this probe answers: can the tier the panel already computes
-- PREDICT the fee Amazon actually bills? If yes, the fix is to cross-check the
-- API's number against the tier and refuse the implausible one -- using the
-- seller's own settled invoices as the table, not a hardcoded fee schedule that
-- goes stale every January.
--
-- The tier thresholds below mirror classifySizeTier() exactly. If they drift,
-- the panel and this evidence stop describing the same thing.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== dimension coverage ==';
  FOR r IN SELECT count(*) AS rows,
                  count(*) FILTER (WHERE package_length > 0 AND package_width > 0
                                     AND package_height > 0 AND package_weight > 0) AS complete,
                  count(DISTINCT source) AS sources
           FROM public.asin_dimensions_cache LOOP
    RAISE NOTICE '  % cached ASINs | % with a complete package L/W/H + weight | % distinct sources',
      r.rows, r.complete, r.sources;
  END LOOP;

  FOR r IN SELECT source, count(*) AS n FROM public.asin_dimensions_cache
           GROUP BY source ORDER BY n DESC LOOP
    RAISE NOTICE '    source % -> %', rpad(COALESCE(r.source, '(null)'), 20), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== actual fulfilment fee by COMPUTED size tier (US, settled FBA orders) ==';
  RAISE NOTICE '   tier | asins | units | api est | amazon billed | gap | n under';
  FOR r IN
    WITH dims AS (
      SELECT asin,
             -- classifySizeTier() converts to inches and pounds first.
             CASE lower(COALESCE(package_dim_unit, 'inches'))
               WHEN 'millimeters' THEN 1/25.4 WHEN 'mm' THEN 1/25.4
               WHEN 'centimeters' THEN 1/2.54  WHEN 'cm' THEN 1/2.54
               ELSE 1 END AS dscale,
             CASE lower(COALESCE(package_weight_unit, 'pounds'))
               WHEN 'grams' THEN 1/453.592 WHEN 'g' THEN 1/453.592
               WHEN 'kilograms' THEN 2.20462
               WHEN 'ounces' THEN 1/16.0 WHEN 'oz' THEN 1/16.0
               ELSE 1 END AS wscale,
             package_length AS l, package_width AS w, package_height AS h, package_weight AS wt
      FROM public.asin_dimensions_cache
      WHERE marketplace = 'US'
        AND package_length > 0 AND package_width > 0 AND package_height > 0 AND package_weight > 0
    ), sized AS (
      SELECT asin,
             GREATEST(l,w,h) * dscale AS longest,
             (l + w + h - GREATEST(l,w,h) - LEAST(l,w,h)) * dscale AS median,
             LEAST(l,w,h) * dscale AS shortest,
             wt * wscale AS lbs
      FROM dims
    ), tiered AS (
      SELECT asin, lbs,
             CASE
               WHEN longest <= 15 AND median <= 12 AND shortest <= 0.75 AND lbs <= 1  THEN '1 Small Standard'
               WHEN longest <= 18 AND median <= 14 AND shortest <= 8    AND lbs <= 20 THEN '2 Large Standard'
               WHEN longest <= 60 AND longest + 2*(median + shortest) <= 130 AND lbs <= 50 THEN '3 Large Oversize'
               WHEN longest <= 108 AND longest + 2*(median + shortest) <= 165 THEN '4 Oversize'
               ELSE '5 Heavy/Bulky'
             END AS tier
      FROM sized
    ), actual AS (
      SELECT so.asin, sum(so.quantity) AS units,
             sum(so.fba_fee) / NULLIF(sum(so.quantity), 0) AS act
      FROM public.sales_orders so
      WHERE so.user_id = v_uid
        AND COALESCE(so.is_cancelled, false) = false
        AND so.order_id NOT LIKE '%-REFUND'
        AND COALESCE(so.fba_fee, 0) > 0
        AND upper(COALESCE(so.fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY so.asin
    )
    SELECT t.tier, count(*) AS asins, sum(a.units) AS units,
           round(avg(fc.fba_fee_fixed)::numeric, 2) AS est,
           round(avg(a.act)::numeric, 2) AS act,
           round(avg(a.act - fc.fba_fee_fixed)::numeric, 2) AS gap,
           count(*) FILTER (WHERE a.act > fc.fba_fee_fixed + 0.25) AS n_under,
           round(min(a.act)::numeric, 2) AS act_min,
           round(max(a.act)::numeric, 2) AS act_max
    FROM tiered t
    JOIN actual a ON a.asin = t.asin
    JOIN public.asin_fee_cache fc ON fc.user_id = v_uid AND fc.asin = t.asin AND fc.marketplace = 'US'
    WHERE fc.fba_fee_fixed > 0
    GROUP BY t.tier ORDER BY t.tier
  LOOP
    RAISE NOTICE '   % | % | % | $% | $% | $% | % | billed range $% - $%',
      rpad(r.tier, 17), lpad(r.asins::text, 4), lpad(r.units::text, 6),
      lpad(r.est::text, 6), lpad(r.act::text, 6), lpad(r.gap::text, 6),
      lpad(r.n_under::text, 3), r.act_min, r.act_max;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no ASIN has dimensions, a fee-cache row AND settled FBA orders)'; END IF;

  -- The specific accusation: a LARGE item quoted at a SMALL-standard fee.
  RAISE NOTICE '';
  RAISE NOTICE '== Large Standard ASINs quoted under $4 (a small-standard fee) ==';
  FOR r IN
    WITH dims AS (
      SELECT asin,
             CASE lower(COALESCE(package_dim_unit, 'inches'))
               WHEN 'millimeters' THEN 1/25.4 WHEN 'mm' THEN 1/25.4
               WHEN 'centimeters' THEN 1/2.54  WHEN 'cm' THEN 1/2.54 ELSE 1 END AS dscale,
             CASE lower(COALESCE(package_weight_unit, 'pounds'))
               WHEN 'grams' THEN 1/453.592 WHEN 'g' THEN 1/453.592
               WHEN 'kilograms' THEN 2.20462
               WHEN 'ounces' THEN 1/16.0 WHEN 'oz' THEN 1/16.0 ELSE 1 END AS wscale,
             package_length AS l, package_width AS w, package_height AS h, package_weight AS wt
      FROM public.asin_dimensions_cache
      WHERE marketplace = 'US'
        AND package_length > 0 AND package_width > 0 AND package_height > 0 AND package_weight > 0
    ), sized AS (
      SELECT asin, GREATEST(l,w,h)*dscale AS longest,
             (l+w+h-GREATEST(l,w,h)-LEAST(l,w,h))*dscale AS median,
             LEAST(l,w,h)*dscale AS shortest, wt*wscale AS lbs FROM dims
    ), actual AS (
      SELECT so.asin, sum(so.quantity) AS units,
             sum(so.fba_fee)/NULLIF(sum(so.quantity),0) AS act
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND' AND COALESCE(so.fba_fee,0) > 0
        AND upper(COALESCE(so.fulfillment_channel,'')) LIKE 'AFN%'
      GROUP BY so.asin
    )
    SELECT s.asin, round(s.longest::numeric,1) AS lg, round(s.median::numeric,1) AS md,
           round(s.shortest::numeric,1) AS sh, round(s.lbs::numeric,2) AS lbs,
           round(fc.fba_fee_fixed::numeric,2) AS est, round(a.act::numeric,2) AS act, a.units
    FROM sized s
    JOIN actual a ON a.asin = s.asin
    JOIN public.asin_fee_cache fc ON fc.user_id = v_uid AND fc.asin = s.asin AND fc.marketplace = 'US'
    WHERE fc.fba_fee_fixed BETWEEN 0.01 AND 3.99
      AND NOT (s.longest <= 15 AND s.median <= 12 AND s.shortest <= 0.75 AND s.lbs <= 1)
      AND a.act > fc.fba_fee_fixed + 0.25
    ORDER BY (a.act - fc.fba_fee_fixed) DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % | % x % x % in, % lb | quoted $% | billed $% | % units',
      r.asin, lpad(r.lg::text,5), lpad(r.md::text,5), lpad(r.sh::text,5), lpad(r.lbs::text,6),
      lpad(r.est::text,5), lpad(r.act::text,5), r.units;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;
END
$p$;
