-- READ-ONLY PROBE. The two extension panels now read get_asin_fba_fee_basis
-- over PostgREST, so the JSON key names ARE the contract -- a rename here is a
-- silent blank on a buy screen. Print the real payload for each of the three
-- cases the panels branch on, and prove the no-history warning actually fires
-- (that branch has never run against live data).

DO $p$
DECLARE r record; v_asin text; n int := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email = 'sezflower01@gmail.com'), true);

  RAISE NOTICE '== case 1: billed, and the quote disagrees (B09N6FR8MT) ==';
  FOR r IN SELECT row_to_json(t) AS j FROM public.get_asin_fba_fee_basis('B09N6FR8MT', 'US') t LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;

  -- Find a bulky-for-its-weight ASIN the seller has NEVER sold, which is the
  -- sourcing case the warning exists for.
  SELECT d.asin INTO v_asin
  FROM public.asin_dimensions_cache d
  WHERE d.marketplace = 'US'
    AND d.package_length > 0 AND d.package_width > 0 AND d.package_height > 0 AND d.package_weight > 0
    AND lower(COALESCE(d.package_dim_unit, 'inches')) IN ('inches', 'in')
    AND lower(COALESCE(d.package_weight_unit, 'pounds')) IN ('pounds', 'lb', 'lbs')
    -- volume weight well above actual weight
    AND (d.package_length * d.package_width * d.package_height) / 139.0
        > GREATEST(d.package_weight, 1.0) * 1.5
    AND (d.package_length * d.package_width * d.package_height) / 139.0 > 1.0
    AND NOT EXISTS (
      SELECT 1 FROM public.sales_orders so
      WHERE so.asin = d.asin AND COALESCE(so.fba_fee, 0) > 0
        AND so.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
    )
  ORDER BY (d.package_length * d.package_width * d.package_height) DESC
  LIMIT 1;

  RAISE NOTICE '';
  RAISE NOTICE '== case 2: never sold, bulky for its weight (%) ==', COALESCE(v_asin, 'none found');
  IF v_asin IS NOT NULL THEN
    FOR r IN SELECT row_to_json(t) AS j FROM public.get_asin_fba_fee_basis(v_asin, 'US') t LOOP
      RAISE NOTICE '  %', r.j;
    END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== case 3: nothing known at all (ZZZZZZZZZZ) ==';
  FOR r IN SELECT row_to_json(t) AS j FROM public.get_asin_fba_fee_basis('ZZZZZZZZZZ', 'US') t LOOP
    RAISE NOTICE '  %', r.j;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN
    RAISE NOTICE '  (no row at all -- the panels must treat an empty array as "no basis", which they do)';
  END IF;

  -- How much of the catalogue would carry a warning? A warning on everything
  -- is a warning on nothing.
  RAISE NOTICE '';
  RAISE NOTICE '== how often would each verdict appear across ASINs with dimensions? ==';
  FOR r IN
    SELECT b.basis, b.understated, count(*) AS n
    FROM (SELECT asin FROM public.asin_dimensions_cache WHERE marketplace = 'US' LIMIT 400) d
    CROSS JOIN LATERAL public.get_asin_fba_fee_basis(d.asin, 'US') b
    GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE '  basis=% understated=% -> % of 400 sampled',
      rpad(COALESCE(r.basis, 'null'), 8), r.understated, r.n;
  END LOOP;
END
$p$;
