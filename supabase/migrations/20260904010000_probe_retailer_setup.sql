-- Read-only: has any shop been configured yet?
DO $$
DECLARE v_shops bigint; v_links bigint; r RECORD;
BEGIN
  SELECT count(*) INTO v_shops FROM public.user_retailers;
  SELECT count(*) INTO v_links FROM public.user_brand_sources;
  RAISE NOTICE 'shops configured=% | brand-to-shop links=%', v_shops, v_links;

  FOR r IN SELECT label, url_template FROM public.user_retailers ORDER BY label LOOP
    RAISE NOTICE '  shop: % -> %', r.label, r.url_template;
  END LOOP;

  -- The brands on the listings in front of the user right now.
  FOR r IN
    SELECT u.brand, u.asin_count,
           (SELECT count(*) FROM public.user_brand_sources s
             WHERE s.user_id = u.user_id AND s.brand = u.brand) AS shops
    FROM public.user_brands u
    WHERE lower(u.brand) IN ('disney','jockey','disney store')
    ORDER BY u.brand
  LOOP
    RAISE NOTICE '  brand % (% asins) has % shop(s) attached', r.brand, r.asin_count, r.shops;
  END LOOP;
END $$;
