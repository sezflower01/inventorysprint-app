-- PROBE (read-only): Seller Central reports 189 ACTIVE ASINs for the US market.
-- The app reports 279 ACTIVE inventory rows across everything and 162 ACTIVE
-- with available stock. Neither is 189, so find out what the local table
-- actually holds before guessing at the gap.
--
-- Things that could each explain part of it, and are worth separating:
--   - rows vs SKUs vs ASINs (one ASIN can carry several SKUs)
--   - the inventory table may not be per-marketplace at all
--   - Seller Central "Active" includes FBM listings with no FBA stock
--   - stale rows the sync has not retired
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_cols text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inventory';
  RAISE NOTICE 'inventory columns: %', left(v_cols, 900);

  RAISE NOTICE '';
  RAISE NOTICE '======== every listing_status value, with counts ========';
  FOR r IN
    SELECT COALESCE(listing_status,'(null)') AS st,
           count(*) AS rows_n,
           count(DISTINCT sku) AS skus,
           count(DISTINCT asin) AS asins,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock
    FROM public.inventory WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows_n DESC LIMIT 15
  LOOP
    RAISE NOTICE '   %  rows=% skus=% asins=% with_stock=%',
      rpad(left(r.st,20),20), r.rows_n, r.skus, r.asins, r.with_stock;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== ACTIVE only: rows vs SKUs vs ASINs ========';
  FOR r IN
    SELECT count(*) AS rows_n,
           count(DISTINCT sku) AS skus,
           count(DISTINCT asin) AS asins,
           count(DISTINCT asin) FILTER (WHERE COALESCE(available,0) > 0) AS asins_with_stock,
           count(DISTINCT asin) FILTER (WHERE COALESCE(available,0) = 0) AS asins_no_stock
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
  LOOP
    RAISE NOTICE '   % rows | % distinct SKUs | % distinct ASINs', r.rows_n, r.skus, r.asins;
    RAISE NOTICE '   % ASINs with available stock | % with none',
      r.asins_with_stock, r.asins_no_stock;
    RAISE NOTICE '   (Seller Central US says 189 active)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== FBA vs FBM split among ACTIVE ========';
  FOR r IN
    SELECT COALESCE(source,'(null)') AS ch,
           count(*) AS rows_n, count(DISTINCT asin) AS asins,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    GROUP BY 1 ORDER BY rows_n DESC LIMIT 10
  LOOP
    RAISE NOTICE '   %  rows=% asins=% with_stock=%',
      rpad(left(r.ch,18),18), r.rows_n, r.asins, r.with_stock;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how fresh is the ACTIVE set? ========';
  FOR r IN
    SELECT date_trunc('day', updated_at)::date AS d, count(*) AS n
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    GROUP BY 1 ORDER BY 1 DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % : % rows', r.d, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 156 + 8 = 164 against a ceiling of 162 -- why? ========';
  -- The seller spotted this and it is a fair challenge. Two candidate causes:
  --   (a) 162 counts ROWS, the badges count distinct ASINs -- different units
  --   (b) an ASIN on rule A in one marketplace and rule B in another is counted
  --       once inside each badge, so badges overlap and must not be summed
  FOR r IN
    SELECT count(*) AS rows_active_stock,
           count(DISTINCT asin) AS asins_active_stock
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
      AND COALESCE(available,0) > 0
  LOOP
    RAISE NOTICE '   ceiling as ROWS: %  | ceiling as distinct ASINs: %',
      r.rows_active_stock, r.asins_active_stock;
  END LOOP;

  FOR r IN
    WITH badge AS (
      SELECT DISTINCT rr.name AS rule_name, a.asin
      FROM public.repricer_assignments a
      JOIN public.repricer_rules rr ON rr.id = a.rule_id
      JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
      WHERE a.user_id = v_uid AND a.is_enabled
        AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
        AND COALESCE(i.available,0) > 0
    )
    SELECT count(*) AS sum_of_badges,
           count(DISTINCT asin) AS distinct_asins_overall
    FROM badge
  LOOP
    RAISE NOTICE '   badges summed: %  | distinct ASINs across all rules: %',
      r.sum_of_badges, r.distinct_asins_overall;
    RAISE NOTICE '   -> % ASINs are counted by more than one rule',
      r.sum_of_badges - r.distinct_asins_overall;
  END LOOP;

  FOR r IN
    WITH badge AS (
      SELECT rr.name AS rule_name, a.asin
      FROM public.repricer_assignments a
      JOIN public.repricer_rules rr ON rr.id = a.rule_id
      JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
      WHERE a.user_id = v_uid AND a.is_enabled
        AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
        AND COALESCE(i.available,0) > 0
      GROUP BY 1,2
    )
    SELECT asin, string_agg(DISTINCT rule_name, ' + ') AS rules
    FROM badge GROUP BY asin HAVING count(DISTINCT rule_name) > 1 LIMIT 10
  LOOP
    RAISE NOTICE '   shared: % -> %', r.asin, r.rules;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== ACTIVE + reserved/inbound but zero available ========';
  FOR r IN
    SELECT count(DISTINCT asin) AS asins
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
      AND COALESCE(available,0) = 0
      AND COALESCE(reserved,0) + COALESCE(inbound,0) > 0
  LOOP
    RAISE NOTICE '   % ASINs are ACTIVE, 0 available, but hold reserved or inbound units',
      r.asins;
    RAISE NOTICE '   (Seller Central still lists these as active -- we hide them from the grid)';
  END LOOP;
END
$probe$;
